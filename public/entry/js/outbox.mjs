// Requests the tablet could not deliver, kept in order until the server is
// reachable again. Every entry carries a clientRef, so a request that reached
// the server but whose answer was lost is not logged twice when replayed.

const STORAGE_KEY = 'chiplog.outbox';

// Worth trying again later: no connection, the server or plugin down, or an
// access that can be granted meanwhile. Anything else is a refusal that a
// retry would only repeat.
export function isTransient(error) {
  const status = error?.status ?? 0;
  return (
    status === 0 ||
    status === 401 ||
    status === 403 ||
    status === 408 ||
    status === 429 ||
    status >= 500
  );
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value))
  };
}

export function createOutbox({ storage, send, onChange = () => {} }) {
  storage ??= memoryStorage();
  let state = { pending: [], failed: [] };
  try {
    const stored = JSON.parse(storage.getItem(STORAGE_KEY) ?? 'null');
    if (stored && Array.isArray(stored.pending) && Array.isArray(stored.failed)) {
      state = stored;
    }
  } catch {
    // Unreadable storage starts empty.
  }
  let flushing = null;

  function save() {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Storage full or unavailable: the queue still lives in memory.
    }
    onChange(snapshot());
  }

  function snapshot() {
    return { pending: [...state.pending], failed: [...state.failed] };
  }

  async function run() {
    const sent = [];
    while (state.pending.length > 0) {
      const item = state.pending[0];
      try {
        const result = await send(item);
        state.pending = state.pending.filter((other) => other.ref !== item.ref);
        sent.push({ item, result });
        save();
      } catch (error) {
        if (isTransient(error)) {
          return { sent, blocked: error };
        }
        state.pending = state.pending.filter((other) => other.ref !== item.ref);
        state.failed.push({
          ...item,
          error: { status: error.status ?? 0, code: error.code ?? null, message: error.message }
        });
        save();
      }
    }
    return { sent, blocked: null };
  }

  return {
    snapshot,

    get size() {
      return state.pending.length;
    },

    // item: { ref, method, path, body, createdAt }
    add(item) {
      state.pending.push(item);
      save();
    },

    // Changes an entry not sent yet, such as a comment added before the
    // connection came back.
    update(ref, change) {
      const item = state.pending.find((other) => other.ref === ref);
      if (!item) {
        return false;
      }
      item.body = { ...item.body, ...change };
      save();
      return true;
    },

    remove(ref) {
      const before = state.pending.length + state.failed.length;
      state.pending = state.pending.filter((item) => item.ref !== ref);
      state.failed = state.failed.filter((item) => item.ref !== ref);
      const removed = state.pending.length + state.failed.length < before;
      if (removed) {
        save();
      }
      return removed;
    },

    // One replay at a time; a second call waits for the one under way.
    flush() {
      flushing ??= run().finally(() => {
        flushing = null;
      });
      return flushing;
    }
  };
}

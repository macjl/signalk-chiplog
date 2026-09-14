// What the tablet does with an entry: send it at once when the server answers,
// otherwise keep it in the outbox with the time it was made. Undo and comments
// follow the entry wherever it is — still queued, or already logged.

import { createOutbox, isTransient } from './outbox.mjs';

export const SEND_TIMEOUT_MS = 8000;

export function createJournal({ request, storage, clock, newRef, onChange = () => {} }) {
  // Logged events by clientRef, for undo and comments after delivery.
  const delivered = new Map();
  // Entries undone while their replay may already be on its way.
  const cancelled = new Set();

  const send = async (item) => {
    try {
      return await request(item.method, item.path, item.body, { timeoutMs: SEND_TIMEOUT_MS });
    } catch (error) {
      // Deleting something already gone is what was wanted.
      if (item.method === 'DELETE' && error.status === 404) {
        return null;
      }
      throw error;
    }
  };

  const outbox = createOutbox({ storage, send, onChange });

  function queue(method, path, body) {
    outbox.add({ ref: newRef(), method, path, body, createdAt: clock.now() });
  }

  // Tries now; on a transient failure queues it and reports the error.
  async function sendOrQueue(method, path, body) {
    if (outbox.size === 0) {
      try {
        await send({ method, path, body });
        return null;
      } catch (error) {
        if (!isTransient(error)) {
          throw error;
        }
        queue(method, path, body);
        return error;
      }
    }
    queue(method, path, body);
    return null;
  }

  async function flush() {
    const outcome = await outbox.flush();
    for (const { item, result } of outcome.sent) {
      if (item.method !== 'POST' || !result) {
        continue;
      }
      delivered.set(item.body.clientRef, result);
      if (cancelled.delete(item.body.clientRef)) {
        queue('DELETE', `/events/${result.id}`);
      }
    }
    if (outcome.sent.length > 0 && outbox.size > 0 && !outcome.blocked) {
      return flush();
    }
    return outcome;
  }

  return {
    outbox,
    flush,

    // Resolves to { status: 'sent', event } | { status: 'queued', error } and
    // rejects with the server's refusal (a 400 or 409).
    async log(body) {
      const ref = newRef();
      const madeAt = new Date(clock.now()).toISOString();
      const entry = { ...body, clientRef: ref };
      const enqueue = () =>
        outbox.add({
          ref,
          method: 'POST',
          path: '/events',
          body: { ...entry, time: madeAt },
          createdAt: Date.parse(madeAt)
        });

      // Behind queued entries it waits its turn, so the log keeps its order.
      if (outbox.size > 0) {
        enqueue();
        return { status: 'queued', ref, error: null };
      }
      try {
        const event = await send({ method: 'POST', path: '/events', body: entry });
        delivered.set(ref, event);
        return { status: 'sent', ref, event };
      } catch (error) {
        if (!isTransient(error)) {
          throw error;
        }
        enqueue();
        return { status: 'queued', ref, error };
      }
    },

    eventFor(ref) {
      return delivered.get(ref) ?? null;
    },

    isQueued(ref) {
      return outbox.snapshot().pending.some((item) => item.ref === ref);
    },

    async undo(ref) {
      if (outbox.remove(ref)) {
        // Removed from the queue, but a replay may have picked it up already.
        cancelled.add(ref);
        return null;
      }
      const event = delivered.get(ref);
      if (!event) {
        return null;
      }
      delivered.delete(ref);
      return sendOrQueue('DELETE', `/events/${event.id}`);
    },

    async comment(ref, comment) {
      if (outbox.update(ref, { comment })) {
        return null;
      }
      const event = delivered.get(ref);
      if (!event) {
        return null;
      }
      delivered.set(ref, { ...event, comment });
      return sendOrQueue('PATCH', `/events/${event.id}`, { comment });
    }
  };
}

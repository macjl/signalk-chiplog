// Signal K's device access requests: the tablet asks once, an administrator
// approves it in the Signal K admin (Security → Access Requests), and the
// server hands back a token the tablet keeps. See the server's
// /signalk/v1/access/requests.

import { randomId } from '../../js/ids.mjs';

const REQUEST_KEY = 'chiplog.accessRequest';
const CLIENT_ID_KEY = 'chiplog.clientId';

function read(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function write(storage, key, value) {
  try {
    if (value === null) {
      storage?.removeItem(key);
    } else {
      storage?.setItem(key, value);
    }
  } catch {
    // Kept for this page only.
  }
}

// States: idle, pending, approved, denied, expired, disabled (the server does
// not accept device requests), unavailable (security is off), error.
export function createAccessRequester({ fetch, storage, tokenStore, description }) {
  // One identity per tablet, so asking again replaces its entry in the server's
  // device list instead of adding another.
  function clientId() {
    let id = read(storage, CLIENT_ID_KEY);
    if (!id) {
      id = randomId();
      write(storage, CLIENT_ID_KEY, id);
    }
    return id;
  }

  async function readJson(response) {
    return response.json().catch(() => null);
  }

  return {
    hasPendingRequest() {
      return read(storage, REQUEST_KEY) !== null;
    },

    async request() {
      let response;
      try {
        response = await fetch('/signalk/v1/access/requests', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ clientId: clientId(), description, permissions: 'readwrite' })
        });
      } catch {
        return { state: 'error' };
      }
      if (response.status === 404) {
        return { state: 'unavailable' };
      }
      const reply = await readJson(response);
      if (response.status === 403 || reply?.statusCode === 403) {
        return { state: 'disabled' };
      }
      if (reply?.href && (reply.state === 'PENDING' || response.status === 202)) {
        write(storage, REQUEST_KEY, reply.href);
        return { state: 'pending' };
      }
      // A request from this tablet already waits: keep polling the one we know.
      if (response.status === 400 && this.hasPendingRequest()) {
        return { state: 'pending' };
      }
      return { state: 'error', message: reply?.message };
    },

    async poll() {
      const href = read(storage, REQUEST_KEY);
      if (!href) {
        return { state: 'idle' };
      }
      let response;
      try {
        response = await fetch(href);
      } catch {
        return { state: 'pending' };
      }
      const reply = response.ok ? await readJson(response) : null;
      if (!reply) {
        // The server forgets requests after an hour and on restart.
        write(storage, REQUEST_KEY, null);
        return { state: 'expired' };
      }
      if (reply.state !== 'COMPLETED') {
        return { state: 'pending' };
      }
      write(storage, REQUEST_KEY, null);
      const { permission, token } = reply.accessRequest ?? {};
      if (permission === 'APPROVED' && token) {
        tokenStore.set(token);
        return { state: 'approved' };
      }
      return { state: permission === 'DENIED' ? 'denied' : 'error' };
    },

    cancel() {
      write(storage, REQUEST_KEY, null);
    }
  };
}

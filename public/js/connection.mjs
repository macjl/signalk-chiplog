// The state of the link to the Signal K server, shared by everything on the
// page so that every message about a lost connection agrees, and one reconnect
// serves them all.
//
// States: connected; offline (the server does not answer: the network dropped,
// or it is restarting); signedOut (it answers but no longer knows us: the login
// expired, or the device token was revoked). `checking` is true while a probe
// runs, and `restored` counts the returns to connected, so a message shown
// before one can tell that the link has come back since.

// Which kind of connection loss an API error stands for, or null when it is
// about the request itself.
export function connectionProblem(error) {
  if (!error) {
    return null;
  }
  if (error.code === 'network') {
    return 'offline';
  }
  // A proxy in front of a server that is down answers for it.
  if ((error.status === 502 || error.status === 504) && error.code === 'http_error') {
    return 'offline';
  }
  // Signal K answers 401 to a missing or expired login and to an account that
  // lacks the rights alike: only a probe tells them apart.
  return error.status === 401 ? 'signedOut' : null;
}

// `probe` makes a read every client with access may make, and rejects with the
// API's error.
export function createConnection({ probe }) {
  let state = 'connected';
  let checking = null;
  let restored = 0;
  const listeners = new Set();

  const snapshot = () => ({ state, checking: checking !== null, restored });
  const notify = () => {
    const current = snapshot();
    listeners.forEach((listener) => listener(current));
  };

  function settle(next) {
    if (next === 'connected' && state !== 'connected') {
      restored += 1;
    }
    state = next;
  }

  function check() {
    if (checking) {
      return checking;
    }
    checking = (async () => {
      try {
        await probe();
        settle('connected');
      } catch (error) {
        // An answer that is not about the link (the plugin stopped, say)
        // still means the server is there and lets us in.
        settle(connectionProblem(error) ?? 'connected');
      }
      checking = null;
      notify();
      return state;
    })();
    notify();
    return checking;
  }

  return {
    snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    // Every response the server sends: a successful one proves the link.
    observe(status) {
      if (status >= 200 && status < 300 && state !== 'connected') {
        settle('connected');
        notify();
      }
    },

    // Every failed request. Returns the problem it stands for, if any; a 401 is
    // checked before being taken for a lost login.
    report(error) {
      const problem = connectionProblem(error);
      if (problem === 'offline' && state !== 'offline') {
        state = 'offline';
        notify();
      } else if (problem === 'signedOut' && state !== 'signedOut') {
        check();
      } else if (problem === null && state !== 'connected') {
        // Refused for a reason of its own (the plugin is still starting, say):
        // the server answered, and past its login.
        settle('connected');
        notify();
      }
      return problem;
    },

    check
  };
}

// Looks again as soon as there is reason to think the link is back: the
// network returned, or the reader came back to the page — from signing in
// on another tab, typically.
export function watchConnection(connection, { window, document }) {
  const recheck = () => {
    if (connection.snapshot().state !== 'connected' && document.visibilityState !== 'hidden') {
      connection.check();
    }
  };
  window.addEventListener('online', recheck);
  window.addEventListener('focus', recheck);
  document.addEventListener('visibilitychange', recheck);
  return () => {
    window.removeEventListener('online', recheck);
    window.removeEventListener('focus', recheck);
    document.removeEventListener('visibilitychange', recheck);
  };
}

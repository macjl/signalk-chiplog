// The token Signal K issues to this device once an administrator approves its
// access request. Kept in localStorage, which may be missing or refuse writes
// (private browsing): the app then simply asks again.

const TOKEN_KEY = 'chiplog.deviceToken';

function browserStorage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function createTokenStore(storage = browserStorage()) {
  return {
    get() {
      try {
        return storage?.getItem(TOKEN_KEY) ?? null;
      } catch {
        return null;
      }
    },
    set(token) {
      try {
        storage?.setItem(TOKEN_KEY, token);
      } catch {
        // Not persisted: the token lasts as long as this page.
      }
    },
    clear() {
      try {
        storage?.removeItem(TOKEN_KEY);
      } catch {
        // Nothing stored to clear.
      }
    }
  };
}

export const deviceToken = createTokenStore();

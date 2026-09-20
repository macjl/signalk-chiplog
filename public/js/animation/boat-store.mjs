// The crew's own boat model — a .glb they load into the 3D view — kept in this
// browser's IndexedDB so it is still there next time, with no server involved.
//
// It is per reader and per browser, like the tablet's outbox: the model is a
// preference of whoever is making the film, not something the logbook records.
// Every call is wrapped, because IndexedDB can be missing or refused (private
// windows, blocked site data): the view then simply keeps its own boat. No
// vendor imports; the database factory is injectable for tests.

const DATABASE = 'chiplog-animation';
const STORE = 'boat';
const KEY = 'model';

// A model is read whole into memory and then into the GPU; past this it is
// more likely a mistake than a boat.
export const MAX_MODEL_BYTES = 30 * 1024 * 1024;

function open(factory) {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function run(factory, mode, action) {
  return open(factory).then(
    (database) =>
      new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE, mode);
        const request = action(transaction.objectStore(STORE));
        transaction.oncomplete = () => {
          database.close();
          resolve(request.result);
        };
        transaction.onerror = () => {
          database.close();
          reject(transaction.error);
        };
        transaction.onabort = transaction.onerror;
      })
  );
}

export async function saveBoat({ name, buffer }, factory = globalThis.indexedDB) {
  try {
    await run(factory, 'readwrite', (store) => store.put({ name, buffer }, KEY));
    return true;
  } catch {
    return false;
  }
}

export async function loadBoat(factory = globalThis.indexedDB) {
  try {
    const stored = await run(factory, 'readonly', (store) => store.get(KEY));
    return stored?.buffer ? stored : null;
  } catch {
    return null;
  }
}

export async function clearBoat(factory = globalThis.indexedDB) {
  try {
    await run(factory, 'readwrite', (store) => store.delete(KEY));
    return true;
  } catch {
    return false;
  }
}

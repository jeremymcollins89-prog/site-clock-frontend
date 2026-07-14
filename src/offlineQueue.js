// offlineQueue.js
//
// If an employee taps "Clock In" with no signal, this stores the action
// locally and replays it as soon as the connection comes back — so a
// crew working somewhere with bad reception doesn't lose a punch.
//
// Uses IndexedDB directly (no external library) since it needs to work
// inside both the page and, if you extend this later, a service worker.

const DB_NAME = "site-clock-offline";
const STORE_NAME = "pending-actions";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: "id", autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// action: { path, method, body, timestamp }
async function queueAction(action) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).add({ ...action, timestamp: Date.now() });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getQueuedActions() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readonly");
    const req = tx.objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function removeQueuedAction(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Call this on app load and whenever the browser fires "online". Replays
// queued actions in order, oldest first, and stops on the first failure
// so a later action can't apply out of order (e.g. clock-out before
// clock-in has actually synced).
async function flushQueue(apiFetch, { onFlushed } = {}) {
  const actions = (await getQueuedActions()).sort((a, b) => a.timestamp - b.timestamp);
  for (const action of actions) {
    try {
      await apiFetch(action.path, { method: action.method, body: action.body });
      await removeQueuedAction(action.id);
      onFlushed?.(action);
    } catch (err) {
      // Still offline, or the server rejected it — stop here and retry
      // the whole queue next time flushQueue runs.
      break;
    }
  }
}

export { queueAction, getQueuedActions, removeQueuedAction, flushQueue };

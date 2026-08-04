// @ts-check
/**
 * IndexedDB position store -- authoritative for the current session.
 *
 * Raw IndexedDB rather than a wrapper library: it is a browser API and the
 * surface we need is small (docs/DESIGN.md section 5.3).
 *
 * Positions are keyed on [deviceId, ts], which makes dedupe a property of the
 * schema rather than of application code. Mesh flooding delivers the same
 * packet by several paths, and out-of-order arrival is normal operation, not
 * an error -- a plain put() collapses both.
 */

/** @typedef {import('./meshtastic.js').Position} Position */

const DB_NAME = 'fetchfido';
const DB_VERSION = 1;

/** @type {IDBDatabase|null} */
let db = null;

/** @returns {Promise<IDBDatabase>} */
export function open() {
  if (db) return Promise.resolve(db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains('positions')) {
        const s = d.createObjectStore('positions', { keyPath: ['deviceId', 'ts'] });
        s.createIndex('deviceId', 'deviceId', { unique: false });
        s.createIndex('ts', 'ts', { unique: false });
      }
      if (!d.objectStoreNames.contains('devices')) {
        d.createObjectStore('devices', { keyPath: 'deviceId' });
      }
    };
    req.onsuccess = () => { db = req.result; resolve(db); };
    req.onerror = () => reject(req.error);
  });
}

/**
 * @template T
 * @param {IDBRequest<T>} req
 * @returns {Promise<T>}
 */
function wrap(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Store a position. Returns false when this exact (device, timestamp) was
 * already held -- the caller uses that to count duplicate mesh deliveries,
 * which is a useful signal about relay behaviour during a range test.
 * @param {Position} p
 * @returns {Promise<boolean>}
 */
export async function putPosition(p) {
  const d = await open();
  const tx = d.transaction('positions', 'readwrite');
  const store = tx.objectStore('positions');
  const existing = await wrap(store.get([p.deviceId, p.ts]));
  if (existing) return false;
  await wrap(store.put(p));
  return true;
}

/**
 * All positions for one device, oldest first.
 * @param {string} deviceId
 * @returns {Promise<Position[]>}
 */
export async function track(deviceId) {
  const d = await open();
  const store = d.transaction('positions', 'readonly').objectStore('positions');
  const range = IDBKeyRange.bound([deviceId, -Infinity], [deviceId, Infinity]);
  /** @type {Position[]} */
  const out = await wrap(store.getAll(range));
  return out.sort((a, b) => a.ts - b.ts);
}

/** @returns {Promise<string[]>} */
export async function devices() {
  const d = await open();
  const store = d.transaction('positions', 'readonly').objectStore('positions');
  /** @type {Set<string>} */
  const ids = new Set();
  return new Promise((resolve, reject) => {
    const req = store.index('deviceId').openKeyCursor();
    req.onsuccess = () => {
      const cur = req.result;
      if (cur) {
        ids.add(String(cur.key));
        cur.continue();
      } else {
        resolve([...ids]);
      }
    };
    req.onerror = () => reject(req.error);
  });
}

/** @returns {Promise<Position[]>} */
export async function allPositions() {
  const d = await open();
  const store = d.transaction('positions', 'readonly').objectStore('positions');
  /** @type {Position[]} */
  const out = await wrap(store.getAll());
  return out.sort((a, b) => a.ts - b.ts);
}

/**
 * Merge a patch into a device record.
 *
 * Names and roles are written by different code paths at different times, so
 * this reads first -- a blind put would have naming clobber the role a user
 * had set, and vice versa.
 *
 * @param {string} deviceId
 * @param {{long?: string, short?: string, role?: string}} patch
 */
export async function putDevice(deviceId, patch) {
  const d = await open();
  const tx = d.transaction('devices', 'readwrite');
  const store = tx.objectStore('devices');
  const existing = (await wrap(store.get(deviceId))) || { deviceId };
  await wrap(store.put({ ...existing, ...patch, deviceId }));
}

/** @returns {Promise<{deviceId: string, long?: string, short?: string, role?: string}[]>} */
export async function allDevices() {
  const d = await open();
  const store = d.transaction('devices', 'readonly').objectStore('devices');
  return wrap(store.getAll());
}

/** Clear the session. */
export async function clear() {
  const d = await open();
  const tx = d.transaction('positions', 'readwrite');
  await wrap(tx.objectStore('positions').clear());
}

/** Forget stored node names too. */
export async function clearDevices() {
  const d = await open();
  const tx = d.transaction('devices', 'readwrite');
  await wrap(tx.objectStore('devices').clear());
}

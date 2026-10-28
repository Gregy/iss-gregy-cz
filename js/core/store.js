// Minimal IndexedDB key-value store, usable from both page and service worker
// (localStorage is not available in service workers).

const DB = 'iss-pwa';
const STORE = 'kv';
let dbp;

function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(mode, fn) {
  return db().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(STORE, mode);
    const req = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
  }));
}

export const get = (key) => tx('readonly', (s) => s.get(key));
export const set = (key, value) => tx('readwrite', (s) => s.put(value, key));
export const del = (key) => tx('readwrite', (s) => s.delete(key));

export const DEFAULT_SETTINGS = {
  minElevation: 25, // degrees
  minScore: 30,
  leadMinutes: 10,
  headsUpHours: 0, // extra notification this many hours before a good pass (0 = off)
  horizonHours: 48, // how far ahead alerts are booked on the relay
  pushEnabled: false,
};

export async function getSettings() {
  const { pushServer, ...saved } = (await get('settings')) || {}; // pushServer: no longer a setting
  return { ...DEFAULT_SETTINGS, ...saved };
}

/** Stores only explicitly changed values, so new defaults reach existing installs. */
export async function saveSettings(patch) {
  await set('settings', { ...((await get('settings')) || {}), ...patch });
  return getSettings();
}

/** Append to a small rolling log, handy for seeing whether background sync ran. */
export async function log(source, msg) {
  const entries = (await get('log')) || [];
  entries.unshift({ t: Date.now(), source, msg });
  await set('log', entries.slice(0, 40));
}

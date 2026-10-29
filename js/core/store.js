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
  notifyFrom: 360, // only passes appearing between these times of day (minutes, location's time zone)
  notifyTo: 1320,
  leadMinutes: 15,
  pushEnabled: false,
};

export async function getSettings() {
  // settings that no longer exist: relay URL, heads-up, booking window
  const { pushServer, headsUpHours, horizonHours, ...saved } = (await get('settings')) || {};
  const s = { ...DEFAULT_SETTINGS, ...saved };
  if (s.leadMinutes < 5) s.leadMinutes = 5; // 3 min is no longer offered
  return s;
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

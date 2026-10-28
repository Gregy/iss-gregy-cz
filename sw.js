// Service worker (ES module): offline app shell, map tile cache, push
// notifications from the relay, and a background re-sync of the alert schedule
// (fresh forecast) driven by Periodic Background Sync.
import { syncPush, freshenLeadAlert } from './js/core/alerts.js';
import { forget, subscribe } from './js/core/push.js';
import * as store from './js/core/store.js';
import { APP_VERSION } from './js/config.js';

const VERSION = `v${APP_VERSION}`;
const SHELL = `shell-${VERSION}`;
const TILES = 'tiles-v1';
const MAX_TILES = 400;

// Same-origin files are served from one complete, versioned copy of the app:
// mixing files from two versions (new index.html, old app.js) breaks the page.
// On localhost the network always wins, so edits show up without a version bump.
const DEV = ['localhost', '127.0.0.1'].includes(self.location.hostname);

const SHELL_FILES = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/app.js', 'js/ui/map.js', 'js/ui/skychart.js',
  'js/core/astro.js', 'js/core/passes.js', 'js/core/weather.js', 'js/core/store.js',
  'js/core/tle.js', 'js/core/alerts.js', 'js/core/push.js', 'js/core/webpush.js', 'js/config.js',
  'vendor/satellite.esm.js', 'vendor/leaflet/leaflet.js', 'vendor/leaflet/leaflet.css',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png', 'icons/badge-96.png', 'icons/icon.svg',
];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the HTTP cache, which may still hold the previous version
  e.waitUntil(caches.open(SHELL)
    .then((c) => c.addAll(SHELL_FILES.map((f) => new Request(f, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== SHELL && k !== TILES) await caches.delete(k);
    await self.clients.claim();
  })());
});

async function trimTiles() {
  const c = await caches.open(TILES);
  const keys = await c.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await c.delete(keys[i]);
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.hostname === 'gibs.earthdata.nasa.gov') {
    e.respondWith((async () => {
      const c = await caches.open(TILES);
      const hit = await c.match(req);
      if (hit) return hit;
      try {
        const res = await fetch(req);
        if (res.ok && res.type === 'cors') { await c.put(req, res.clone()); trimTiles(); }
        return res;
      } catch {
        return Response.error(); // offline or GIBS hiccup: the map layer retries
      }
    })());
    return;
  }

  if (url.origin !== self.location.origin) return; // APIs: always network (app caches data in IndexedDB)
  if (url.pathname.endsWith('/data/iss.tle')) return; // must be fresh

  // the installed version's copy first; a new version arrives as a new service worker
  e.respondWith((async () => {
    const c = await caches.open(SHELL);
    const nav = req.mode === 'navigate';
    const cached = () => c.match(req, { ignoreSearch: nav }).then((hit) => hit || (nav ? c.match('index.html') : undefined));
    if (!DEV) {
      const hit = await cached();
      if (hit) return hit;
    }
    try {
      return await fetch(req, DEV ? { cache: 'no-cache' } : undefined);
    } catch (err) {
      return (await cached()) || Response.error();
    }
  })());
});

const sameOrigin = (url) => {
  try { return new URL(url, self.registration.scope).origin === self.location.origin; } catch { return false; }
};

const backgroundSync = (source, opts = {}) => syncPush({
  source, baseUrl: self.registration.scope, registration: self.registration, ...opts,
});

self.addEventListener('push', (e) => {
  let d;
  try { d = e.data.json(); } catch { d = { title: 'ISS Pass Tracker', body: e.data?.text() || '' }; }
  e.waitUntil((async () => {
    // "look up now": re-check the clouds first (a few seconds at most)
    d = await freshenLeadAlert(d).catch(() => d);
    await self.registration.showNotification(d.title || 'ISS Pass Tracker', {
      body: d.body,
      tag: d.tag,
      renotify: !!d.tag,
      requireInteraction: d.kind === 'lead', // "look up now" should stay until dismissed
      icon: 'icons/icon-192.png',
      badge: 'icons/badge-96.png',
      data: { url: d.url && sameOrigin(d.url) ? d.url : self.registration.scope },
    });
    // Any alert is also a chance to re-book with the latest forecast, e.g. a
    // heads-up cancels the later "look up now" if the pass has clouded over.
    await backgroundSync('push', { weatherMaxAge: 10 * 60e3 }).catch(() => {});
  })());
});

self.addEventListener('periodicsync', (e) => {
  if (e.tag === 'iss-check') e.waitUntil(backgroundSync('periodic-sync'));
});

// The browser rotated or expired the subscription: subscribe again (same
// device key) and re-book; the old one is forgotten on the relay.
self.addEventListener('pushsubscriptionchange', (e) => {
  e.waitUntil((async () => {
    const settings = await store.getSettings();
    if (!settings.pushEnabled) return;
    try {
      if (e.oldSubscription) await forget(e.oldSubscription.toJSON()).catch(() => {});
      if (!e.newSubscription) await subscribe(self.registration);
      await backgroundSync('subscription-change', { force: true });
    } catch (err) {
      await store.log('subscription-change', 'setting up notifications again failed: ' + (err.message || err));
    }
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || self.registration.scope;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of all) {
      if (c.url.startsWith(self.registration.scope)) {
        await c.focus();
        c.postMessage({ type: 'open', url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});

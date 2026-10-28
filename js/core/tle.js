// Orbital elements for the ISS, with several sources and an IndexedDB cache.
import { parseTle } from './astro.js';
import * as store from './store.js';

const MAX_AGE = 8 * 3600e3; // refetch after 8 h
const DAY = 86400e3;

const SOURCES = [
  // refreshed daily by the GitHub Pages deploy workflow; same origin, always CORS-safe
  { name: 'bundled', url: () => new URL('../../data/iss.tle', import.meta.url).href, parse: (t) => t },
  { name: 'celestrak', url: () => 'https://celestrak.org/NORAD/elements/gp.php?CATNR=25544&FORMAT=TLE', parse: (t) => t },
  {
    name: 'ivanstanojevic',
    url: () => 'https://tle.ivanstanojevic.me/api/tle/25544',
    parse: (t) => { const j = JSON.parse(t); return `${j.line1}\n${j.line2}`; },
  },
];

async function fetchSource(src) {
  const res = await fetch(src.url(), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${src.name}: HTTP ${res.status}`);
  const tle = parseTle(src.parse(await res.text()));
  return { l1: tle.l1, l2: tle.l2, epoch: tle.epoch, source: src.name, fetched: Date.now() };
}

/** Returns { satrec, epoch, source, fetched }. Throws only if nothing is available at all. */
export async function loadTle({ force = false } = {}) {
  const cached = await store.get('tle');
  if (!force && cached && Date.now() - cached.fetched < MAX_AGE) return hydrate(cached);

  let best = null;
  for (const src of SOURCES) {
    try {
      const r = await fetchSource(src);
      if (!best || r.epoch > best.epoch) best = r;
      // a TLE younger than a day is plenty for naked-eye predictions
      if (Date.now() - r.epoch < DAY) break;
    } catch (e) {
      console.warn('TLE source failed', e);
    }
  }
  if (best && (!cached || best.epoch >= cached.epoch)) {
    await store.set('tle', best);
    return hydrate(best);
  }
  if (cached) return hydrate(cached);
  throw new Error('Could not load ISS orbital elements');
}

function hydrate(rec) {
  const { satrec } = parseTle(`${rec.l1}\n${rec.l2}`);
  return { ...rec, satrec };
}

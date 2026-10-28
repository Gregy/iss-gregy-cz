// Pass prediction for an observer. Finds horizon crossings with a coarse scan
// plus bisection, then samples each pass to determine the naked-eye visible
// segment (ISS sunlit, observer's sky dark enough, ISS high enough).
import { elevationAt, satState, sunAltAz, sunEquatorial } from './astro.js';

const COARSE_STEP = 30e3; // ms
const PATH_STEP = 10e3; // ms

export const VIS_MIN_EL = 10; // degrees above horizon to count as visible
export const VIS_MAX_SUN = -6; // sun must be below this altitude (civil twilight)

function bisect(f, a, b, wantAbove) {
  // f(a) and f(b) straddle 0; returns time (ms) of crossing to ~1 s
  while (b - a > 1000) {
    const m = (a + b) / 2;
    const above = f(m) >= 0;
    if (above === wantAbove) b = m; else a = m;
  }
  return (a + b) / 2;
}

/**
 * Like bisect, but returns the end of the final ~1 s bracket where f >= 0, so
 * a visibility edge is itself a visible moment (the ISS is often brightest
 * right as it leaves Earth's shadow).
 */
function bisectInside(f, a, b) {
  const aIn = f(a) >= 0;
  while (b - a > 1000) {
    const m = (a + b) / 2;
    if ((f(m) >= 0) === aIn) a = m; else b = m;
  }
  return aIn ? a : b;
}

function refineMax(f, a, b) {
  // golden-section search for maximum elevation
  const g = (Math.sqrt(5) - 1) / 2;
  let c = b - g * (b - a), d = a + g * (b - a);
  let fc = f(c), fd = f(d);
  while (b - a > 1000) {
    if (fc > fd) { b = d; d = c; fd = fc; c = b - g * (b - a); fc = f(c); }
    else { a = c; c = d; fc = fd; d = a + g * (b - a); fd = f(d); }
  }
  return (a + b) / 2;
}

/**
 * Predict passes.
 * @param satrec satellite.js satrec
 * @param observer from makeObserver()
 * @param fromMs start time (passes already in progress are included)
 * @param hours search window length
 */
export function predictPasses(satrec, observer, fromMs, hours = 240) {
  const elev = (t) => elevationAt(satrec, new Date(t), observer);
  const start = fromMs - 20 * 60e3;
  const end = fromMs + hours * 3600e3;
  const passes = [];
  let t = start;
  let prev = elev(t);
  let riseT = prev >= 0 ? t : null;

  while (t < end) {
    const nt = t + COARSE_STEP;
    const e = elev(nt);
    if (prev < 0 && e >= 0) {
      riseT = bisect(elev, t, nt, true);
    } else if (prev >= 0 && e < 0 && riseT !== null) {
      const setT = bisect(elev, t, nt, false);
      if (setT > fromMs) {
        const p = describePass(satrec, observer, riseT, setT, elev);
        if (p) passes.push(p);
      }
      riseT = null;
    }
    prev = e;
    t = nt;
  }
  return passes;
}

function describePass(satrec, observer, riseT, setT, elev) {
  const maxT = refineMax(elev, riseT, setT);
  const state = (ms) => {
    const d = new Date(ms);
    const s = satState(satrec, d, observer, sunEquatorial(d));
    if (!s) return null;
    s.sunAlt = sunAltAz(d, observer.lat, observer.lon).alt;
    s.vis = s.sunlit && s.sunAlt < VIS_MAX_SUN && s.el >= VIS_MIN_EL;
    return s;
  };

  const times = [];
  for (let ms = riseT; ms < setT; ms += PATH_STEP) times.push(ms);
  times.push(setT);
  // make sure the culmination is an exact sample
  const mi = times.findIndex((ms) => ms > maxT);
  times.splice(mi < 0 ? times.length : mi, 0, maxT);

  const path = times.map(state).filter(Boolean);
  if (path.length < 2) return null;
  const pick = (s) => s && { t: s.t, az: s.az, el: s.el, mag: s.mag, sunlit: s.sunlit };
  const max = path.reduce((a, b) => (b.el > a.el ? b : a));

  let visible = null;
  const visIdx = path.map((s, i) => (s.vis ? i : -1)).filter((i) => i >= 0);
  if (visIdx.length) {
    // refine visible window edges to ~1 s
    const first = visIdx[0], last = visIdx[visIdx.length - 1];
    const isVis = (ms) => (state(ms)?.vis ? 1 : -1);
    const vStartT = first > 0 ? bisectInside(isVis, path[first - 1].t, path[first].t) : path[first].t;
    const vEndT = last < path.length - 1 ? bisectInside(isVis, path[last].t, path[last + 1].t) : path[last].t;
    const vStart = state(vStartT), vEnd = state(vEndT);
    const seg = path.filter((s) => s.t >= vStartT && s.t <= vEndT && s.vis);
    seg.push(vStart, vEnd);
    const vMax = seg.reduce((a, b) => (b.el > a.el ? b : a));
    const brightest = seg.filter((s) => s.mag != null).reduce((a, b) => (!a || b.mag < a.mag ? b : a), null);
    visible = {
      start: pick(vStart),
      end: pick(vEnd),
      max: pick(vMax),
      minMag: brightest ? brightest.mag : null,
      minMagEl: brightest ? brightest.el : null,
      duration: (vEndT - vStartT) / 1000,
      sunAlt: vMax.sunAlt,
    };
  }

  const maxSunAlt = max.sunAlt;
  return {
    id: 'p' + Math.round(riseT / 60000), // stable per pass (minute of rise)
    rise: pick(path[0]),
    max: pick(max),
    set: pick(path[path.length - 1]),
    visible,
    // why a pass isn't visible
    kind: visible ? 'visible' : maxSunAlt >= VIS_MAX_SUN ? 'daylight' : path.some((s) => s.sunlit) ? 'low' : 'shadow',
    path: path.map((s) => ({ t: s.t, az: s.az, el: s.el, lit: s.sunlit, vis: s.vis })),
  };
}

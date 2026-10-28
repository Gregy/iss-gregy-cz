// Polar sky chart: zenith in the centre, horizon on the rim, north up.
// Shows where to look during a pass.
import { fmtTime } from '../core/alerts.js';

const R = 100; // chart radius in SVG units

function xy(az, el) {
  const r = (R * (90 - Math.max(0, el))) / 90;
  const a = (az * Math.PI) / 180;
  return [r * Math.sin(a), -r * Math.cos(a)];
}

const pt = (s) => xy(s.az, s.el).map((n) => n.toFixed(1)).join(',');

/**
 * @param pass pass from predictPasses()
 * @param opts { tz, live: {az, el} | null }
 */
export function skyChart(pass, { tz, live = null } = {}) {
  const segs = [];
  let cur = null;
  for (const s of pass.path) {
    const kind = s.vis ? 'vis' : s.lit ? 'lit' : 'dark';
    if (!cur || cur.kind !== kind) {
      const prev = cur?.pts[cur.pts.length - 1];
      cur = { kind, pts: prev ? [prev] : [] };
      segs.push(cur);
    }
    cur.pts.push(s);
  }
  const lines = segs.map((g) => `<polyline class="sky-${g.kind}" points="${g.pts.map(pt).join(' ')}"/>`).join('');

  const v = pass.visible;
  const marks = [];
  const placed = [];
  const label = (s, cls, text) => {
    const [x, y] = xy(s.az, s.el);
    marks.push(`<circle class="${cls}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3.5"/>`);
    if (!text) return;
    // push the label radially: outward near the zenith, inward near the rim,
    // and flip if it would land on a label already placed
    const r = Math.hypot(x, y);
    const [ux, uy] = r < 6 ? [0, 1] : [x / r, y / r];
    let dir = r > 70 ? -1 : 1;
    const at = (d) => [x + d * ux * 15, y + d * uy * 15];
    if (placed.some(([px, py]) => Math.hypot(px - at(dir)[0], py - at(dir)[1]) < 22)) dir = -dir;
    const [lx, ly] = at(dir);
    placed.push([lx, ly]);
    const hx = dir * ux;
    const anchor = Math.abs(hx) < 0.35 ? 'middle' : hx > 0 ? 'start' : 'end';
    marks.push(`<text class="sky-label" x="${lx.toFixed(1)}" y="${(ly + 3.5).toFixed(1)}" text-anchor="${anchor}">${text}</text>`);
  };
  if (v) {
    label(v.start, 'sky-start', fmtTime(v.start.t, tz));
    label(v.max, 'sky-max', `${Math.round(v.max.el)}°`);
    label(v.end, 'sky-end', fmtTime(v.end.t, tz));
  } else {
    label(pass.rise, 'sky-start', '');
    label(pass.set, 'sky-end', '');
  }
  // direction arrow near the end of the drawn path
  const tail = pass.path[Math.max(0, pass.path.length - 6)], head = pass.path[pass.path.length - 1];
  const [x1, y1] = xy(tail.az, tail.el), [x2, y2] = xy(head.az, head.el);
  const ang = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  const arrow = `<path class="sky-arrow" d="M0,-5 L10,0 L0,5 z" transform="translate(${x2.toFixed(1)},${y2.toFixed(1)}) rotate(${ang.toFixed(0)}) translate(-10,0)"/>`;

  const liveDot = live && live.el > 0
    ? (() => { const [x, y] = xy(live.az, live.el); return `<circle class="sky-live" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="6"/>`; })()
    : '';

  return `<svg class="skychart" viewBox="-118 -118 236 236" role="img" aria-label="Sky chart of the pass">
    <circle class="sky-bg" r="${R}"/>
    <circle class="sky-ring" r="${(R * 60) / 90}"/><circle class="sky-ring" r="${(R * 30) / 90}"/>
    <line class="sky-ring" x1="${-R}" y1="0" x2="${R}" y2="0"/><line class="sky-ring" x1="0" y1="${-R}" x2="0" y2="${R}"/>
    <text class="sky-ring-label" x="3" y="${(-R * 60) / 90 + 9}">30°</text>
    <text class="sky-ring-label" x="3" y="${(-R * 30) / 90 + 9}">60°</text>
    <text class="sky-cardinal" x="0" y="${-R - 6}" text-anchor="middle">N</text>
    <text class="sky-cardinal" x="${R + 9}" y="4" text-anchor="middle">E</text>
    <text class="sky-cardinal" x="0" y="${R + 14}" text-anchor="middle">S</text>
    <text class="sky-cardinal" x="${-R - 9}" y="4" text-anchor="middle">W</text>
    ${lines}${arrow}${marks.join('')}${liveDot}
  </svg>`;
}

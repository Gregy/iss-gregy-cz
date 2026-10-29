// Estimate of Chrome's site engagement score for this app, and the
// "still interested?" reminder booked before it gets too low.
//
// Chrome runs Periodic Background Sync only for sites with engagement, and less
// often the lower the score (see README, "Background refresh and site
// engagement"). The browser doesn't expose the score, so the app replays
// Chrome's own formula (components/site_engagement/content/
// site_engagement_score.cc) over the engagement it can see. It only counts what
// it is sure Chrome counts, so the estimate errs low: a reminder may come a
// little early, never too late.
//
// The state mirrors the one Chrome keeps per site: { raw, today, last, launch }.
import * as store from './store.js';

// Chrome's defaults
export const P = {
  maxPerDay: 15,
  decayHours: 2,
  decay: 0.984, // per period
  cleanup: 0.5, // scores at or below are deleted
  input: 0.6, // key down, mouse down, touch start, scroll; then 10 s pause
  notification: 1, // click on a notification
  firstDaily: 1.5, // added to the first engagement of each local day
  installed: 5, // bonus while the app was launched from its icon in the last 10 days
  launchDays: 10,
  max: 100,
};

// Below this the engagement level drops from LOW to MINIMAL and Chrome
// stretches the background refresh interval from 24 h to 36 h.
export const THRESHOLD = 1;
export const NUDGE_HOUR = 19; // local time the reminder is shown at
const HOUR = 3600e3;
const DAY = 86400e3;

const empty = () => ({ raw: 0, today: 0, last: 0, launch: 0 });
const localDay = (t) => new Date(t).toDateString();

/** Score without the installed-app bonus (Chrome: DecayedScore). */
export function decayed(st, now) {
  if (!st.last) return st.raw;
  const hours = Math.trunc((now - st.last) / HOUR);
  if (hours < 0) return st.raw;
  return st.raw * P.decay ** Math.floor(hours / P.decayHours);
}

export const bonus = (st, now) =>
  st.launch && Math.trunc((now - st.launch) / DAY) <= P.launchDays ? P.installed : 0;

/** What Chrome would report as the site's score at `now` (Chrome: GetTotalScore). */
export const total = (st, now) => Math.min(decayed(st, now) + bonus(st, now), P.max);

/** Chrome deletes scores at or below the cleanup threshold. */
const settle = (st, now) => (st.last && total(st, now) <= P.cleanup ? empty() : st);

/** Chrome: SiteEngagementScore::AddPoints. Pure; returns the new state. */
export function addPoints(prev, points, now, day = localDay) {
  const st = { ...settle(prev || empty(), now) };
  st.raw = decayed(st, now);
  if (st.last && day(now) !== day(st.last)) st.today = 0;
  if (st.today === 0) points += P.firstDaily;
  const add = Math.min(P.max - st.raw, P.maxPerDay - st.today, points);
  st.today += add;
  st.raw += add;
  st.last = now;
  return st;
}

/** Chrome: SetLastShortcutLaunchTime. */
export const launched = (prev, now) => ({ ...(prev || empty()), launch: now });

/**
 * When the score will fall below THRESHOLD if nothing else happens: the score
 * only changes at decay steps and when the launch bonus ends. Returns `now`
 * when it already is below.
 */
export function crossing(st, now, threshold = THRESHOLD) {
  if (!st) return now;
  const steps = new Set([now]);
  if (st.launch) steps.add(st.launch + (P.launchDays + 1) * DAY);
  if (st.last) {
    const first = Math.max(0, Math.ceil((now - st.last) / (P.decayHours * HOUR)));
    for (let k = first; k < first + 60 * 12; k++) steps.add(st.last + k * P.decayHours * HOUR);
  }
  for (const t of [...steps].filter((t) => t >= now).sort((a, b) => a - b)) {
    if (total(st, t) < threshold) return t;
  }
  return Infinity;
}

/** Local NUDGE_HOUR on the day of `t`. */
function atHour(t, hour) {
  const d = new Date(t);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
}

/**
 * When to remind: the last NUDGE_HOUR before the score crosses THRESHOLD, or
 * the next one if that's already past. Day-granular, so a session of taps
 * rarely moves it. Null while no reminder is wanted:
 *  - `shown` is when the last reminder arrived; if there has been no
 *    engagement since, it was ignored and no more are sent (no nagging).
 */
export function nudgeTime(st, now, { shown = 0 } = {}) {
  if (shown && (!st || st.last < shown)) return null;
  const cross = crossing(st, now);
  if (cross === Infinity) return null;
  let t = atHour(cross, NUDGE_HOUR);
  if (t >= cross) t = atHour(cross - DAY, NUDGE_HOUR);
  if (t <= now + 10 * 60e3) {
    // already due: the next reasonable moment (today's reminder hour, else tomorrow's)
    t = atHour(now, NUDGE_HOUR);
    if (t <= now + 10 * 60e3) t = atHour(now + DAY, NUDGE_HOUR);
  }
  return t;
}

export const NUDGE = {
  id: 'nudge',
  tag: 'nudge',
  kind: 'nudge',
  title: 'Still want ISS pass alerts?',
  body: "Tap to keep them coming. Your browser pauses background updates for apps you haven't used in a while.",
};

// ---------- recording (page and service worker) ----------

const locked = (fn) => (globalThis.navigator?.locks ? navigator.locks.request('iss-engagement', fn) : fn());

async function update(fn) {
  return locked(async () => {
    const st = fn(await store.get('engagement'));
    await store.set('engagement', st);
    return st;
  });
}

export const recordInput = (now = Date.now()) => update((st) => addPoints(st, P.input, now));
export const recordNotificationClick = (now = Date.now()) => update((st) => addPoints(st, P.notification, now));
export const recordLaunch = (now = Date.now()) => update((st) => launched(st, now));
export const recordNudgeShown = (now = Date.now()) => store.set('nudgeShown', now);

/** The reminder to book with the next schedule upload, or null. */
export async function plannedNudge(now = Date.now()) {
  const [st, shown] = await Promise.all([store.get('engagement'), store.get('nudgeShown')]);
  // nothing recorded yet (e.g. an install from before this existed): treat as no engagement
  const at = nudgeTime(st || { ...empty(), last: now }, now, { shown });
  return at == null ? null : { ...NUDGE, at };
}

/**
 * Chrome's input tracking in a page: inputs count from 10 s after the page
 * loads (5 s after it becomes visible again), then at most one per 10 s.
 */
export function trackInput(onInput, { loadedAt = performance.timeOrigin } = {}) {
  let from = loadedAt + 10e3;
  let tracking = document.visibilityState === 'visible';
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') tracking = false;
    else if (!tracking) { tracking = true; from = Math.max(from, Date.now() + 5e3); }
  });
  const handler = (e) => {
    if (!e.isTrusted || !tracking) return;
    const now = Date.now();
    if (now < from) return;
    from = now + 10e3;
    onInput(now);
  };
  for (const type of ['pointerdown', 'keydown']) addEventListener(type, handler, { capture: true, passive: true });
}

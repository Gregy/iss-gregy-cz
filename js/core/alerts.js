// Alert engine shared by the page and the service worker: predicts passes,
// scores them against the forecast and books the resulting notifications on
// the push relay. Every sync uploads the complete list of upcoming alerts, so a
// pass that no longer qualifies simply disappears from the relay's schedule.
//
// Nothing runs in the background: the schedule is renewed when the app is
// opened and whenever a booked notification arrives. So it books every
// matching pass of the next BOOK_DAYS, and before a longer stretch without
// passes it books "season" notices ahead of the next ones, whose arrival
// re-books everything with fresh orbit data and forecast.
import { compass, makeObserver } from './astro.js';
import { predictPasses } from './passes.js';
import { fetchWeather, scorePass, passWeather, clearSkyFactor } from './weather.js';
import { loadTle } from './tle.js';
import { prepareAlerts, uploadSchedule, retryPendingForgets, subscribe } from './push.js';
import * as store from './store.js';
import { PUSH_SERVER } from '../config.js';

const WEATHER_MAX_AGE = 45 * 60e3;
const DAY = 86400e3;
const MAX_ALERTS = 60; // the relay's limit per subscription
export const BOOK_DAYS = 14; // "look up now" alerts for every matching pass this far ahead
export const WEATHER_HOURS = 48; // beyond this the cloud forecast is too uncertain to drop a pass for
export const LOOKAHEAD_DAYS = 120; // how far to look for the next passes after a long stretch without any
export const SEASON_PASSES = 5; // at least this many booked chances to re-book, in case the phone misses some
const SEASON_LEAD = 3 * 3600e3; // a season notice comes this long before its pass
const RESYNC_UNCHANGED = 6 * 3600e3; // re-upload an unchanged schedule after this long (keeps the relay subscription fresh)

export async function loadWeather(loc, { maxAge = WEATHER_MAX_AGE } = {}) {
  const cached = await store.get('weather');
  const same = cached && Math.abs(cached.lat - loc.lat) < 0.02 && Math.abs(cached.lon - loc.lon) < 0.02;
  if (same && Date.now() - cached.fetched < maxAge) return cached;
  try {
    const w = await fetchWeather(loc.lat, loc.lon);
    await store.set('weather', w);
    if (w.timezone && loc.tz !== w.timezone) {
      loc.tz = w.timezone;
      await store.set('location', loc);
    }
    return w;
  } catch (e) {
    console.warn('weather failed', e);
    return same ? cached : null;
  }
}

/** Passes + scores for a location. */
export async function computeForecast(loc, { hours = 240, from = Date.now(), forceTle = false, weatherMaxAge } = {}) {
  const [tle, weather] = await Promise.all([loadTle({ force: forceTle }), loadWeather(loc, { maxAge: weatherMaxAge })]);
  const observer = makeObserver(loc.lat, loc.lon, loc.height || 0);
  const passes = predictPasses(tle.satrec, observer, from, hours);
  for (const p of passes) p.rating = scorePass(p, weather);
  return { tle, weather, observer, passes };
}

/** Minutes since midnight of time t in time zone tz (the device's zone if unset). */
export function localMinutes(t, tz) {
  const parts = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23', timeZone: tz }).formatToParts(t);
  const get = (type) => Number(parts.find((x) => x.type === type).value);
  return get('hour') * 60 + get('minute');
}

/**
 * Does a pass meet the alert criteria? `tz` is the location's time zone, for
 * the time-of-day window. Within WEATHER_HOURS of `now` the score includes the
 * cloud forecast; further out it is the clear-sky score, since a forecast that
 * far ahead shouldn't cancel an alert (the arriving alert re-checks the clouds).
 */
export function qualifies(p, s, tz, now = Date.now()) {
  const r = p.rating;
  if (!p.visible || !r) return false;
  if (p.visible.max.el < s.minElevation) return false;
  const appears = localMinutes(p.visible.start.t, tz);
  if (appears < s.notifyFrom || appears > s.notifyTo) return false;
  const score = p.visible.start.t - now <= WEATHER_HOURS * 3600e3 ? r.score : r.geo;
  return score >= s.minScore;
}

// ---------- formatting ----------

export function fmtTime(t, tz) {
  return new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', timeZone: tz }).format(t);
}

/** "Tonight" / "Today" / "Tomorrow" / weekday of `t`, as seen at time `now`. */
export function fmtDay(t, tz, now = Date.now()) {
  const day = (ms) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ms);
  const d = day(t);
  if (d === day(now)) {
    const h = Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hourCycle: 'h23', timeZone: tz }).format(t));
    return h >= 17 || h < 4 ? 'Tonight' : 'Today';
  }
  if (d === day(now + 86400e3)) return 'Tomorrow';
  return new Intl.DateTimeFormat(undefined, { weekday: 'long', timeZone: tz }).format(t);
}

export function describePass(p, tz) {
  const v = p.visible;
  const r = p.rating;
  const mag = v.minMag != null ? `mag ${v.minMag.toFixed(1)}` : '';
  const wx = r.wx ? `clouds ${Math.round(r.wx.effective)}%` : 'no forecast yet';
  return {
    when: `${fmtDay(v.start.t, tz)} ${fmtTime(v.start.t, tz)}`,
    path: `Appears ${fmtTime(v.start.t, tz)} in the ${compass(v.start.az)}, highest ${Math.round(v.max.el)}° ${compass(v.max.az)} at ${fmtTime(v.max.t, tz)}, gone ${fmtTime(v.end.t, tz)} ${compass(v.end.az)}.`,
    stats: [mag, wx, `score ${r.score}`].filter(Boolean).join(' · '),
  };
}

// ---------- schedule ----------

/** `t` moved into daytime (08:00–21:00 in `tz`), earlier rather than later: a notice must come before its pass. */
export function daytime(t, tz) {
  const m = localMinutes(t, tz);
  if (m < 8 * 60) return t - (m + 4 * 60) * 60e3; // night or early morning: 20:00 the evening before
  if (m > 21 * 60) return t - (m - 20 * 60) * 60e3; // late evening: 20:00
  return t;
}

/** "tonight", "tomorrow", "on Friday": when `t` is, as seen at `now`. */
const dayPhrase = (t, tz, now) => {
  const d = fmtDay(t, tz, now);
  return ['Tonight', 'Today', 'Tomorrow'].includes(d) ? d.toLowerCase() : `on ${d}`;
};

const seasonNotice = (baseUrl, at, id, body) => ({
  id, at, kind: 'season', tag: 'season', url: `${baseUrl}#passes`, title: '🛰️ ISS season is back', body,
});

/**
 * Notifications to book: a "look up now" alert for every qualifying pass of the
 * next BOOK_DAYS. With fewer than SEASON_PASSES of them, season notices before
 * the next qualifying passes after that make up the difference (orbit
 * predictions that far out are only good to the day, which is all a notice
 * needs). Every arrival re-books, so a notice only fires if all earlier
 * notifications were missed or there were none. If no pass after BOOK_DAYS
 * qualifies within the passes given, one notice at their end, to look again.
 */
export function buildSchedule(passes, settings, loc, baseUrl, now = Date.now()) {
  const tz = loc.tz;
  const good = passes.filter((p) => qualifies(p, settings, tz, now));
  const out = [];
  for (const p of good) {
    const v = p.visible;
    const at = v.start.t - settings.leadMinutes * 60e3;
    if (at <= now || at > now + BOOK_DAYS * DAY) continue;
    const d = describePass(p, tz);
    // what the phone needs to re-score the pass against the latest forecast when the alert arrives
    const f = p.rating.factors;
    const check = { t: [v.start.t, v.max.t, v.end.t], geo: f.brightness * f.darkSky * f.duration, score: p.rating.score };
    out.push({
      id: `${p.id}-lead`, at, kind: 'lead', tag: p.id, url: `${baseUrl}#pass=${p.id}`,
      title: `🛰️ ISS in ${settings.leadMinutes} min, look ${compass(v.start.az)}`, body: `${d.path}\n${d.stats}`, check,
    });
  }
  if (out.length >= SEASON_PASSES) return out.slice(0, MAX_ALERTS);

  const later = good.filter((p) => p.visible.start.t > now + BOOK_DAYS * DAY).slice(0, SEASON_PASSES - out.length);
  for (const p of later) {
    const at = daytime(p.visible.start.t - SEASON_LEAD, tz);
    if (at > now) out.push(seasonNotice(baseUrl, at, `${p.id}-season`, `Visible passes are back, the first ${dayPhrase(p.visible.start.t, tz, at)} around ${fmtTime(p.visible.start.t, tz)}. Open the app for the forecast.`));
  }
  if (!later.length && passes.length) {
    // nothing matches for months (e.g. summer nights too short at high latitudes): look again then
    const at = daytime(passes[passes.length - 1].rise.t - DAY, tz);
    if (at > now) out.push(seasonNotice(baseUrl, at, 'season-check', 'No ISS passes match your settings for now. The app keeps watching.'));
  }
  return out;
}

// ---------- at delivery ----------

const FRESH_WEATHER_TIMEOUT = 4000; // a "look up now" alert must not wait longer for the forecast

/**
 * A "look up now" alert re-scored against `wx`, the latest forecast for its
 * pass: says so if the sky clouded over since it was booked, otherwise adds the
 * latest cloud cover. Pure, so it can be tested.
 */
export function leadAlertUpdate(d, wx, minScore) {
  const score = Math.round(d.check.geo * clearSkyFactor(wx) * 100);
  const cloud = Math.round(wx.effective);
  if (score < minScore) {
    return {
      ...d,
      title: `☁️ ${d.title.replace(/^🛰️\s*/, '')}, but ${cloud}% cloud now`,
      body: `Clouds moved in since this alert was booked (score now ${score}, was ${d.check.score}). Worth a look if you see clear patches.\n${d.body}`,
    };
  }
  return { ...d, body: `${d.body}\nLatest forecast: ${cloud}% cloud, score ${score}.` };
}

/**
 * Re-check a "look up now" alert against a fresh forecast before it is shown.
 * Falls back to the alert as booked when the forecast can't be fetched in time.
 */
export async function freshenLeadAlert(d) {
  if (d.kind !== 'lead' || !d.check) return d;
  const [loc, settings] = await Promise.all([store.get('location'), store.getSettings()]);
  if (!loc) return d;
  const timeout = new Promise((resolve) => setTimeout(resolve, FRESH_WEATHER_TIMEOUT, null));
  const w = await Promise.race([loadWeather(loc, { maxAge: 5 * 60e3 }), timeout]);
  // loadWeather falls back to its cache when offline: only a fresh forecast says anything new
  if (!w || Date.now() - w.fetched > 10 * 60e3) return d;
  const wx = passWeather(w, d.check.t);
  return wx ? leadAlertUpdate(d, wx, settings.minScore) : d;
}

/**
 * A season notice rewritten from `passes`, a fresh prediction for the coming
 * week: how many passes match and when the first is. Pure, so it can be tested.
 */
export function seasonAlertUpdate(d, passes, settings, tz, now) {
  const good = passes.filter((p) => p.visible && p.visible.start.t > now && p.visible.start.t <= now + 7 * DAY && qualifies(p, settings, tz, now));
  if (!good.length) return d;
  const first = good[0].visible.start.t;
  const n = good.length;
  return {
    ...d,
    body: `Did you miss it? ${n} ${n === 1 ? 'pass' : 'passes'} worth watching in the next 7 days, the first ${dayPhrase(first, tz, now)} at ${fmtTime(first, tz)}.`,
  };
}

const FRESH_SEASON_TIMEOUT = 6000;

async function freshenSeasonAlert(d) {
  const [loc, settings] = await Promise.all([store.get('location'), store.getSettings()]);
  if (!loc) return d;
  const timeout = new Promise((resolve) => setTimeout(resolve, FRESH_SEASON_TIMEOUT, null));
  const fresh = await Promise.race([computeForecast(loc, { hours: 7 * 24 + 1, weatherMaxAge: 5 * 60e3 }), timeout]);
  return fresh ? seasonAlertUpdate(d, fresh.passes, settings, loc.tz, Date.now()) : d;
}

/** An arriving notification brought up to date before it is shown; as booked if that fails. */
export function freshenAlert(d) {
  if (d.kind === 'lead') return freshenLeadAlert(d);
  if (d.kind === 'season') return freshenSeasonAlert(d);
  return Promise.resolve(d);
}

const when = (t) => new Date(t).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const plural = (k, one, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/** One line about what was booked, for the log and the status. */
export function scheduleSummary(s) {
  if (s.booked) return `${plural(s.good, 'notification-worthy pass', 'notification-worthy passes')} in the next ${BOOK_DAYS} days, ${plural(s.booked, 'notification')} scheduled, next ${when(s.next)}${s.season ? `; in case they're missed, "season is back" notices from ${when(s.season)}` : ''}`;
  if (s.lookAgain) return `no passes match your settings in the next ${LOOKAHEAD_DAYS} days; the app looks again ${when(s.season)}`;
  if (s.season) return `no passes in the next ${BOOK_DAYS} days; a "season is back" notice comes ${when(s.season)}`;
  return 'no passes match your settings';
}

/**
 * Recompute the alert schedule and upload it, encrypted and signed, for this
 * device's push subscription. `registration` is the ServiceWorkerRegistration
 * (the page and the service worker each have one).
 */
export async function syncPush(opts) {
  // page and service worker may both run this at once; serialise on a Web Lock
  if (globalThis.navigator?.locks) return navigator.locks.request('iss-push-sync', () => syncLocked(opts));
  return syncLocked(opts);
}

async function syncLocked({ source, registration, baseUrl, now = Date.now(), force = false, weatherMaxAge }) {
  const settings = await store.getSettings();
  const loc = await store.get('location');
  const skip = async (why) => { await store.set('lastCheck', { t: now, source, skipped: why }); return { skipped: why }; };
  await retryPendingForgets().catch(() => {});
  if (!settings.pushEnabled) return { skipped: 'push off' };
  if (!loc) return skip('no location');
  let sub = await registration.pushManager.getSubscription();
  if (!sub) return skip('not subscribed');

  try {
    const { passes, weather, tle, observer } = await computeForecast(loc, { hours: BOOK_DAYS * 24 + 1, from: now, weatherMaxAge });
    // without any forecast every pass would look clear; keep the previous bookings instead
    if (!weather) throw new Error('no weather forecast available, previous alerts kept');
    let alerts = buildSchedule(passes, settings, loc, baseUrl, now);
    if (alerts.filter((a) => a.kind === 'lead').length < SEASON_PASSES) {
      // few or no passes soon: look months ahead for where they resume
      const far = predictPasses(tle.satrec, observer, now, LOOKAHEAD_DAYS * 24);
      for (const p of far) p.rating = scorePass(p, weather);
      alerts = buildSchedule(far, settings, loc, baseUrl, now);
    }
    const good = passes.filter((p) => qualifies(p, settings, loc.tz, now)).length;
    const leads = alerts.filter((a) => a.kind === 'lead');
    const state = {
      good, booked: leads.length, next: leads[0]?.at ?? null, until: leads.at(-1)?.at ?? null,
      season: alerts.find((a) => a.kind === 'season')?.at ?? null, // the first season notice, or the look-again notice
      lookAgain: alerts.some((a) => a.id === 'season-check'),
    };
    const digest = PUSH_SERVER + sub.endpoint + JSON.stringify(alerts);
    const last = await store.get('push');
    if (!force && last?.digest === digest && now - last.t < RESYNC_UNCHANGED) {
      await store.set('lastCheck', { t: now, source, ...state, unchanged: true });
      return { ...state, unchanged: true };
    }
    let r = await uploadSchedule(sub, await prepareAlerts(sub, alerts, baseUrl));
    if (r.invalid) {
      // the push service rejected this device's signature (e.g. the key was lost
      // while the subscription survived): start over with a fresh subscription
      await sub.unsubscribe();
      sub = await subscribe(registration);
      r = await uploadSchedule(sub, await prepareAlerts(sub, alerts, baseUrl));
      await store.log(source, 'the push service no longer accepted this device; set it up again');
    }
    await store.set('push', { t: now, digest: PUSH_SERVER + sub.endpoint + JSON.stringify(alerts) });
    await store.set('lastCheck', { t: now, source, ...state });
    await store.log(source, scheduleSummary(state));
    return state;
  } catch (e) {
    const error = String(e.message || e);
    await store.set('lastCheck', { t: now, source, error });
    await store.log(source, 'scheduling notifications failed: ' + error);
    return { error };
  }
}

// Alert engine shared by the page and the service worker: predicts passes,
// scores them against the forecast and books the resulting notifications on
// the push relay. Every sync uploads the complete list of upcoming alerts, so a
// pass that no longer qualifies simply disappears from the relay's schedule.
import { compass, makeObserver } from './astro.js';
import { predictPasses } from './passes.js';
import { fetchWeather, scorePass, passWeather, clearSkyFactor } from './weather.js';
import { loadTle } from './tle.js';
import { prepareAlerts, uploadSchedule, retryPendingForgets, subscribe } from './push.js';
import * as store from './store.js';
import { PUSH_SERVER } from '../config.js';

const WEATHER_MAX_AGE = 45 * 60e3;
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

/** Does a pass meet the alert criteria? `tz` is the location's time zone, for the time-of-day window. */
export function qualifies(p, s, tz) {
  const r = p.rating;
  if (!p.visible || !r) return false;
  if (p.visible.max.el < s.minElevation) return false;
  const appears = localMinutes(p.visible.start.t, tz);
  if (appears < s.notifyFrom || appears > s.notifyTo) return false;
  return r.score >= s.minScore;
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

/** Notifications to book for qualifying passes within the horizon. */
export function buildSchedule(passes, settings, loc, baseUrl, now = Date.now()) {
  const horizon = now + settings.horizonHours * 3600e3;
  const out = [];
  for (const p of passes) {
    if (!qualifies(p, settings, loc.tz)) continue;
    const v = p.visible;
    const d = describePass(p, loc.tz);
    const common = { tag: p.id, url: `${baseUrl}#pass=${p.id}`, body: `${d.path}\n${d.stats}` };
    const lead = v.start.t - settings.leadMinutes * 60e3;
    if (lead > now && lead <= horizon) {
      // what the phone needs to re-score the pass against the latest forecast when the alert arrives
      const f = p.rating.factors;
      const check = { t: [v.start.t, v.max.t, v.end.t], geo: f.brightness * f.darkSky * f.duration, score: p.rating.score };
      out.push({ ...common, id: `${p.id}-lead`, at: lead, kind: 'lead', title: `🛰️ ISS in ${settings.leadMinutes} min, look ${compass(v.start.az)}`, check });
    }
    if (settings.headsUpHours > 0) {
      const ahead = v.start.t - settings.headsUpHours * 3600e3;
      if (ahead > now && ahead <= horizon) {
        out.push({ ...common, id: `${p.id}-ahead`, at: ahead, kind: 'info', title: `🛰️ ${fmtDay(v.start.t, loc.tz, ahead)} ${fmtTime(v.start.t, loc.tz)}: good ISS pass` });
      }
    }
  }
  return out.sort((a, b) => a.at - b.at).slice(0, 60);
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
    const { passes, weather } = await computeForecast(loc, { hours: settings.horizonHours + 1, from: now, weatherMaxAge });
    // without any forecast every pass would look clear; keep the previous bookings instead
    if (!weather) throw new Error('no weather forecast available, previous alerts kept');
    const alerts = buildSchedule(passes, settings, loc, baseUrl, now);
    const good = passes.filter((p) => qualifies(p, settings, loc.tz)).length;
    const digest = PUSH_SERVER + sub.endpoint + JSON.stringify(alerts);
    const last = await store.get('push');
    if (!force && last?.digest === digest && now - last.t < RESYNC_UNCHANGED) {
      await store.set('lastCheck', { t: now, source, good, booked: last.booked, next: last.next, unchanged: true });
      return { good, booked: last.booked, next: last.next, unchanged: true };
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
    await store.set('push', { t: now, digest: PUSH_SERVER + sub.endpoint + JSON.stringify(alerts), booked: r.booked, next: r.next });
    await store.set('lastCheck', { t: now, source, good, booked: r.booked, next: r.next });
    const n = (k, one) => `${k} ${one}${k === 1 ? '' : 's'}`;
    await store.log(source, `${n(good, 'notification-worthy pass')}, ${n(r.booked, 'notification')} scheduled${r.next ? ', next ' + new Date(r.next).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : ''}`);
    return { good, booked: r.booked, next: r.next };
  } catch (e) {
    const error = String(e.message || e);
    await store.set('lastCheck', { t: now, source, error });
    await store.log(source, 'scheduling notifications failed: ' + error);
    return { error };
  }
}

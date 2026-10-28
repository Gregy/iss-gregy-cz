import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scorePass, scoreLabel, passWeather, clearSkyFactor } from '../../js/core/weather.js';
import { qualifies, buildSchedule, leadAlertUpdate, localMinutes } from '../../js/core/alerts.js';

// hourly forecast with the same cloud cover all day
const forecast = (cloudPct, from = Date.parse('2026-11-01T00:00:00Z')) => {
  const n = 48, time = Array.from({ length: n }, (_, i) => from + i * 3600e3), all = (v) => time.map(() => v);
  return { time, cloud: all(cloudPct), low: all(cloudPct), mid: all(0), high: all(0), precip: all(0), visibility: all(30000), code: all(3) };
};

const pass = ({ mag = -3.5, sunAlt = -15, duration = 300, el = 60, start = Date.parse('2026-11-01T17:00:00Z') } = {}) => ({
  id: 'p1',
  rise: { t: start - 60e3 }, set: { t: start + duration * 1e3 + 60e3 },
  visible: {
    start: { t: start, az: 270, el: 20 }, max: { t: start + 150e3, az: 0, el }, end: { t: start + duration * 1e3, az: 90, el: 15 },
    minMag: mag, minMagEl: el, duration, sunAlt,
  },
});

test('brightness factor: +2.5 → 0%, linear to 100% at −3.5', () => {
  const b = (mag) => scorePass(pass({ mag }), null).factors.brightness;
  assert.equal(b(3), 0);
  assert.equal(b(2.5), 0);
  assert.equal(Math.round(b(2) * 100), 8);
  assert.equal(Math.round(b(0) * 100), 42);
  assert.equal(Math.round(b(-1.5) * 100), 67);
  assert.equal(b(-3.5), 1);
  assert.equal(b(-5), 1);
});

test('height is not a score factor', () => {
  const low = scorePass(pass({ el: 15 }), null), high = scorePass(pass({ el: 85 }), null);
  assert.equal(low.score, high.score);
  assert.ok(!('height' in low.factors));
});

test('score is the product of the factors', () => {
  const r = scorePass(pass({ mag: -2, sunAlt: -6, duration: 0 }), null);
  const f = r.factors;
  assert.equal(r.score, Math.round(f.brightness * f.darkSky * f.duration * 100));
  assert.equal(f.clearSky, null, 'no forecast: clear sky not applied');
  assert.equal(scorePass(pass(), null).score, 100, 'the ideal pass scores 100');
});

test('score labels', () => {
  assert.equal(scoreLabel(70).label, 'Excellent');
  assert.equal(scoreLabel(45).label, 'Good');
  assert.equal(scoreLabel(25).label, 'Fair');
  assert.equal(scoreLabel(24).label, 'Poor');
});

const settings = { minElevation: 25, minScore: 30, notifyFrom: 0, notifyTo: 1440, leadMinutes: 10, headsUpHours: 2, horizonHours: 48 };

test('qualifies: minimum height and minimum score', () => {
  const ok = pass(); ok.rating = scorePass(ok, null);
  assert.ok(qualifies(ok, settings));
  const low = pass({ el: 20 }); low.rating = scorePass(low, null);
  assert.ok(!qualifies(low, settings), 'below minimum height');
  const dim = pass({ mag: 2 }); dim.rating = scorePass(dim, null);
  assert.ok(!qualifies(dim, settings), 'below minimum score');
});

test('buildSchedule: lead and heads-up alerts inside the booking window', () => {
  const p = pass(); p.rating = scorePass(p, null);
  const now = p.visible.start.t - 5 * 3600e3;
  const alerts = buildSchedule([p], settings, { tz: 'Europe/Prague' }, 'https://example.org/', now);
  assert.deepEqual(alerts.map((a) => a.kind), ['info', 'lead']);
  assert.equal(alerts[1].at, p.visible.start.t - 10 * 60e3);
  assert.equal(alerts[0].at, p.visible.start.t - 2 * 3600e3);
  assert.ok(alerts.every((a) => a.url === 'https://example.org/#pass=p1'));
  // past alert times are not booked
  assert.equal(buildSchedule([p], settings, { tz: 'Europe/Prague' }, 'https://example.org/', p.visible.start.t - 5 * 60e3).length, 0);
});

test('clear-sky factor: forecast during the pass', () => {
  const p = pass();
  assert.equal(scorePass(p, forecast(0)).score, 100);
  const half = scorePass(p, forecast(50));
  assert.equal(half.factors.clearSky, clearSkyFactor(passWeather(forecast(50), [p.visible.start.t, p.visible.max.t, p.visible.end.t])));
  assert.ok(half.score > 35 && half.score < 45, `50% cloud scores about 40: ${half.score}`);
  assert.equal(scorePass(p, forecast(100)).score, 0);
  assert.equal(passWeather(forecast(0, 0), [Date.parse('2030-01-01'), Date.parse('2030-01-01'), Date.parse('2030-01-01')]), null, 'beyond the forecast');
});

test('lead alert carries what is needed to re-score it on arrival', () => {
  const p = pass(); p.rating = scorePass(p, forecast(10));
  const now = p.visible.start.t - 3600e3;
  const [lead] = buildSchedule([p], { ...settings, headsUpHours: 0 }, { tz: 'Europe/Prague' }, 'https://example.org/', now);
  assert.equal(lead.kind, 'lead');
  assert.deepEqual(lead.check.t, [p.visible.start.t, p.visible.max.t, p.visible.end.t]);
  assert.equal(lead.check.score, p.rating.score);
  // re-scoring with the booking-time forecast gives the booked score
  assert.equal(Math.round(lead.check.geo * clearSkyFactor(passWeather(forecast(10), lead.check.t)) * 100), lead.check.score);
});

test('lead alert re-checked at delivery: clouded over vs still clear', () => {
  const p = pass(); p.rating = scorePass(p, forecast(0));
  const [lead] = buildSchedule([p], { ...settings, headsUpHours: 0 }, { tz: 'Europe/Prague' }, 'https://example.org/', p.visible.start.t - 3600e3);
  const clear = leadAlertUpdate(lead, passWeather(forecast(5), lead.check.t), 30);
  assert.equal(clear.title, lead.title, 'still good: title unchanged');
  assert.match(clear.body, /Latest forecast: 5% cloud, score \d+\.$/);
  const cloudy = leadAlertUpdate(lead, passWeather(forecast(90), lead.check.t), 30);
  assert.match(cloudy.title, /^☁️ ISS in 10 min, look W, but 90% cloud now$/);
  assert.match(cloudy.body, /^Clouds moved in since this alert was booked \(score now \d+, was 100\)/);
  assert.ok(cloudy.body.endsWith(lead.body), 'keeps the pass details');
});

test('local time of day in the location\'s time zone', () => {
  const t = Date.parse('2026-11-01T17:00:00Z'); // winter time: UTC+1 in Prague
  assert.equal(localMinutes(t, 'Europe/Prague'), 18 * 60);
  assert.equal(localMinutes(t, 'America/New_York'), 12 * 60);
  assert.equal(localMinutes(Date.parse('2026-07-01T17:00:00Z'), 'Europe/Prague'), 19 * 60, 'summer time: UTC+2');
});

test('qualifies: time-of-day window on when the pass appears', () => {
  const p = pass({ start: Date.parse('2026-11-01T04:30:00Z') }); // 05:30 in Prague
  p.rating = scorePass(p, null);
  const window = (from, to) => qualifies(p, { ...settings, notifyFrom: from, notifyTo: to }, 'Europe/Prague');
  assert.ok(!window(360, 1320), '05:30 is outside the default 06:00-22:00');
  assert.ok(window(300, 1320), 'inside 05:00-22:00');
  assert.ok(window(330, 330), 'window edges are inclusive');
  assert.ok(window(0, 1440), 'any time');
  assert.ok(qualifies(p, { ...settings, notifyFrom: 360, notifyTo: 1320 }, 'Asia/Tokyo'), '13:30 in Tokyo: same pass, other time zone');
});

test('buildSchedule leaves out passes outside the time window', () => {
  const early = pass({ start: Date.parse('2026-11-01T04:30:00Z') }); early.rating = scorePass(early, null); early.id = 'early';
  const evening = pass({ start: Date.parse('2026-11-01T17:00:00Z') }); evening.rating = scorePass(evening, null); evening.id = 'evening';
  const alerts = buildSchedule([early, evening], { ...settings, headsUpHours: 0, notifyFrom: 360, notifyTo: 1320 }, { tz: 'Europe/Prague' }, 'https://example.org/', Date.parse('2026-11-01T00:00:00Z'));
  assert.deepEqual(alerts.map((a) => a.tag), ['evening']);
});

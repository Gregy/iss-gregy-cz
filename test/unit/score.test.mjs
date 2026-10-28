import { test } from 'node:test';
import assert from 'node:assert/strict';
import { scorePass, scoreLabel } from '../../js/core/weather.js';
import { qualifies, buildSchedule } from '../../js/core/alerts.js';

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

const settings = { minElevation: 25, minScore: 30, leadMinutes: 10, headsUpHours: 2, horizonHours: 48 };

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

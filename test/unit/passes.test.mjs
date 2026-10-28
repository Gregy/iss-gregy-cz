import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseTle, makeObserver } from '../../js/core/astro.js';
import { predictPasses } from '../../js/core/passes.js';

// a fixed TLE and observer (Hořice, CZ) keep these tests deterministic
const tle = parseTle(readFileSync(new URL('../fixtures/iss.tle', import.meta.url), 'utf8'));
const obs = makeObserver(50.36, 15.63, 0);
const FROM = Date.parse('2026-10-28T13:00:00Z');

test('predicts passes with sane geometry', () => {
  const passes = predictPasses(tle.satrec, obs, FROM, 72);
  assert.ok(passes.length >= 12, `expected ~4-6 passes a day, got ${passes.length}`);
  for (const p of passes) {
    assert.ok(p.rise.t < p.max.t && p.max.t < p.set.t, 'rise < max < set');
    assert.ok(p.max.el > 0 && p.max.el <= 90);
    assert.ok(p.set.t - p.rise.t < 12 * 60e3, 'a pass lasts under 12 minutes');
  }
});

test('visible windows: every edge is a visible moment with a magnitude', () => {
  const visible = predictPasses(tle.satrec, obs, FROM, 240).filter((p) => p.visible);
  assert.ok(visible.length > 0, 'some visible passes in 10 days');
  for (const p of visible) {
    const v = p.visible;
    assert.ok(v.start.mag != null && v.end.mag != null, `edges of ${new Date(v.start.t).toISOString()} must be sunlit`);
    assert.ok(v.start.el >= 10 - 0.5 && v.end.el >= 10 - 0.5, 'visible part is at least ~10° up');
    assert.ok(v.minMagEl >= 10 - 0.5, 'brightest moment is within the visible part');
    assert.ok(v.duration > 0);
  }
});

test('results do not depend on when the search started', () => {
  const runs = [0, 1537, 7000, 13000, 21000].map((off) => predictPasses(tle.satrec, obs, FROM + off, 240).filter((p) => p.visible));
  const key = (p) => Math.round(p.max.t / 60e3);
  for (const p of runs[0]) {
    for (const run of runs.slice(1)) {
      const q = run.find((x) => key(x) === key(p));
      assert.ok(q, 'same passes found');
      assert.ok(Math.abs(q.visible.minMag - p.visible.minMag) < 0.05, `brightness stable: ${p.visible.minMag} vs ${q.visible.minMag}`);
      assert.ok(Math.abs(q.visible.start.t - p.visible.start.t) < 2000, 'visible start stable to ~1 s');
    }
  }
});

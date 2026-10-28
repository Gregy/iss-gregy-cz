import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extinction, issMagnitude, sunAltAz } from '../../js/core/astro.js';

const near = (actual, expected, tol, msg) => assert.ok(Math.abs(actual - expected) <= tol, `${msg ?? ''} ${actual} ≉ ${expected} ±${tol}`);

test('atmospheric extinction grows towards the horizon', () => {
  near(extinction(90), 0.2, 0.01, 'zenith');
  near(extinction(20), 0.58, 0.03, '20°');
  near(extinction(10), 1.12, 0.05, '10°');
  assert.equal(extinction(0), 0, 'below the horizon nothing is added');
  assert.equal(extinction(-5), 0);
});

test('ISS magnitude: closer and front-lit is brighter', () => {
  near(issMagnitude(420, Math.PI / 2), -3.18, 0.02, 'overhead, side-lit');
  assert.ok(issMagnitude(420, Math.PI / 6) < issMagnitude(420, Math.PI / 2), 'sun behind the observer is brighter');
  assert.ok(issMagnitude(1500, Math.PI / 2) > issMagnitude(420, Math.PI / 2), 'farther is dimmer');
  assert.ok(issMagnitude(420, Math.PI) > 20, 'fully back-lit: invisible');
});

test('sun position: midday high in summer, below the horizon at midnight', () => {
  // Prague
  const noon = sunAltAz(new Date('2026-06-21T11:00:00Z'), 50.08, 14.44).alt;
  near(noon, 63, 1.5, 'summer solstice noon');
  assert.ok(sunAltAz(new Date('2026-06-21T23:00:00Z'), 50.08, 14.44).alt < -10);
});

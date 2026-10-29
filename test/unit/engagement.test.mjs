// Chrome's day boundary is local midnight and the reminder goes out at a local
// hour: pin the zone so the expectations hold anywhere.
process.env.TZ = 'Europe/Prague';

import { test } from 'node:test';
import assert from 'node:assert/strict';
const { addPoints, launched, decayed, total, crossing, nudgeTime, P, THRESHOLD, NUDGE_HOUR } = await import('../../js/core/engagement.js');

const H = 3600e3, D = 86400e3;
const t0 = new Date(2026, 10, 2, 12, 0).getTime(); // Mon 2 Nov 2026, 12:00 local
const close = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-9, `${msg ?? ''} ${a} ≠ ${b}`);

test('first engagement of the day earns the daily bonus, later ones do not', () => {
  let st = addPoints(null, P.notification, t0);
  close(st.raw, 2.5);
  st = addPoints(st, P.input, t0 + H);
  close(st.raw, 3.1, 'same day, within the first decay period after the last event');
  st = addPoints(st, P.notification, t0 + D); // next day: decay committed, bonus again
  close(st.raw, 3.1 * P.decay ** 11 + 2.5); // 23 h after the last event: 11 periods
});

test('no more than 15 points a day', () => {
  let st = null;
  for (let i = 0; i < 40; i++) st = addPoints(st, P.input, t0 + i * 11e3);
  close(st.raw, 15);
  close(st.today, 15);
  st = addPoints(st, P.input, new Date(2026, 10, 3, 0, 1).getTime()); // after local midnight
  close(st.today, 2.1);
});

test('decay: ×0.984 per whole 2 h since the last engagement (whole hours, truncated)', () => {
  const st = addPoints(null, P.notification, t0);
  close(decayed(st, t0 + 2 * H - 1), 2.5);
  close(decayed(st, t0 + 2 * H), 2.5 * 0.984);
  close(decayed(st, t0 + 3 * H + 59 * 60e3), 2.5 * 0.984);
  close(decayed(st, t0 + 7 * D), 2.5 * 0.984 ** 84);
});

test('launch from the icon adds 5 for 10 whole days', () => {
  const st = launched(addPoints(null, P.input, t0), t0);
  close(total(st, t0), 7.1);
  close(total(st, t0 + 10 * D + 23 * H) - decayed(st, t0 + 10 * D + 23 * H), 5, 'day 10.96 still counts');
  close(total(st, t0 + 11 * D), decayed(st, t0 + 11 * D), 'gone on day 11');
});

test('scores that sank to 0.5 are deleted, so the next engagement starts from zero', () => {
  const st = addPoints(null, P.notification, t0);
  const later = t0 + 40 * D;
  assert.ok(total(st, later) <= P.cleanup);
  close(addPoints(st, P.notification, later).raw, 2.5);
});

test('crossing: first moment the score is below the threshold', () => {
  const st = addPoints(null, P.notification, t0); // 2.5
  const t = crossing(st, t0);
  // 2.5 · 0.984^k < 1 first at k = 57 periods
  assert.equal(t, t0 + 57 * 2 * H);
  assert.ok(total(st, t - 1) >= THRESHOLD && total(st, t) < THRESHOLD);
  assert.equal(crossing(null, t0), t0);
  // the launch bonus holds the score up until it ends
  const l = launched(st, t0);
  assert.equal(crossing(l, t0), t0 + 11 * D);
});

test('reminder: the last 19:00 before the crossing, never in the past, none after an ignored one', () => {
  const st = addPoints(null, P.notification, t0);
  const cross = crossing(st, t0); // Sat 7 Nov 06:00
  const at = nudgeTime(st, t0);
  assert.equal(new Date(at).getHours(), NUDGE_HOUR);
  assert.ok(at < cross && cross - at < D);
  assert.equal(new Date(at).getDate(), 6);

  // already below: today's 19:00, or tomorrow's when that is past
  const low = addPoints(null, P.input, t0 - 30 * D);
  assert.equal(nudgeTime(low, t0), new Date(2026, 10, 2, NUDGE_HOUR).getTime());
  assert.equal(nudgeTime(low, new Date(2026, 10, 2, 20).getTime()), new Date(2026, 10, 3, NUDGE_HOUR).getTime());

  // shown and not tapped: stop; any engagement afterwards resumes
  assert.equal(nudgeTime(st, at + H, { shown: at }), null);
  assert.ok(nudgeTime(addPoints(st, P.notification, at + 2 * H), at + 2 * H, { shown: at }) > at);
});

test('with reminder taps as the only engagement the score stays at or above 1, reminders 4–7 days apart', () => {
  let st = addPoints(null, P.notification, t0);
  let now = t0;
  const gaps = [];
  for (let i = 0; i < 30; i++) {
    const at = nudgeTime(st, now);
    for (let t = now; t < at; t += H) assert.ok(total(st, t) >= THRESHOLD, `score fell below 1 before reminder ${i}`);
    gaps.push((at - now) / D);
    st = addPoints(st, P.notification, at); // tapped when it arrives
    now = at;
  }
  const steady = gaps.slice(3);
  assert.ok(Math.min(...gaps) >= 4 && Math.max(...gaps) <= 7, gaps.map((g) => g.toFixed(1)).join(' '));
  assert.ok(steady.every((g) => g >= 5), `steady state ${steady.map((g) => g.toFixed(1)).join(' ')}`);
});

// Does the app's estimate of Chrome's site engagement (js/core/engagement.js)
// match what Chrome itself records? Runs real Chromium on a profile of its
// own and compares, field by field, Chrome's stored score (the profile's
// Preferences file) with the model and with the estimate the app kept.
//
//   1. Inputs: open the app, tap and press keys at set times. Chrome only
//      counts input from 10 s after the page loads and then once per 10 s;
//      the app must count exactly the same ones.
//   2. Days pass: with the browser closed, move Chrome's and the app's last
//      engagement back by a day and some hours, open chrome://site-engagement
//      and check the decayed score Chrome shows against the model.
//   3. Next day: open the app again and tap: the decay is committed, the
//      first-engagement-of-the-day bonus is added, in Chrome and in the app.
//   4. Weeks pass: Chrome deletes a score that sank to 0.5; so does the model.
//
// Navigation points: Chrome adds 1.5 for a typed navigation (what the test's
// page.goto is) but not for links or notification opens, so the app never
// counts them; the test adds them to the model's prediction for Chrome only.
//
// Not covered (no automation hook): notification clicks (+1) and launches of
// the installed app (+5 bonus). See README for checking those on a phone.
//
// Run: npm run test:engagement   (about 1.5 minutes)
process.env.TZ ||= 'Europe/Prague'; // Chrome's and the model's "day" must be the same one
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from './server.mjs';
const { addPoints, decayed, total, P } = await import('../../js/core/engagement.js');

const server = await startServer();
const origin = `http://127.0.0.2:${server.address().port}`;
const profile = mkdtempSync(join(tmpdir(), 'iss-engagement-'));
const prefsFile = join(profile, 'Default', 'Preferences');
const NAV = 1.5; // Chrome: navigation_points
let failures = 0;

// Chrome's internal time: microseconds since 1601-01-01 UTC
const toInternal = (ms) => (ms + 11644473600000) * 1000;
const fromInternal = (us) => us / 1000 - 11644473600000;

function check(label, actual, expected, tol = 0.001) {
  const ok = Math.abs(actual - expected) <= tol;
  if (!ok) failures++;
  console.log(`${ok ? '✔' : '✖'} ${label}: Chrome/app ${actual.toFixed(4)}, expected ${expected.toFixed(4)}`);
}

let port = 9400 + Math.floor(Math.random() * 500);
async function launch() {
  port++;
  const proc = spawn(chromium.executablePath(), [
    '--headless=new', '--no-sandbox', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore', env: { ...process.env } });
  for (let i = 0; i < 50; i++) {
    try { return { proc, browser: await chromium.connectOverCDP(`http://127.0.0.1:${port}`) }; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  throw new Error('Chromium did not start');
}
async function close({ proc, browser }) {
  // a connected browser.close() only disconnects; Browser.close quits, and Chrome writes Preferences on the way out
  await (await browser.newBrowserCDPSession()).send('Browser.close').catch(() => {});
  await new Promise((r) => (proc.exitCode != null ? r() : proc.once('exit', r)));
}

const readChrome = () => {
  const s = JSON.parse(readFileSync(prefsFile, 'utf8')).profile?.content_settings?.exceptions?.site_engagement?.[`${origin},*`]?.setting;
  return s && { raw: s.rawScore, today: s.pointsAddedToday, last: fromInternal(s.lastEngagementTime), launch: s.lastShortcutLaunchTime ? fromInternal(s.lastShortcutLaunchTime) : 0 };
};
const shiftChrome = (ms) => {
  const prefs = JSON.parse(readFileSync(prefsFile, 'utf8'));
  const s = prefs.profile.content_settings.exceptions.site_engagement[`${origin},*`].setting;
  s.lastEngagementTime = toInternal(fromInternal(s.lastEngagementTime) - ms);
  writeFileSync(prefsFile, JSON.stringify(prefs));
};

const appState = (page) => page.evaluate(async () => (await import('./js/core/store.js')).get('engagement'));
const shiftApp = (page, ms) => page.evaluate(async (ms) => {
  const store = await import('./js/core/store.js');
  const st = await store.get('engagement');
  await store.set('engagement', { ...st, last: st.last - ms });
}, ms);

/** Open the app, then input at the given seconds after load; returns what each side should have added. */
async function session(page, plan) {
  await page.goto(origin + '/');
  const loaded = Date.now();
  const events = [{ t: loaded, points: NAV, chromeOnly: true }];
  let pausedUntil = loaded + 10e3; // Chrome: tracking starts 10 s after the navigation
  for (const { at, key } of plan) {
    await page.waitForTimeout(Math.max(0, loaded + at * 1e3 - Date.now()));
    const t = Date.now();
    if (key) await page.keyboard.press('Shift'); else await page.mouse.click(640, 500);
    if (t >= pausedUntil) { events.push({ t, points: P.input }); pausedUntil = t + 10e3; }
  }
  await page.waitForTimeout(500);
  return events;
}
const replay = (st, events, chrome) => events.filter((e) => chrome || !e.chromeOnly).reduce((s, e) => addPoints(s, e.points, e.t), st);

try {
  // ---- 1. inputs
  let b = await launch();
  let page = await b.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  // 3 s: too early · 11 s: counts · 14 s: paused · 22 s: counts · 25 s: paused · 33 s: key, counts
  const ev1 = await session(page, [{ at: 3 }, { at: 11 }, { at: 14 }, { at: 22 }, { at: 25, key: true }, { at: 33, key: true }]);
  const app1 = await appState(page);
  console.log(`\n1. inputs (${ev1.length - 1} should count)`);
  const SHIFT = 86400e3 + 5 * 3600e3 + 20 * 60e3; // 1 day 5 h 20 min
  await shiftApp(page, SHIFT);
  await close(b);
  const chrome1 = readChrome();
  const model1 = replay(null, ev1, true);
  check('Chrome raw score', chrome1.raw, model1.raw);
  check('Chrome points today', chrome1.today, model1.today);
  check('app raw score (no navigation points)', app1?.raw ?? NaN, replay(null, ev1, false).raw);
  check('app counts the same inputs', (app1?.raw ?? NaN) + NAV, chrome1.raw);

  // ---- 2. a day passes
  shiftChrome(SHIFT);
  const chrome2 = readChrome();
  b = await launch();
  page = await b.browser.contexts()[0].newPage();
  await page.goto('chrome://site-engagement');
  const shown = await page.waitForFunction((o) => {
    const rows = document.querySelector('site-engagement-app')?.shadowRoot?.querySelectorAll('#engagement-table-body tr') || [];
    const row = [...rows].find((r) => r.querySelector('.origin-cell')?.textContent.startsWith(o));
    return row && Number(row.querySelector('.base-score-input').value);
  }, origin).then((h) => h.jsonValue());
  console.log('\n2. a day later');
  check('decayed score Chrome shows', shown, decayed(chrome2, Date.now()), 0.01);
  await close(b);

  // ---- 3. the next day's first engagement
  b = await launch();
  page = await b.browser.contexts()[0].newPage();
  await page.setViewportSize({ width: 1280, height: 800 });
  const app2 = { ...app1, last: app1.last - SHIFT }; // what the app stored, moved back with Chrome's
  const ev3 = await session(page, [{ at: 11 }]);
  const app3 = await appState(page);
  await close(b);
  const chrome3 = readChrome();
  console.log('\n3. next day: decay committed, first-of-day bonus');
  check('Chrome raw score', chrome3.raw, replay(chrome2, ev3, true).raw);
  check('Chrome points today', chrome3.today, replay(chrome2, ev3, true).today);
  check('app raw score', app3?.raw ?? NaN, replay(app2, ev3, false).raw);

  // ---- 4. weeks pass
  shiftChrome(30 * 86400e3);
  const chrome4 = readChrome();
  b = await launch();
  // the engagement service starts with the first page that needs it and cleans up shortly after
  await (await b.browser.contexts()[0].newPage()).goto('chrome://site-engagement');
  await new Promise((r) => setTimeout(r, 3000));
  await close(b);
  console.log('\n4. a month later');
  const gone = !readChrome();
  if (!gone) failures++;
  console.log(`${gone ? '✔' : '✖'} Chrome deleted the score; model: ${total(chrome4, Date.now()).toFixed(3)} (deleted at ≤ ${P.cleanup})`);
} finally {
  server.close();
  rmSync(profile, { recursive: true, force: true });
}

console.log(failures ? `\n✖ ${failures} check(s) failed` : '\n✔ the estimate matches Chrome');
process.exit(failures ? 1 : 0);

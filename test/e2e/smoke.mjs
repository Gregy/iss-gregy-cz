// Browser smoke test: boots the app as a user would (location, live ISS,
// passes, alerts, about), then checks offline start and the update path from
// one version to the next through the service worker.
// Run: node test/e2e/smoke.mjs   (needs `npm install` and `npx playwright install chromium`)
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';
import { startServer } from './server.mjs';

const VERSION = readFileSync(new URL('../../js/config.js', import.meta.url), 'utf8').match(/APP_VERSION = '([^']+)'/)[1];
const server = await startServer();
// 127.0.0.2 is a secure context like localhost, but the service worker treats
// it as production (its localhost shortcut only covers localhost/127.0.0.1)
const origin = `http://127.0.0.2:${server.address().port}`;
// let context.route() see the service worker's own requests (weather fetched on push)
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = '1';
// full Chromium (new headless): the lightweight headless shell always denies notifications
const browser = await chromium.launch({ channel: 'chromium' });
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 }, locale: 'en-GB', timezoneId: 'Europe/Prague',
  geolocation: { latitude: 50.36, longitude: 15.63 }, permissions: ['geolocation', 'notifications'],
});
// No third-party services: geocoding, imagery and other TLE sources are
// unavailable. Weather is unavailable too, unless a test sets `cloudCover`.
let cloudCover = null;
const weatherHits = [];
await ctx.route((url) => !url.href.startsWith(origin), (route) => {
  const url = route.request().url();
  if (cloudCover == null || !url.startsWith('https://api.open-meteo.com/')) return route.abort();
  weatherHits.push(url);
  const t0 = Math.floor(Date.now() / 3600e3) * 3600 - 3600, n = 48;
  const time = Array.from({ length: n }, (_, i) => t0 + i * 3600), all = (v) => time.map(() => v);
  return route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ timezone: 'Europe/Prague', hourly: {
      time, cloud_cover: all(cloudCover), cloud_cover_low: all(cloudCover), cloud_cover_mid: all(0), cloud_cover_high: all(0),
      precipitation_probability: all(0), visibility: all(30000), weather_code: all(3),
    } }),
  });
});

const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|net::/.test(m.text())) errors.push(`console: ${m.text()}`);
});

let failed = 0;
async function step(name, fn) {
  const t = Date.now();
  try {
    await fn();
    if (errors.length) throw new Error(errors.splice(0).join('\n'));
    console.log(`  ✔ ${name} (${Date.now() - t} ms)`);
  } catch (e) {
    failed++;
    console.log(`  ✖ ${name}\n    ${String(e.message || e).split('\n').join('\n    ')}`);
  }
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };
const liveStats = () => page.evaluate(() => ['sLat', 'sLon', 'sAlt'].map((id) => document.getElementById(id).textContent));
const waitLive = () => page.waitForFunction(() => document.getElementById('sLat').textContent !== '–' && document.querySelector('.iss-icon'), null, { timeout: 15000 });

await step('first visit: nothing asked unprompted, notifications need a location', async () => {
  await page.goto(origin + '/');
  await page.waitForSelector('.iss-icon', { timeout: 15000 });
  expect(!(await page.evaluate(() => document.getElementById('locDialog').open)), 'location dialog not opened by itself');
  expect((await page.textContent('#locName')) === 'Set your location', 'badge asks for a location');
  await page.goto(origin + '/#alerts');
  await page.waitForFunction(() => document.getElementById('pushEnabled').disabled, null, { timeout: 5000 });
  expect((await page.textContent('#pushStatus')).includes('Set your location first'), 'status explains why');
});

await step('set location from the badge, live ISS position', async () => {
  await page.goto(origin + '/');
  await page.click('#locBtn');
  await page.click('#geoBtn');
  await waitLive();
  const [lat, lon, alt] = await liveStats();
  expect(/°[NS]$/.test(lat) && /°[EW]$/.test(lon), `lat/lon shown: ${lat} ${lon}`);
  const km = parseFloat(alt);
  expect(km > 350 && km < 460, `ISS altitude plausible: ${alt}`);
  expect((await page.textContent('#locName')) !== 'Set your location', 'badge shows the place');
  await page.goto(origin + '/#alerts');
  await page.waitForFunction(() => !document.getElementById('pushEnabled').disabled, null, { timeout: 5000 });
});

await step('visible passes listed with scores', async () => {
  await page.goto(origin + '/#passes');
  await page.waitForSelector('#passList .pass', { timeout: 15000 }).catch(async (e) => {
    throw new Error(`${e.message.split('\n')[0]}\n    pass list says: ${await page.textContent('#passList')}`);
  });
  await page.click('#passList .pass summary');
  const factors = await page.$eval('.pass[open] .factors', (e) => e.innerText);
  expect(/Brightness/.test(factors) && /Duration/.test(factors) && !/Height/.test(factors), `factor rows: ${factors}`);
});

await step('alerts settings bound to their defaults', async () => {
  await page.goto(origin + '/#alerts');
  const v = await page.evaluate(() => ['minElevation', 'minScore', 'leadMinutes', 'headsUpHours', 'horizonHours'].map((id) => document.getElementById(id).value));
  expect(JSON.stringify(v) === JSON.stringify(['25', '30', '10', '0', '48']), `settings: ${v}`);
  expect((await page.textContent('#criteriaPreview')).includes('visible passes'), 'criteria preview rendered');
});

await step('about page shows the version', async () => {
  await page.goto(origin + '/#about');
  expect((await page.textContent('#appVersion')) === VERSION, 'version');
  await page.click('details.log summary >> text=Background check log');
  expect(await page.isVisible('#logEmpty'), 'empty check log explained');
  expect((await page.$$('#logList li')).length === 0, 'no placeholder entries in the log list');
});

await step('works offline once installed', async () => {
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload();
  await page.waitForFunction(() => !!navigator.serviceWorker.controller);
  await ctx.setOffline(true);
  await page.goto(origin + '/#live');
  await waitLive();
  await ctx.setOffline(false);
});

await step('"look up now" alert re-checks the clouds before showing', async () => {
  cloudCover = 90;
  const cdp = await ctx.newCDPSession(page);
  const registered = new Promise((resolve) => cdp.on('ServiceWorker.workerRegistrationUpdated', ({ registrations }) => {
    const r = registrations.find((x) => x.scopeURL.startsWith(origin) && !x.isDeleted);
    if (r) resolve(r.registrationId);
  }));
  await cdp.send('ServiceWorker.enable');
  const registrationId = await registered;
  const start = Date.now() + 10 * 60e3;
  const alert = {
    title: '🛰️ ISS in 10 min, look W', body: 'Appears 18:00 in the W.\nmag -3.0 · clouds 10% · score 80', tag: 'e2e-pass', url: origin + '/#pass=e2e-pass',
    kind: 'lead', check: { t: [start, start + 150e3, start + 300e3], geo: 0.9, score: 80 },
  };
  // push "on" (but not subscribed) so the re-sync that follows every alert leaves a trace
  await page.evaluate(async () => (await import('/js/core/store.js')).saveSettings({ pushEnabled: true }));
  await cdp.send('ServiceWorker.deliverPushMessage', { origin, registrationId, data: JSON.stringify(alert) });
  let shown;
  for (let i = 0; i < 50 && !shown; i++) {
    shown = await page.evaluate(async () => {
      const [n] = await (await navigator.serviceWorker.ready).getNotifications({ tag: 'e2e-pass' });
      return n && { title: n.title, body: n.body };
    });
    if (!shown) await page.waitForTimeout(200);
  }
  expect(shown, 'notification shown');
  expect(weatherHits.length > 0, `fresh forecast fetched (shown: ${shown.title})`);
  expect(shown.title === '☁️ ISS in 10 min, look W, but 90% cloud now', `title: ${shown.title}`);
  expect(shown.body.startsWith('Clouds moved in since this alert was booked'), `body: ${shown.body}`);
  let check;
  for (let i = 0; i < 25 && check?.source !== 'push'; i++) {
    await page.waitForTimeout(200);
    check = await page.evaluate(async () => (await import('/js/core/store.js')).get('lastCheck'));
  }
  expect(check?.source === 'push' && check.skipped === 'not subscribed', `re-sync after the alert: ${JSON.stringify(check)}`);
  await page.evaluate(async () => {
    (await import('/js/core/store.js')).saveSettings({ pushEnabled: false });
    (await (await navigator.serviceWorker.ready).getNotifications()).forEach((n) => n.close());
  });
  cloudCover = null;
});

await step('updates cleanly to the next version (no mixed files)', async () => {
  server.next = true;
  await page.reload();
  // the new service worker installs, takes over and the page reloads itself onto it
  await page.waitForFunction(() => document.querySelector('meta[name="test-build"]')?.content === 'next', null, { timeout: 20000 });
  await page.waitForLoadState('load');
  await waitLive();
  await page.goto(origin + '/#alerts');
  expect((await page.textContent('#criteriaPreviewNext')).length > 0, 'renamed element rendered by the new app.js');
  expect((await page.textContent('#appVersion')) === `${VERSION}-next`, 'new version running');
  const caches = await page.evaluate(() => caches.keys());
  expect(!caches.some((k) => k.startsWith('shell-') && !k.endsWith('-next')), `old shell cache removed: ${caches}`);
});

await browser.close();
server.close();
if (failed) { console.log(`\n${failed} browser check(s) failed`); process.exit(1); }

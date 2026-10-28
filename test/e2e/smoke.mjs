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
const browser = await chromium.launch();
const ctx = await browser.newContext({
  viewport: { width: 1280, height: 800 }, locale: 'en-GB', timezoneId: 'Europe/Prague',
  geolocation: { latitude: 50.36, longitude: 15.63 }, permissions: ['geolocation'],
});
// no third-party services: weather, geocoding, imagery and other TLE sources are unavailable
await ctx.route((url) => !url.href.startsWith(origin), (route) => route.abort());

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

await step('first visit: set location, live ISS position', async () => {
  await page.goto(origin + '/');
  await page.click('#geoBtn');
  await waitLive();
  const [lat, lon, alt] = await liveStats();
  expect(/°[NS]$/.test(lat) && /°[EW]$/.test(lon), `lat/lon shown: ${lat} ${lon}`);
  const km = parseFloat(alt);
  expect(km > 350 && km < 460, `ISS altitude plausible: ${alt}`);
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

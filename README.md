# ISS Pass Tracker (PWA)

Live ISS position, visible-pass predictions scored by **weather + sky darkness + geometry**, and push alerts for good passes. The app is a static site with no build step and runs on GitHub Pages. Push alerts go through a small relay running on Cloudflare Workers' free plan. The relay holds no keys and can't read the notifications.

**Live at [iss.gregy.cz](https://iss.gregy.cz)** (relay: `push.iss.gregy.cz`).

## Features

- **Live map**: ISS position, ground track (yellow = sunlit, blue = in Earth's shadow), the area it can be seen from, and your location. The day side shows NASA Blue Marble and the night side Black Marble city lights, blended across twilight using the sun's real position.
- **Where to look now**: azimuth/elevation from your location, plus whether the ISS is visible right now (sunlit, dark sky, high enough).
- **Visible passes (10 days)**: sky chart for each pass, appear/peak/vanish times and directions, estimated brightness, and a 0–100 **score**:
  brightness × sky darkness × duration × **clear sky** (Open-Meteo low/mid/high cloud + rain probability).
- **Push alerts** for passes that meet your criteria (minimum height, minimum score, time of day). They arrive at an exact time *N* minutes before the pass, with an optional heads-up a few hours earlier, even when the app is closed.
- **Works offline**: app shell, map tiles, orbit data and forecast are cached.

### How push works
A static site can't send Web Push on its own: something has to be awake at the moment a notification is due. That something is the **push relay** in [`worker/`](worker/), a Cloudflare Worker that fits the free plan. It's a dumb "POST these bytes to this URL at time T" service. The phone does everything else:

```
phone (PWA)                                         Cloudflare Worker + D1               browser push service
───────────                                         ──────────────────────               ────────────────────
predict passes, check weather, score
for each alert:
  encrypt payload to own subscription (RFC 8291)
  sign VAPID token with own device key (RFC 8292),
    exp = alert time + 1 h
→ complete list of sealed requests    ──PUT──▶  store; replaces all future alerts
                                                cron, every minute: POST what's due ──▶ FCM / Mozilla / Apple ──▶ notification
```

- **The relay holds no secrets and can't read anything.** Each device generates its own VAPID key pair; the private key is a non-extractable WebCrypto key in IndexedDB. Notifications are end-to-end encrypted to the browser. The relay never sees a location.
- **Pre-signed tokens work** because push services only require a VAPID token's `exp` to be at most 24 h after the moment it is *sent*. A token prepared days ahead is valid when the relay sends it at the alert time.
- Every sync uploads the **complete** list, so a pass that clouds over is cancelled exactly; nothing is sent.
- **At-most-once delivery:** the cron claims rows before sending. A crash, timeout or overlapping run can lose an alert, never duplicate it. Only explicit 429/5xx answers are retried. Alerts more than 10 minutes late are dropped.
- Delivery is within ±30 s of the booked time.
- The schedule is re-synced whenever the app is opened, whenever an alert arrives (the service worker is awake anyway: a heads-up thus refreshes the later "look up now" alert, or cancels it), and in the background via Periodic Background Sync when the app is installed in Chrome or Edge (about once a day; see [Background refresh and site engagement](#background-refresh-and-site-engagement)). The booking window ("Book alerts up to") is at least 48 h so one late or skipped refresh doesn't leave a gap.
- A "look up now" alert carries its pass's times and score factors. On arrival the service worker fetches a fresh forecast (4 s at most) and re-scores the pass: if it has dropped below your minimum score the notification says the clouds moved in, otherwise it adds the latest cloud cover. It can't be suppressed: browsers require every push to show a notification, which also rules out silent "wake up and refresh" pushes.

**Multiple users.** Each browser subscription is one user, with no accounts. Rows are keyed by subscription, so one user's uploads can never touch another's. The subscription's `auth` secret acts as its password: only its hash is stored, and changes need the same secret. The relay protects itself with:
- only POSTing to known push services (FCM, Mozilla, Apple, Windows);
- a per-IP rate limit on writes;
- a cap on total subscriptions (`MAX_SUBSCRIPTIONS`);
- per-subscription limits (60 alerts, 4 KB each);
- fair batching (at most 3 messages per subscription per cron run).

### Background refresh and site engagement

Periodic Background Sync exists only in Chromium browsers (Chrome, Edge, Samsung Internet…) and only for installed apps. Firefox and every iOS browser don't have it; there the schedule is renewed only when the app is opened or an alert arrives.

Chrome doesn't honour the requested interval. How often it fires depends on the site's **engagement score** ([design doc](https://www.chromium.org/developers/design-documents/site-engagement/)). Values below are Chromium's defaults, read from the source (`components/site_engagement/content/site_engagement_score.cc`, `chrome/browser/background_sync/background_sync_delegate_impl.{h,cc}`, `content/public/browser/background_sync_parameters.cc`):

**The score** (per site, 0–100), as `SiteEngagementScore` computes it:

| Event | Points |
|---|---|
| first engagement of the day (local midnight) | +1.5, added to that engagement |
| navigation the user starts: typed URL, bookmark, launching the installed app. Not links, not windows opened by a notification click | +1.5 |
| user input: key down, mouse down, touch start, scroll start. Counted from 10 s after the page loads (5 s after it becomes visible again), then at most once per 10 s | +0.6 |
| click on one of the site's notifications | +1 |
| visible / hidden media playback | +0.06 / +0.01 |
| daily maximum | 15 |
| installed-app bonus: app launched from its icon within the last 10 whole days | +5 (added on read, not stored) |

Every whole 2 hours since the last engagement multiply the stored score by 0.984 (about −18 % a day, a half-life of about 3.6 days); each new engagement commits the decay so far and restarts the count. Scores at or below 0.5 are deleted when Chrome next cleans up (shortly after it starts). If the browser isn't used *at all* for 9 h or more, Chrome shifts every site's last-engagement time so that at most 8 h of that gap decays (so a phone in a drawer doesn't lose its scores).

Who gets the +5 launch bonus (`SetLastShortcutLaunchTime`):
- **Android:** only a WebAPK launched from the home screen or app drawer. A notification click does open the installed app (Chrome routes in-scope URLs to it), but the launch is tagged as coming from a notification and earns no bonus. Manifest shortcuts and other intents don't count either.
- **Desktop:** launching the app from the OS, and navigations Chrome captures into the app window ("open supported links").

**What the score does to background refresh.** The interval is Chrome's minimum of 12 h times a penalty (the app's own `minInterval` of 6 h is overridden):

| Engagement level | Score | Background refresh |
|---|---|---|
| none | 0 (deleted) | suspended until the score rises again |
| minimal | above 0, below 1 | every 36 h |
| low / medium | 1 to under 50 | every 24 h |
| high / max | 50 and more | every 12 h |

**In practice.** An app launched from its icon within the last 10 days has at least the +5 bonus, so it refreshes about once a day; reaching "high" takes near-maximum use every day, so assume 24 h. Not opened for more than 10 days, the bonus lapses and the score decays: a day of normal use is gone in roughly 2–3 weeks, after which Chrome stops waking the app. Arriving alerts keep re-booking the next 48 h regardless, so without the reminder below, alerts would stop only if both happen: weeks without opening the app and more than 48 h without any alert (e.g. a cloudy spell). Opening the app once restarts everything.

Hence the 48 h minimum booking window: a daily refresh renews it with a day to spare; a 24 h window would lapse after a single late refresh.

### Keeping the score up: the "still interested?" reminder

The page can't read the score, so the app estimates it (`js/core/engagement.js`) by replaying Chrome's formula above over the engagement it can see:

| Recorded | Where | Counted as |
|---|---|---|
| taps and key presses, with Chrome's 10 s start delay and 10 s pause | page (`trackInput`) | +0.6 each |
| click on any of the app's notifications | service worker, `notificationclick` | +1 |
| launch from the app icon: `start_url` carries `?from=icon`, the page is in standalone mode | page, at load | the +5 bonus for 10 days |
| first engagement of the day, daily cap, decay, deletion at 0.5 | model | as Chrome |

It deliberately leaves out what it can't be sure Chrome counts: navigation points (which transition a launch or notification open gets isn't visible to the page), scrolling without a touch, media, and the 9 h inactivity rebase. So the estimate errs low, and a reminder may come early but not late. The estimate stays on the device in IndexedDB, under `engagement`.

**The reminder.** On each scheduling run (app open, arriving alert, background refresh), if Chrome's background refresh is registered for the app, `plannedNudge()` finds when the estimated score would fall below 1 (from "low" to "minimal", where the refresh interval stretches to 36 h). It then books a notification for 19:00 local time on the last day before that: *"Still want ISS pass alerts? Tap to keep them coming…"*. It goes to the relay like any alert, encrypted, so the relay sees an ordinary `info` alert; the payload's `kind: 'nudge'` is only visible on the phone. It is booked at most 7 days ahead (the relay's limit is 8), and later runs push it out as engagement comes in.
- **Tapped:** +1 point, plus +1.5 as the day's first engagement. The app opens on the Alerts tab and re-books, which moves the next reminder out.
- **Ignored:** the service worker notes when a reminder arrived. Until some engagement is recorded after that, no further reminder is booked, so the app never nags. Chrome eventually pauses background refresh. Opening the app, or tapping any alert, starts the cycle again.
- **Firefox, iPhone, or no background refresh registered:** no reminders; there is no engagement-gated refresh to keep alive.

**How often**, if reminder taps were the only engagement: the first after 4 days, then every 6 days, with the score never below 1.15. Any app use or alert tap pushes them further out.

**Verifying the estimate against Chrome.**
- `npm test` covers the model alone: daily bonus and cap, decay steps, the launch bonus window, deletion, reminder timing and cadence.
- `npm run test:engagement` (about 1.5 minutes) runs real Chromium on a throwaway profile. It reads Chrome's own stored score from the profile's `Preferences` file and compares it field by field with the model and with the app's stored estimate:
  1. taps and key presses at set times: the app counts exactly the inputs Chrome counts;
  2. the stored timestamps moved back a day: the decayed score `chrome://site-engagement` shows matches the model;
  3. the next day's first tap: committed decay and the daily bonus agree;
  4. a month later: Chrome has deleted the score, as the model predicts.
- **On a phone**, for what can't be automated (notification clicks, launches from the icon): About → App status shows the estimate (Chromium only). Compare it with `chrome://site-engagement` in Chrome on the same phone; Chrome's number should be equal or higher (it also counts navigations).

## How it works

Everything is computed on-device:

- **Orbit**: SGP4 ([satellite.js](https://github.com/shashwatak/satellite-js)) from the ISS TLE. Sources tried in order: `data/iss.tle` (refreshed every 6 h by the deploy workflow), CelesTrak, then tle.ivanstanojevic.me. Cached for 8 h.
- **Passes**: 30 s coarse scan, then bisection to about 1 s for rise and set, golden-section search for culmination. Each pass is sampled every 10 s.
  Visible = ISS sunlit (Earth-shadow test) **and** sun below −6° at the observer **and** ISS ≥ 10° above the horizon.
- **Brightness**: diffuse-sphere phase model, standard magnitude −1.3 at 1000 km (an estimate), plus atmospheric extinction of 0.2 mag per airmass (Kasten & Young). Height isn't scored separately: it counts through distance and extinction.
- **Weather**: [Open-Meteo](https://open-meteo.com) hourly cloud layers, interpolated across the visible window. High (cirrus) cloud is weighted at 45%, since a −3 mag ISS usually shows through it.

Verified against [Skyfield](https://rhodesmill.org/skyfield/) with the same TLE (Prague, 3 days, 18 passes): rise/culmination/set within about 1 s, identical max elevation, sun position within 0.004°.

```
js/core/   astro.js (sun, shadow, magnitude) · passes.js · weather.js (fetch + score) · tle.js
           alerts.js (schedule builder, shared by page + service worker) · push.js (device key, relay client) · store.js (IndexedDB)
           engagement.js (estimate of Chrome's site engagement, "still interested?" reminder)
js/ui/     map.js (Leaflet) · skychart.js (SVG polar plot)
js/app.js  UI controller      sw.js  offline cache · push display · periodic re-sync · subscription renewal
js/config.js                  relay URL (set by the Pages workflow)
js/core/webpush.js            RFC 8291 encryption + RFC 8292 VAPID signing on WebCrypto (runs on the phone)
worker/    push relay: src/index.js (API + cron, no crypto), migrations/ (D1 schema), test/ (unit + end-to-end tests)
```

## Deploy

### 1. Push relay (Cloudflare Worker, free plan)
```sh
cd worker
npm install
npx wrangler login                     # opens the browser
npx wrangler d1 create iss-push        # copy the database_id into wrangler.toml
```
In `wrangler.toml`, set `ALLOWED_ORIGINS` to the app's origin and `routes` to the relay's hostname. This repo is set up for `https://iss.gregy.cz` and `push.iss.gregy.cz` as a Workers Custom Domain, which needs the zone on the same Cloudflare account; Cloudflare creates the DNS record and certificate. Without your own domain, remove `routes` and `workers_dev = false` to get `https://iss-push.<subdomain>.workers.dev`. Then:
```sh
npx wrangler d1 migrations apply iss-push --remote
npx wrangler deploy
```
Cron triggers need the account to have a `workers.dev` subdomain even when the worker doesn't use it: opening **Workers & Pages** in the dashboard once creates one. New cron triggers can take a few minutes to start.

There are no keys to generate or secrets to store. The `[[ratelimits]]` block works on the free plan; if your account doesn't offer it, remove the block and the worker skips the check.

To deploy automatically on push instead, add repo secrets `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers" plus D1 edit) and `CLOUDFLARE_ACCOUNT_ID`. The `Push relay` workflow tests the relay, then applies migrations and deploys it.

### 2. App (GitHub Pages)
1. Push this repo to GitHub (branch `main`).
2. The relay URL is `PUSH_SERVER` in `js/config.js` (fixed; users can't change it).
3. **Settings → Pages → Source: GitHub Actions.**
4. The `Deploy to GitHub Pages` workflow publishes on every push and every 6 h. Each run runs the unit tests and refreshes `data/iss.tle`.
   GitHub disables scheduled workflows after 60 days without repo activity. The app still works without them, because it fetches CelesTrak directly.

All paths are relative, so the app works under `https://<user>.github.io/<repo>/`. The About tab's GitHub and sponsor buttons appear once `GITHUB_URL` / `SPONSOR_URL` are set in `js/config.js`.

### Install on Android
Open the site in Chrome, then **⋮ → Add to Home screen / Install app**, or use the *Install app* button in the Alerts tab. In Alerts, set your criteria, turn on **Push notifications**, and tap **Send test**. Installing also enables background forecast refresh.

## Local development

```sh
python3 -m http.server 8765   # then open http://localhost:8765
```
Service workers need `localhost` or HTTPS. On `localhost`/`127.0.0.1` the service worker always loads app files from the network, so edits show up on reload. Elsewhere it serves one complete, versioned copy of the app: bump `APP_VERSION` in `js/config.js` with every change to app files, or installed copies keep the old version. The pre-commit hook enforces this.

Tests and the pre-commit hook:
```sh
npm install                    # also points git at .githooks/ (core.hooksPath)
npx playwright install chromium
npm test                       # unit tests: astronomy, pass prediction, scoring, alert schedule
npm run test:e2e               # browser smoke test: boot, offline start, update to a new version
npm run test:engagement        # the engagement estimate against real Chromium (not in the hook: 1.5 min)
```
Before each commit the hook checks the version bump, that all JavaScript parses, runs the unit tests, the relay tests (when `worker/` changed) and the browser smoke test (if Playwright is installed; `SKIP_E2E=1` skips it). `git commit --no-verify` skips everything once.

Relay:
```sh
cd worker
npm test                       # crypto + validation unit tests, end-to-end relay test (local D1, mock push service)
npx wrangler d1 migrations apply iss-push --local
npm run dev                    # http://localhost:8787; trigger the cron via /__scheduled
```
Then set the relay URL in the app to `http://localhost:8787`. Real push needs a real browser push subscription, so test notifications on a phone against the deployed worker.

## Privacy
Your location stays on the device, and so does the app's estimate of how much you use it. The location is sent only to Open-Meteo (rounded to 0.01°) for the forecast and to BigDataCloud to look up a place name when you use GPS or long-press the map. The push relay stores your browser's push endpoint, a hash of its auth secret, and alert messages encrypted so that only your browser can read them. Delivered rows are deleted, and subscriptions that aren't refreshed for 30 days are deleted entirely.

## Credits
satellite.js (MIT) · Leaflet (BSD-2) · NASA GIBS / Black Marble imagery · Open-Meteo (CC BY 4.0) · CelesTrak · Cloudflare Workers + D1

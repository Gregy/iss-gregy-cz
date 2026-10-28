# ISS Pass Tracker (PWA)

Live ISS position, visible-pass predictions scored by **weather + sky darkness + geometry**, and push alerts for good passes. The app is a static site with no build step and runs on GitHub Pages. Push alerts go through a small relay running on Cloudflare Workers' free plan. The relay holds no keys and can't read the notifications.

## Features

- **Live map**: ISS position, ground track (yellow = sunlit, blue = in Earth's shadow), the area it can be seen from, and your location. The day side shows NASA Blue Marble and the night side Black Marble city lights, blended across twilight using the sun's real position.
- **Where to look now**: azimuth/elevation from your location, plus whether the ISS is visible right now (sunlit, dark sky, high enough).
- **Visible passes (10 days)**: sky chart for each pass, appear/peak/vanish times and directions, estimated brightness, and a 0–100 **score**:
  brightness × sky darkness × duration × **clear sky** (Open-Meteo low/mid/high cloud + rain probability).
- **Push alerts** for passes that meet your criteria (minimum height, minimum score). They arrive at an exact time *N* minutes before the pass, with an optional heads-up a few hours earlier, even when the app is closed.
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
- The schedule is re-synced whenever the app is opened, whenever an alert arrives (the service worker is awake anyway: a heads-up thus refreshes the later "look up now" alert, or cancels it), and in the background via Periodic Background Sync when the app is installed (Chrome/Android decides how often, usually every 12–24 h). A shorter booking window ("Book alerts up to") means fresher forecasts.
- A "look up now" alert carries its pass's times and score factors. On arrival the service worker fetches a fresh forecast (4 s at most) and re-scores the pass: if it has dropped below your minimum score the notification says the clouds moved in, otherwise it adds the latest cloud cover. It can't be suppressed: browsers require every push to show a notification, which also rules out silent "wake up and refresh" pushes.

**Multiple users.** Each browser subscription is one user, with no accounts. Rows are keyed by subscription, so one user's uploads can never touch another's. The subscription's `auth` secret acts as its password: only its hash is stored, and changes need the same secret. The relay protects itself with:
- only POSTing to known push services (FCM, Mozilla, Apple, Windows);
- a per-IP rate limit on writes;
- a cap on total subscriptions (`MAX_SUBSCRIPTIONS`);
- per-subscription limits (60 alerts, 4 KB each);
- fair batching (at most 3 messages per subscription per cron run).

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
In `wrangler.toml`, set `ALLOWED_ORIGINS` to your Pages origin (e.g. `https://<user>.github.io`). Then:
```sh
npx wrangler d1 migrations apply iss-push --remote
npx wrangler deploy                     # prints https://iss-push.<account>.workers.dev
```
There are no keys to generate or secrets to store. The `[[ratelimits]]` block is optional; remove it if your account doesn't offer the binding.

To deploy automatically on push instead, add repo secrets `CLOUDFLARE_API_TOKEN` (template "Edit Cloudflare Workers" plus D1 edit) and `CLOUDFLARE_ACCOUNT_ID`. The `Push relay` workflow tests the relay, then applies migrations and deploys it.

### 2. App (GitHub Pages)
1. Push this repo to GitHub (branch `main`).
2. **Settings → Secrets and variables → Actions → Variables**: add `PUSH_SERVER` = your worker URL.
3. **Settings → Pages → Source: GitHub Actions.**
4. The `Deploy to GitHub Pages` workflow publishes on every push and every 6 h. Each run refreshes `data/iss.tle` and writes `PUSH_SERVER` into `js/config.js`.
   GitHub disables scheduled workflows after 60 days without repo activity. The app still works without them, because it fetches CelesTrak directly.

All paths are relative, so the app works under `https://<user>.github.io/<repo>/`. The About tab's GitHub and sponsor buttons appear once `GITHUB_URL` / `SPONSOR_URL` are set in `js/config.js`. The relay URL can also be set in the app under Alerts → Push notifications → Relay.

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
Your location stays on the device. It is sent only to Open-Meteo (rounded to 0.01°) for the forecast and to BigDataCloud to look up a place name when you use GPS or long-press the map. The push relay stores your browser's push endpoint, a hash of its auth secret, and alert messages encrypted so that only your browser can read them. Delivered rows are deleted, and subscriptions that aren't refreshed for 30 days are deleted entirely.

## Credits
satellite.js (MIT) · Leaflet (BSD-2) · NASA GIBS / Black Marble imagery · Open-Meteo (CC BY 4.0) · CelesTrak · Cloudflare Workers + D1

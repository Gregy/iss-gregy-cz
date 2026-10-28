import { satState, sunAltAz, compass, makeObserver } from './core/astro.js';
import { VIS_MAX_SUN, VIS_MIN_EL } from './core/passes.js';
import { scoreLabel, cloudEmoji } from './core/weather.js';
import { computeForecast, qualifies, syncPush, fmtTime, fmtDay, describePass } from './core/alerts.js';
import { subscribe, unsubscribe, sendTest } from './core/push.js';
import { loadTle } from './core/tle.js';
import * as store from './core/store.js';
import { APP_VERSION, GITHUB_URL, SPONSOR_URL } from './config.js';
import { IssMap } from './ui/map.js';
import { skyChart } from './ui/skychart.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const APP_URL = new URL('./', location.href).href;

const state = {
  loc: null,
  settings: null,
  tle: null,
  observer: null,
  passes: [],
  weather: null,
  reg: null,
  map: null,
  installEvt: null,
  openPass: null,
};

// ---------- utils ----------

function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.h);
  toast.h = setTimeout(() => t.classList.remove('show'), ms);
}

const tz = () => state.loc?.tz;
const fmtLat = (v) => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? 'N' : 'S'}`;
const fmtLon = (v) => `${Math.abs(v).toFixed(2)}° ${v >= 0 ? 'E' : 'W'}`;
const fmtDur = (s) => `${Math.floor(s / 60)}m ${String(Math.round(s % 60)).padStart(2, '0')}s`;

function countdown(ms) {
  if (ms <= 0) return 'now';
  const s = Math.round(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return `in ${d} d ${h} h`;
  if (h > 0) return `in ${h} h ${m} min`;
  return `in ${m}:${String(s % 60).padStart(2, '0')}`;
}

// ---------- routing ----------

function route() {
  const h = location.hash.slice(1);
  let view = 'live';
  if (h.startsWith('pass=')) { view = 'passes'; state.openPass = h.slice(5); }
  else if (h === 'scoring') view = 'about';
  else if (['live', 'passes', 'alerts', 'about'].includes(h)) view = h;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
  document.querySelectorAll('.tabbar a').forEach((a) => a.classList.toggle('active', a.dataset.tab === view));
  if (view === 'live') requestAnimationFrame(() => state.map?.invalidate());
  if (view === 'passes') { renderPasses(); revealOpenPass(); }
  if (h === 'scoring') requestAnimationFrame(() => $('#scoring').scrollIntoView({ block: 'start', behavior: 'smooth' }));
  if (view === 'alerts' || view === 'about') renderAlertStatus();
}

function revealOpenPass() {
  if (!state.openPass) return;
  const el = document.querySelector(`[data-id="${CSS.escape(state.openPass)}"]`);
  if (!el) return;
  el.open = true;
  el.classList.add('target');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ---------- location ----------

async function setLocation(loc) {
  state.loc = { ...loc, tz: loc.tz };
  await store.set('location', state.loc);
  // a different place means previous alert bookkeeping no longer applies
  await store.del('notified');
  $('#locName').textContent = loc.name || `${fmtLat(loc.lat)}, ${fmtLon(loc.lon)}`;
  state.observer = makeObserver(loc.lat, loc.lon, loc.height || 0);
  state.map?.setObserver(state.loc);
  await refreshForecast();
}

async function reverseName(lat, lon) {
  try {
    const r = await fetch(`https://api.bigdatacloud.net/data/reverse-geocode-client?latitude=${lat}&longitude=${lon}&localityLanguage=en`);
    const j = await r.json();
    return [j.city || j.locality, j.countryCode].filter(Boolean).join(', ') || null;
  } catch { return null; }
}

function setupLocationDialog() {
  const dlg = $('#locDialog');
  $('#locBtn').addEventListener('click', () => dlg.showModal());
  $('#geoBtn').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('Geolocation is not available');
    $('#geoBtn').disabled = true;
    navigator.geolocation.getCurrentPosition(async (pos) => {
      const { latitude: lat, longitude: lon, altitude } = pos.coords;
      const name = (await reverseName(lat, lon)) || 'My location';
      $('#geoBtn').disabled = false;
      dlg.close();
      await setLocation({ lat, lon, height: altitude || 0, name });
      state.map?.focusObserver(state.loc);
    }, (err) => {
      $('#geoBtn').disabled = false;
      toast(`Location failed: ${err.message}`);
    }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 600000 });
  });

  let h;
  $('#locSearch').addEventListener('input', (e) => {
    clearTimeout(h);
    const q = e.target.value.trim();
    if (q.length < 2) { $('#locResults').innerHTML = ''; return; }
    h = setTimeout(async () => {
      try {
        const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=8&language=en`);
        const j = await r.json();
        $('#locResults').innerHTML = (j.results || []).map((p, i) => `<li><button type="button" data-i="${i}">${esc(p.name)}
          <small>${esc([p.admin1, p.country].filter(Boolean).join(', '))}</small></button></li>`).join('') || '<li class="hint">No results</li>';
        $('#locResults').onclick = async (ev) => {
          const b = ev.target.closest('button[data-i]');
          if (!b) return;
          const p = j.results[+b.dataset.i];
          dlg.close();
          await setLocation({ lat: p.latitude, lon: p.longitude, height: p.elevation || 0, name: `${p.name}, ${p.country_code}`, tz: p.timezone });
          state.map?.focusObserver(state.loc);
        };
      } catch { toast('Search failed (offline?)'); }
    }, 300);
  });
}

// ---------- live view ----------

function compassSvg(az) {
  return `<svg class="compass" viewBox="-30 -30 60 60" aria-hidden="true">
    <circle r="27"/>
    <text y="-17" text-anchor="middle">N</text><text x="19" y="3" text-anchor="middle">E</text>
    <text y="23" text-anchor="middle">S</text><text x="-19" y="3" text-anchor="middle">W</text>
    <path class="needle" d="M0,-22 L5,2 L0,-2 L-5,2 z" transform="rotate(${az.toFixed(0)})"/>
  </svg>`;
}

function tickLive() {
  if (!state.tle) return;
  const now = new Date();
  const s = satState(state.tle.satrec, now, state.observer);
  if (!s) return;
  $('#sLat').textContent = `${Math.abs(s.lat).toFixed(2)}°${s.lat >= 0 ? 'N' : 'S'}`;
  $('#sLon').textContent = `${Math.abs(s.lon).toFixed(2)}°${s.lon >= 0 ? 'E' : 'W'}`;
  $('#sAlt').textContent = `${s.alt.toFixed(0)} km`;
  $('#sSpd').textContent = `${s.speed.toFixed(2)} km/s`;
  $('#sSpd').title = `${Math.round(s.speed * 3600).toLocaleString()} km/h`;
  state.map?.updateIss(s);
  state.map?.drawTrack(state.tle.satrec, now.getTime());

  const look = $('#liveLook');
  if (!state.observer) {
    look.className = 'card look';
    look.innerHTML = `<div><div class="big">Where are you?</div><div class="sub">Set your location to see passes and where to look.</div></div>`;
  } else {
    const sun = sunAltAz(now, state.loc.lat, state.loc.lon).alt;
    const up = s.el > 0;
    const visible = up && s.sunlit && sun < VIS_MAX_SUN && s.el >= VIS_MIN_EL;
    look.className = `card look${visible ? ' up' : ''}`;
    let big, sub;
    if (visible) {
      big = `👀 Visible now! Look ${compass(s.az)}, ${Math.round(s.el)}° up`;
      sub = `${s.range.toFixed(0)} km away · mag ${s.mag?.toFixed(1)}`;
    } else if (up) {
      big = `Above your horizon: ${compass(s.az)}, ${Math.round(s.el)}°`;
      sub = !s.sunlit ? "But it's in Earth's shadow, so you can't see it." : sun >= VIS_MAX_SUN ? 'But your sky is too bright to see it.' : 'Too low to spot easily.';
    } else {
      big = `Below your horizon (${Math.round(s.el)}°)`;
      sub = `Direction ${compass(s.az)} · ${Math.round(s.range).toLocaleString()} km away · ISS ${s.sunlit ? 'in sunlight' : 'in Earth\'s shadow'}`;
    }
    look.innerHTML = `${compassSvg(s.az)}<div><div class="big">${big}</div><div class="sub">${sub}</div></div>`;
  }

  const cd = document.querySelector('#nextPass .countdown');
  if (cd) cd.textContent = countdown(+cd.dataset.t - now.getTime());
  const chart = document.querySelector('#nextPass .chart-slot');
  if (chart && s.el > 0 && state.nextPass && now >= state.nextPass.rise.t && now <= state.nextPass.set.t) {
    chart.innerHTML = skyChart(state.nextPass, { tz: tz(), live: s });
  }
}

function renderNextPass() {
  const box = $('#nextPass');
  const now = Date.now();
  const next = state.passes.find((p) => p.visible && p.visible.end.t > now);
  const good = state.passes.find((p) => p.visible && p.visible.end.t > now && qualifies(p, state.settings));
  state.nextPass = next;
  if (!state.observer) { box.innerHTML = ''; return; }
  if (!next) { box.innerHTML = '<div class="card"><h2>Next visible pass</h2><p class="hint">No visible passes in the next 10 days. That happens around the solstices and at high latitudes, when the ISS stays in daylight or in shadow.</p></div>'; return; }
  const block = (p, title) => {
    const r = p.rating, d = describePass(p, tz());
    return `<div class="card">
      <div class="next-head"><h2>${title}</h2><span class="countdown" data-t="${p.visible.start.t}">${countdown(p.visible.start.t - now)}</span></div>
      <div class="pass-head" style="padding:6px 0" onclick="location.hash='pass=${p.id}'">
        <div class="when"><div class="dur">${fmtDay(p.visible.start.t, tz())}</div><div class="time">${fmtTime(p.visible.start.t, tz())}</div></div>
        <div class="meta">max ${Math.round(p.visible.max.el)}° · ${fmtDur(p.visible.duration)}<br><span class="dir">${compass(p.visible.start.az)} → ${compass(p.visible.end.az)} · ${cloudEmoji(r.wx?.effective)} ${r.wx ? Math.round(r.wx.effective) + '% clouds' : 'no forecast'}</span></div>
        ${scoreBadge(r.score)}
      </div>
      <div class="chart-slot" style="max-width:240px;margin:6px auto 0">${skyChart(p, { tz: tz() })}</div>
      <p class="hint" style="margin-bottom:0">${esc(d.path)}</p>
    </div>`;
  };
  box.innerHTML = block(next, 'Next visible pass') + (good && good !== next ? block(good, 'Next good pass') : '');
}

// ---------- passes view ----------

function scoreBadge(score) {
  const sl = scoreLabel(score);
  return `<div class="score-wrap ${sl.cls}"><div class="score">${score}</div><div class="score-label">${sl.label}</div></div>`;
}

/** The exact factors the score was computed from, and the product that gives it. */
function factorBars(p) {
  const v = p.visible, r = p.rating, f = r.factors;
  const rows = [
    ['Brightness', f.brightness, v.minMag != null ? `mag ${v.minMag.toFixed(1)} at ${Math.round(v.minMagEl ?? v.max.el)}° up` : '–'],
    ['Dark sky', f.darkSky, `sun ${Math.round(v.sunAlt)}°`],
    ['Duration', f.duration, fmtDur(v.duration)],
    ['Clear sky', f.clearSky, r.wx ? `${Math.round(r.wx.effective)}% cloud` : 'no forecast'],
  ];
  const pct = (x) => `${Math.round(x * 100)}%`;
  const used = rows.filter(([, x]) => x != null);
  return `<div class="factors">${rows.map(([k, x, t]) => `<span>${k}</span>
      <div class="bar"><i style="width:${x == null ? 0 : Math.round(x * 100)}%"></i></div>
      <span class="pct">${x == null ? '–' : pct(x)}</span><span class="why">${t}</span>`).join('')}</div>
    <p class="equation">${used.map(([, x]) => pct(x)).join(' × ')} = <b>${r.score}</b> <a href="#scoring">How the score works</a></p>`;
}

function passCard(p) {
  const now = Date.now();
  const v = p.visible, r = p.rating;
  const ok = qualifies(p, state.settings);
  const wx = r.wx
    ? `${cloudEmoji(r.wx.effective)} ${Math.round(r.wx.effective)}% effective cloud <span class="badge">low ${Math.round(r.wx.low)}%</span><span class="badge">mid ${Math.round(r.wx.mid)}%</span><span class="badge">high ${Math.round(r.wx.high)}%</span>${r.wx.precip > 10 ? `<span class="badge">rain ${Math.round(r.wx.precip)}%</span>` : ''}`
    : '❔ Beyond the weather forecast range, geometry only';
  const live = now >= p.rise.t && now <= p.set.t;
  return `<details class="pass" data-id="${p.id}"${state.openPass === p.id ? ' open' : ''}>
    <summary class="pass-head">
      <div class="when"><div class="time">${fmtTime(v.start.t, tz())}</div><div class="dur">${fmtDur(v.duration)}</div></div>
      <div class="meta">max <b>${Math.round(v.max.el)}°</b> · ${v.minMag != null ? `mag ${v.minMag.toFixed(1)}` : ''}${live ? ' · <b style="color:var(--accent)">NOW</b>' : ''}<br>
        <span class="dir">${compass(v.start.az)} → ${compass(v.end.az)} · ${cloudEmoji(r.wx?.effective)} ${r.wx ? Math.round(r.wx.effective) + '%' : '–'}</span>
        ${ok ? '<span class="badge ok">🔔 alert</span>' : ''}</div>
      ${scoreBadge(r.score)}
    </summary>
    <div class="pass-body">
      <div>${skyChart(p, { tz: tz() })}</div>
      <div>
        <table>
          <tr><th></th><th>Time</th><th>Height</th><th>Direction</th></tr>
          <tr><td>Appears</td><td>${fmtTime(v.start.t, tz())}</td><td>${Math.round(v.start.el)}°</td><td>${compass(v.start.az)} ${Math.round(v.start.az)}°</td></tr>
          <tr><td>Highest</td><td>${fmtTime(v.max.t, tz())}</td><td>${Math.round(v.max.el)}°</td><td>${compass(v.max.az)} ${Math.round(v.max.az)}°</td></tr>
          <tr><td>Vanishes</td><td>${fmtTime(v.end.t, tz())}</td><td>${Math.round(v.end.el)}°</td><td>${compass(v.end.az)} ${Math.round(v.end.az)}°</td></tr>
        </table>
        <div class="wxrow">${wx}</div>
        ${factorBars(p)}
        ${v.end.el > VIS_MIN_EL && !v.end.sunlit ? '<p class="hint">Fades out mid-sky as it enters Earth\'s shadow.</p>' : ''}
        <div class="actions">
          <button class="btn ghost" type="button" data-share="${p.id}">↗ Share</button>
        </div>
      </div>
    </div>
  </details>`;
}

function renderPasses() {
  const list = $('#passList');
  if (!state.observer) { list.innerHTML = '<p class="empty">Set your location to see passes.</p>'; return; }
  if (!state.passes.length) { list.innerHTML = '<p class="empty">Computing passes…</p>'; return; }
  const now = Date.now();
  const items = state.passes.filter((p) => p.visible && p.visible.end.t > now);
  if (!items.length) { list.innerHTML = '<p class="empty">No visible passes in the next 10 days. Around the solstices, or at high latitudes, the ISS can stay in sunlight or in Earth\'s shadow for days.</p>'; return; }
  let html = '', day = '';
  for (const p of items) {
    const t = p.visible.start.t;
    const d = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'short', timeZone: tz() }).format(t);
    if (d !== day) { html += `<div class="day-head">${d}</div>`; day = d; }
    html += passCard(p);
  }
  list.innerHTML = html;
}

async function sharePass(id) {
  const p = state.passes.find((x) => x.id === id);
  if (!p) return;
  const d = describePass(p, tz());
  const text = `🛰️ ISS pass ${d.when} from ${state.loc.name}: ${d.path} ${d.stats}`;
  try {
    if (navigator.share) await navigator.share({ title: 'ISS pass', text, url: `${APP_URL}#pass=${id}` });
    else { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
  } catch { /* user cancelled */ }
}

// ---------- forecast / alerts ----------

async function refreshForecast({ forceTle = false } = {}) {
  if (!state.loc) return;
  try {
    const f = await computeForecast(state.loc, { forceTle });
    state.tle = f.tle;
    state.passes = f.passes;
    state.weather = f.weather;
    if (f.weather?.timezone) state.loc.tz = f.weather.timezone;
    renderTleInfo();
    renderNextPass();
    if (!$('#view-passes').hidden) { renderPasses(); revealOpenPass(); }
    renderCriteriaPreview();
    state.map?.drawTrack(state.tle.satrec);
    schedulePushSync();
  } catch (e) {
    console.error(e);
    toast(`Could not compute passes: ${e.message}`);
  }
}

function renderTleInfo() {
  if (!state.tle) return;
  const age = (Date.now() - state.tle.epoch) / 3600e3;
  const wx = state.weather ? ` · weather ${new Date(state.weather.fetched).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ' · weather unavailable';
  $('#tleInfo').textContent = `Orbit data: ${state.tle.source}, epoch ${age < 48 ? age.toFixed(0) + ' h' : (age / 24).toFixed(1) + ' days'} old${wx}. Positions computed on-device (SGP4).`;
}

const getSubscription = async () => (state.reg ? state.reg.pushManager.getSubscription() : null);

const hostOf = (url) => { try { return new URL(url).host; } catch { return url; } };

async function runPushSync(source, force = false) {
  if (!state.reg) return { skipped: 'service worker not active' };
  const r = await syncPush({ source, force, registration: state.reg, baseUrl: APP_URL });
  renderAlertStatus();
  return r;
}

let syncTimer;
function schedulePushSync() {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => runPushSync('app').catch((e) => console.warn('push sync', e)), 1500);
}

// ---------- alerts view ----------

const SLIDERS = { minElevation: (v) => `${v}°`, minScore: (v) => `${v}` };

function renderCriteriaPreview() {
  const vis = state.passes.filter((p) => p.visible && p.visible.end.t > Date.now());
  const good = vis.filter((p) => qualifies(p, state.settings));
  $('#criteriaPreview').textContent = state.observer
    ? `${good.length} of the next ${vis.length} visible passes match these settings${good[0] ? `. Next: ${describePass(good[0], tz()).when}.` : '.'}`
    : 'Set a location first.';
}

async function saveSetting(patch) {
  state.settings = await store.saveSettings(patch);
  renderCriteriaPreview();
  if (!$('#view-passes').hidden) renderPasses();
  schedulePushSync();
}

function setupAlertsView() {
  const s = state.settings;
  for (const [id, fmt] of Object.entries(SLIDERS)) {
    const el = $('#' + id), out = $(`#${id}Out`);
    el.value = s[id]; out.textContent = fmt(s[id]);
    el.addEventListener('input', () => { out.textContent = fmt(el.value); state.settings[id] = +el.value; renderCriteriaPreview(); });
    el.addEventListener('change', () => saveSetting({ [id]: +el.value }));
  }
  for (const id of ['leadMinutes', 'headsUpHours', 'horizonHours']) {
    $('#' + id).value = String(s[id]);
    $('#' + id).addEventListener('change', (e) => saveSetting({ [id]: +e.target.value }));
  }

  // enabling/disabling must not interleave with a sync uploading for the same subscription
  const withSyncLock = (fn) => (navigator.locks ? navigator.locks.request('iss-push-sync', fn) : fn());

  $('#pushEnabled').checked = s.pushEnabled;
  $('#pushEnabled').addEventListener('change', async (e) => {
    const box = e.target;
    box.disabled = true;
    try {
      if (box.checked) {
        if (!state.reg || !('PushManager' in window)) throw new Error('Push is not supported in this browser');
        if ((await Notification.requestPermission()) !== 'granted') throw new Error('Notification permission denied');
        await withSyncLock(() => subscribe(state.reg));
        await saveSetting({ pushEnabled: true });
        await registerPeriodicSync();
        const r = await runPushSync('enabled', true);
        if (r.error) throw new Error(r.error);
        toast(r.booked ? `${r.booked} alert(s) booked` : 'Subscribed. No passes match your criteria yet.');
      } else {
        await saveSetting({ pushEnabled: false });
        await withSyncLock(() => unsubscribe(state.reg));
        await state.reg?.periodicSync?.unregister('iss-check').catch(() => {});
        await store.del('push');
      }
    } catch (err) {
      box.checked = false;
      await saveSetting({ pushEnabled: false });
      if (state.reg) await withSyncLock(() => unsubscribe(state.reg)).catch(() => {});
      toast(err.message, 4000);
    } finally {
      box.disabled = false;
      renderAlertStatus();
    }
  });
  $('#pushTest').addEventListener('click', async () => {
    const sub = await getSubscription();
    if (!state.settings.pushEnabled || !sub) return toast('Turn on push notifications first');
    try { await sendTest(sub, APP_URL); toast('Test sent. It should arrive in a few seconds.'); } catch (err) { toast(`Test failed: ${err.message}`, 4000); }
  });
  $('#pushSync').addEventListener('click', async () => {
    const r = await runPushSync('manual', true);
    if (r.skipped === 'push off') toast('Turn on push notifications first');
    else if (r.skipped) toast(`Not synced: ${r.skipped}`);
    else if (r.error) toast(`Sync failed: ${r.error}`, 4000);
    else toast(`${r.good} good pass(es) · ${r.booked} alert(s) booked`);
  });

  $('#refreshTle').addEventListener('click', async () => { toast('Refreshing…'); await refreshForecast({ forceTle: true }); toast(`Orbit data from ${state.tle?.source}`); });
  $('#installBtn').addEventListener('click', async () => {
    if (!state.installEvt) return;
    state.installEvt.prompt();
    await state.installEvt.userChoice;
    state.installEvt = null;
    $('#installBtn').hidden = true;
  });
}

async function registerPeriodicSync() {
  const reg = state.reg;
  if (!reg || !('periodicSync' in reg)) return 'unsupported';
  try {
    const p = await navigator.permissions.query({ name: 'periodic-background-sync' });
    if (p.state !== 'granted') return p.state;
    await reg.periodicSync.register('iss-check', { minInterval: 6 * 3600e3 });
    return 'registered';
  } catch (e) {
    console.warn('periodic sync', e);
    return 'error';
  }
}

async function renderAlertStatus() {
  const li = (cls, text) => `<li><span class="${cls}">${cls === 'ok' ? '✔' : cls === 'warn' ? '!' : '✖'}</span><span>${text}</span></li>`;
  const standalone = matchMedia('(display-mode: standalone)').matches;
  const perm = 'Notification' in window ? Notification.permission : 'unsupported';
  let ps = 'unsupported';
  if (state.reg && 'periodicSync' in state.reg) {
    const tags = await state.reg.periodicSync.getTags().catch(() => []);
    ps = tags.includes('iss-check') ? 'registered' : (await navigator.permissions.query({ name: 'periodic-background-sync' }).catch(() => ({ state: 'unknown' }))).state;
  }
  const last = await store.get('lastCheck');
  const sub = await getSubscription().catch(() => null);
  const s = state.settings;
  const when = (t) => new Date(t).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const lastLine = !last ? li('warn', 'Not synced yet')
    : last.error ? li('bad', `Last sync failed (${when(last.t)}): ${esc(last.error)}`)
      : last.skipped ? li('warn', `Last sync skipped (${when(last.t)}): ${esc(last.skipped)}`)
        : li('ok', `Synced ${when(last.t)} (${esc(last.source)}): ${last.booked ?? 0} alert(s) booked${last.next ? `, next ${when(last.next)}` : ''}`);
  $('#pushStatus').innerHTML = !s.pushEnabled
    ? [
      perm === 'denied' ? li('bad', 'Notifications are blocked for this site in browser settings') : '',
    ].join('')
    : [
      perm === 'granted' ? li('ok', 'Notification permission granted') : li('bad', `Notification permission: ${perm}`),
      sub ? li('ok', `Subscribed via ${esc(hostOf(sub.endpoint))}`) : li('bad', 'No push subscription. Toggle off and on again.'),
      lastLine,
      ps === 'registered' ? li('ok', 'Background forecast refresh active')
        : li('warn', ps === 'unsupported' ? 'No background refresh in this browser. Alerts update when you open the app.' : 'Background refresh inactive. Install the app to the home screen for fresher forecasts.'),
    ].join('');
  $('#appStatus').innerHTML = [
    standalone ? li('ok', 'Running as installed app') : li('warn', 'Running in the browser. Install it to let the forecast refresh in the background.'),
    state.reg ? li('ok', 'Offline support active') : li('warn', 'Service worker not active'),
    state.tle ? li(Date.now() - state.tle.epoch < 3 * 86400e3 ? 'ok' : 'warn', `Orbit data epoch ${new Date(state.tle.epoch).toLocaleString()} (${state.tle.source})`) : '',
  ].join('');
  const log = (await store.get('log')) || [];
  $('#logList').innerHTML = log.map((e) => `<li>${new Date(e.t).toLocaleString([], { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} [${esc(e.source)}] ${esc(e.msg)}</li>`).join('');
  $('#logEmpty').hidden = log.length > 0;
}

// ---------- about ----------

function renderAbout() {
  $('#appVersion').textContent = APP_VERSION;
  const links = [
    GITHUB_URL && `<a class="btn ghost" href="${esc(GITHUB_URL)}" target="_blank" rel="noopener">Source code on GitHub</a>`,
    SPONSOR_URL && `<a class="btn" href="${esc(SPONSOR_URL)}" target="_blank" rel="noopener">♥ Sponsor</a>`,
  ].filter(Boolean);
  $('#aboutLinks').innerHTML = links.join('');
  $('#aboutLinks').hidden = !links.length;
}

// ---------- boot ----------

async function boot() {
  state.settings = await store.getSettings();
  state.loc = await store.get('location');

  state.map = new IssMap($('#map'), {
    onLongPress: async (ll) => {
      if (!confirm(`Set viewing location to ${fmtLat(ll.lat)}, ${fmtLon(ll.lng)}?`)) return;
      const name = (await reverseName(ll.lat, ll.lng)) || `${ll.lat.toFixed(2)}, ${ll.lng.toFixed(2)}`;
      await setLocation({ lat: ll.lat, lon: ll.lng, name });
    },
  });

  // one broken panel shouldn't take the live map down with it
  for (const setup of [setupLocationDialog, setupAlertsView, renderAbout]) {
    try { setup(); } catch (e) { console.error(e); }
  }
  $('#passList').addEventListener('click', (e) => { const b = e.target.closest('[data-share]'); if (b) sharePass(b.dataset.share); });
  window.addEventListener('hashchange', route);

  if ('serviceWorker' in navigator) {
    try {
      // a new version takes over while this page runs the old code: reload once onto it
      const hadController = !!navigator.serviceWorker.controller;
      navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
      // updateViaCache 'none': check sw.js and the modules it imports (config.js has the version) past the HTTP cache
      state.reg = await navigator.serviceWorker.register('sw.js', { type: 'module', updateViaCache: 'none' });
      navigator.serviceWorker.addEventListener('message', (e) => {
        if (e.data?.type === 'open') location.href = e.data.url;
      });
      if (state.settings.pushEnabled) registerPeriodicSync();
    } catch (e) { console.warn('SW registration failed', e); }
  }
  window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); state.installEvt = e; $('#installBtn').hidden = false; });

  setInterval(() => state.map.updateDaylight(), 5 * 60e3);

  if (state.loc) {
    $('#locName').textContent = state.loc.name;
    state.observer = makeObserver(state.loc.lat, state.loc.lon, state.loc.height || 0);
    state.map.setObserver(state.loc);
    state.map.focusObserver(state.loc);
  }
  route();

  try {
    state.tle = await loadTle();
    renderTleInfo();
    state.map.drawTrack(state.tle.satrec);
    tickLive();
  } catch (e) { toast(e.message); }

  setInterval(tickLive, 1000);
  setInterval(() => refreshForecast(), 15 * 60e3);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.loc) refreshForecast();
  });

  if (state.loc) refreshForecast();
  else $('#locDialog').showModal();
}

boot();

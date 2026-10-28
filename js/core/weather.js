// Weather (Open-Meteo, no API key, CORS-enabled) and viewing-quality scoring.

const HOURLY = ['cloud_cover', 'cloud_cover_low', 'cloud_cover_mid', 'cloud_cover_high', 'precipitation_probability', 'visibility', 'weather_code'];

export async function fetchWeather(lat, lon) {
  const url = 'https://api.open-meteo.com/v1/forecast'
    + `?latitude=${lat.toFixed(2)}&longitude=${lon.toFixed(2)}`
    + `&hourly=${HOURLY.join(',')}&forecast_days=10&timezone=auto&timeformat=unixtime`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather HTTP ${res.status}`);
  const j = await res.json();
  return {
    fetched: Date.now(),
    lat, lon,
    timezone: j.timezone,
    time: j.hourly.time.map((s) => s * 1000),
    cloud: j.hourly.cloud_cover,
    low: j.hourly.cloud_cover_low,
    mid: j.hourly.cloud_cover_mid,
    high: j.hourly.cloud_cover_high,
    precip: j.hourly.precipitation_probability,
    visibility: j.hourly.visibility,
    code: j.hourly.weather_code,
  };
}

/** Linear interpolation of the hourly series at time t (ms). */
export function weatherAt(w, t) {
  if (!w || !w.time.length || t < w.time[0] || t > w.time[w.time.length - 1]) return null;
  let i = w.time.findIndex((x) => x > t);
  if (i <= 0) i = 1;
  const a = i - 1, f = (t - w.time[a]) / (w.time[i] - w.time[a]);
  const lerp = (arr) => (arr?.[a] == null || arr?.[i] == null ? null : arr[a] + (arr[i] - arr[a]) * f);
  const low = lerp(w.low) ?? 0, mid = lerp(w.mid) ?? 0, high = lerp(w.high) ?? 0;
  // Effective obstruction: low and mid clouds block the view, thin high clouds
  // (cirrus) usually still let a -3 mag ISS through. Overlap treated as independent.
  const effective = 100 * (1 - (1 - low / 100) * (1 - (0.9 * mid) / 100) * (1 - (0.45 * high) / 100));
  return {
    cloud: lerp(w.cloud),
    low, mid, high,
    effective,
    precip: lerp(w.precip) ?? 0,
    visibility: lerp(w.visibility),
    code: w.code?.[Math.round(a + f)],
  };
}

const clamp = (x, a = 0, b = 1) => Math.max(a, Math.min(b, x));

/**
 * Score a visible pass 0-100: the product of four factors, each 0-1.
 * Height counts through brightness: low passes are farther away and dimmed by
 * more atmosphere.
 *   brightness  0% at magnitude +2.5 or dimmer, rising linearly to 100% at −3.5 or brighter
 *   darkSky     65% when the sun is at −6°, rising to 100% at −12° and below
 *   duration    60% for a blink, rising to 100% at 5 minutes visible
 *   clearSky    (1 − effective cloud)^1.3 × (1 − rain probability / 2); 100% beyond the forecast range
 * Returns { score, geo, sky, wx, factors } where wx is the forecast during the
 * pass (or null beyond the forecast horizon, in which case score === geo).
 */
export function scorePass(pass, weather) {
  const v = pass.visible;
  if (!v) return { score: 0, geo: 0, sky: null, wx: null, factors: null };
  const fMag = clamp((2.5 - (v.minMag ?? 0)) / 6);
  const fDark = 0.65 + 0.35 * clamp((-6 - v.sunAlt) / 6);
  const fDur = 0.6 + 0.4 * clamp(v.duration / 300);
  const geo = fMag * fDark * fDur;

  // sample forecast at the start, peak and end of the visible window
  const samples = [v.start.t, v.max.t, v.end.t].map((t) => weatherAt(weather, t)).filter(Boolean);
  const factors = { brightness: fMag, darkSky: fDark, duration: fDur, clearSky: null };
  if (!samples.length) return { score: Math.round(geo * 100), geo: Math.round(geo * 100), sky: null, wx: null, factors };
  const avg = (k) => samples.reduce((s, x) => s + (x[k] ?? 0), 0) / samples.length;
  const wx = {
    cloud: avg('cloud'), low: avg('low'), mid: avg('mid'), high: avg('high'),
    effective: avg('effective'), precip: avg('precip'),
    code: weatherAt(weather, v.max.t)?.code,
  };
  const sky = Math.pow(1 - wx.effective / 100, 1.3) * (1 - 0.5 * (wx.precip / 100));
  factors.clearSky = sky;
  return { score: Math.round(geo * sky * 100), geo: Math.round(geo * 100), sky: Math.round(sky * 100), wx, factors };
}

export function scoreLabel(score) {
  if (score >= 70) return { label: 'Excellent', cls: 'exc' };
  if (score >= 45) return { label: 'Good', cls: 'good' };
  if (score >= 25) return { label: 'Fair', cls: 'fair' };
  return { label: 'Poor', cls: 'poor' };
}

export function cloudEmoji(eff) {
  if (eff == null) return '❔';
  if (eff < 15) return '✨';
  if (eff < 40) return '🌤️';
  if (eff < 70) return '⛅';
  if (eff < 90) return '🌥️';
  return '☁️';
}

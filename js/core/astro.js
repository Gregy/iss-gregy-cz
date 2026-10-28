// Astronomy helpers: sun position, ISS illumination, look angles, brightness.
// Shared by the page and the service worker (pure functions, no DOM).
import * as sat from '../../vendor/satellite.esm.js';

export const RE = 6378.137; // km, WGS84 equatorial radius
const DEG = Math.PI / 180;
const AU = 149597870.7; // km

export const deg = (r) => r / DEG;
export const rad = (d) => d * DEG;

const norm = (v) => {
  const l = Math.hypot(v.x, v.y, v.z);
  return { x: v.x / l, y: v.y / l, z: v.z / l };
};
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;
const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

/**
 * Low-precision solar coordinates (Astronomical Almanac, ~0.01° accuracy).
 * Returns right ascension/declination (rad) and an ECI unit vector + distance (km).
 */
export function sunEquatorial(date) {
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.46 + 0.9856474 * n) % 360;
  const g = rad((357.528 + 0.9856003 * n) % 360);
  const lambda = rad(L + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g));
  const eps = rad(23.439 - 0.0000004 * n);
  const R = (1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g)) * AU;
  const x = Math.cos(lambda);
  const y = Math.cos(eps) * Math.sin(lambda);
  const z = Math.sin(eps) * Math.sin(lambda);
  return {
    ra: Math.atan2(y, x),
    dec: Math.asin(z),
    eci: { x, y, z }, // unit vector
    distance: R,
  };
}

/** Sun altitude/azimuth (degrees) for an observer {lat, lon} in degrees. */
export function sunAltAz(date, lat, lon) {
  const { ra, dec } = sunEquatorial(date);
  const H = sat.gstime(date) + rad(lon) - ra;
  const phi = rad(lat);
  const alt = Math.asin(Math.sin(phi) * Math.sin(dec) + Math.cos(phi) * Math.cos(dec) * Math.cos(H));
  const az = Math.atan2(Math.sin(H), Math.cos(H) * Math.sin(phi) - Math.tan(dec) * Math.cos(phi)) + Math.PI;
  return { alt: deg(alt), az: (deg(az) + 360) % 360 };
}

/** Sub-solar point (degrees). */
export function subSolarPoint(date) {
  const { ra, dec } = sunEquatorial(date);
  let lon = deg(ra - sat.gstime(date));
  lon = ((lon + 540) % 360) - 180;
  return { lat: deg(dec), lon };
}

/**
 * Is a satellite at ECI position r (km) illuminated by the sun?
 * Treats the Earth as a sphere seen from the satellite: the satellite is in
 * shadow when the sun's centre lies within the Earth's apparent disc.
 */
export function isSunlit(r, sunUnit) {
  const d = Math.hypot(r.x, r.y, r.z);
  const toEarth = { x: -r.x / d, y: -r.y / d, z: -r.z / d };
  const earthRadiusAngle = Math.asin(RE / d);
  const sepAngle = Math.acos(Math.max(-1, Math.min(1, dot(toEarth, sunUnit))));
  return sepAngle > earthRadiusAngle;
}

/**
 * Approximate visual magnitude of the ISS.
 * Diffuse-sphere phase law normalised to 1 at 90° phase; standard magnitude
 * -1.3 at 1000 km tuned so good overhead passes land near -3.5…-4.
 */
export function issMagnitude(rangeKm, phaseAngleRad, stdMag = -1.3) {
  const p = phaseAngleRad;
  const F = Math.sin(p) + (Math.PI - p) * Math.cos(p);
  if (F <= 0) return 99;
  return stdMag + 5 * Math.log10(rangeKm / 1000) - 2.5 * Math.log10(F);
}

const EXTINCTION = 0.2; // magnitudes lost per airmass, typical for a clear sky

/**
 * Dimming by the atmosphere at elevation `elDeg`: about 0.2 mag straight up,
 * 0.6 at 20°, 1.1 at 10° (Kasten & Young airmass).
 */
export function extinction(elDeg) {
  if (elDeg <= 0) return 0;
  return EXTINCTION / (Math.sin(rad(elDeg)) + 0.50572 * (elDeg + 6.07995) ** -1.6364);
}

export function makeObserver(lat, lon, heightM = 0) {
  return { latitude: rad(lat), longitude: rad(lon), height: heightM / 1000, lat, lon };
}

/**
 * Full state of the satellite at `date` relative to an (optional) observer.
 * Returns null if propagation fails (decayed / bad TLE).
 */
export function satState(satrec, date, observer, sunEq = sunEquatorial(date)) {
  const pv = sat.propagate(satrec, date);
  if (!pv || !pv.position || typeof pv.position === 'boolean') return null;
  const gmst = sat.gstime(date);
  const r = pv.position;
  const v = pv.velocity;
  const gd = sat.eciToGeodetic(r, gmst);
  const out = {
    t: date.getTime(),
    eci: r,
    lat: deg(gd.latitude),
    lon: deg(gd.longitude),
    alt: gd.height,
    speed: Math.hypot(v.x, v.y, v.z), // km/s (inertial)
    sunlit: isSunlit(r, sunEq.eci),
  };
  if (observer) {
    const ecf = sat.eciToEcf(r, gmst);
    const look = sat.ecfToLookAngles(observer, ecf);
    out.az = (deg(look.azimuth) + 360) % 360;
    out.el = deg(look.elevation);
    out.range = look.rangeSat;
    const obsEci = sat.ecfToEci(sat.geodeticToEcf(observer), gmst);
    const toObs = norm(sub(obsEci, r));
    const phase = Math.acos(Math.max(-1, Math.min(1, dot(toObs, sunEq.eci))));
    // as seen from the ground, including the atmosphere
    out.mag = out.sunlit ? issMagnitude(out.range, phase) + extinction(out.el) : null;
  }
  return out;
}

/** Elevation only — the hot path for pass search. */
export function elevationAt(satrec, date, observer) {
  const pv = sat.propagate(satrec, date);
  if (!pv || !pv.position || typeof pv.position === 'boolean') return -90;
  const ecf = sat.eciToEcf(pv.position, sat.gstime(date));
  return deg(sat.ecfToLookAngles(observer, ecf).elevation);
}

/**
 * Radius (km along the surface) of the area from which the satellite is
 * above `minEl` degrees, for a satellite at height h km.
 */
export function footprintRadiusKm(h, minEl = 0) {
  const e = rad(minEl);
  const lambda = Math.acos((RE / (RE + h)) * Math.cos(e)) - e;
  return lambda * RE;
}

/** Destination point given start (deg), bearing (deg) and angular distance (rad). */
export function destination(lat, lon, bearingDeg, ang) {
  const p1 = rad(lat), l1 = rad(lon), b = rad(bearingDeg);
  const p2 = Math.asin(Math.sin(p1) * Math.cos(ang) + Math.cos(p1) * Math.sin(ang) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(ang) * Math.cos(p1), Math.cos(ang) - Math.sin(p1) * Math.sin(p2));
  return { lat: deg(p2), lon: deg(l2) };
}

/** Compass label for an azimuth. */
export function compass(az) {
  const pts = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
  return pts[Math.round(az / 22.5) % 16];
}

export function parseTle(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const i = lines.findIndex((l) => l.startsWith('1 25544'));
  if (i < 0 || !lines[i + 1]?.startsWith('2 25544')) throw new Error('No ISS TLE found');
  const l1 = lines[i], l2 = lines[i + 1];
  const satrec = sat.twoline2satrec(l1, l2);
  if (satrec.error) throw new Error('Invalid TLE');
  const epoch = (satrec.jdsatepoch - 2440587.5) * 86400000;
  return { l1, l2, satrec, epoch };
}

export { sat };

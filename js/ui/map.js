// Leaflet world map: day/night imagery, ISS marker, ground track (coloured by
// sunlight), visibility footprint and the observer.
// Leaflet is loaded as a classic script (global L).
import { satState, subSolarPoint, footprintRadiusKm, destination, RE } from '../core/astro.js';

const L = window.L;
// overlays crossing the antimeridian are drawn once more on each side
const COPIES = [-360, 0, 360];
// pan freely east–west (the world repeats), but not past the poles
const LAT_LIMIT = [[-85.0511, -Infinity], [85.0511, Infinity]];
const LONG_PRESS_MS = 600;
const GIBS = 'https://gibs.earthdata.nasa.gov/wmts/epsg3857/best';
const GIBS_MAX_ZOOM = 8;

const ISS_SVG = `<svg viewBox="0 0 64 64" width="36" height="36" aria-hidden="true">
  <g stroke="#0b1020" stroke-width="1">
    <rect x="20" y="45" width="24" height="4" fill="#7aa2ff"/>
    <rect x="28.5" y="15" width="7" height="38" rx="3" fill="#e9eefc"/>
    <rect x="21" y="21" width="5.5" height="9" fill="#f4f6fb"/><rect x="37.5" y="21" width="5.5" height="9" fill="#f4f6fb"/>
    <rect x="1" y="30" width="62" height="4" rx="1" fill="#c9d1e6"/>
    <g fill="#f0b245">
      <rect x="2" y="10" width="7" height="19"/><rect x="10" y="10" width="7" height="19"/>
      <rect x="47" y="10" width="7" height="19"/><rect x="55" y="10" width="7" height="19"/>
      <rect x="2" y="35" width="7" height="19"/><rect x="10" y="35" width="7" height="19"/>
      <rect x="47" y="35" width="7" height="19"/><rect x="55" y="35" width="7" height="19"/>
    </g>
    <path d="M2 14.75h15M2 19.5h15M2 24.25h15M47 14.75h15M47 19.5h15M47 24.25h15M2 39.75h15M2 44.5h15M2 49.25h15M47 39.75h15M47 44.5h15M47 49.25h15" stroke-width=".6" opacity=".45"/>
  </g></svg>`;

const RINGS = [
  { minEl: 0, cls: 'foot-horizon', info: '<b>Horizon zone</b><br>Inside, the ISS is above the horizon, but near the edge too low to see.' },
  { minEl: 10, cls: 'foot-visible', info: "<b>Visible zone</b><br>Inside, the ISS is at least 10° up: visible if your sky is dark and it's sunlit." },
];
const POPUP = { className: 'map-tip', closeButton: false, autoPan: false, maxWidth: 230 };
// Leaflet simplifies lines on screen by default, which turns small rings into polygons
const CRISP = { smoothFactor: 0 };

// ...and rounds every point to a whole pixel, which makes small rings look jagged.
const SubPixel = {
  _projectLatlngs(latlngs, result, pxBounds) {
    if (latlngs[0] instanceof L.LatLng) {
      const origin = this._map.getPixelOrigin();
      const ring = latlngs.map((ll) => {
        const p = this._map.project(ll)._subtract(origin);
        return L.point(Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10); // 0.1 px keeps the SVG path short
      });
      ring.forEach((p) => pxBounds.extend(p));
      result.push(ring);
    } else for (const l of latlngs) this._projectLatlngs(l, result, pxBounds);
  },
};
const SmoothPolygon = L.Polygon.extend(SubPixel);
const SmoothPolyline = L.Polyline.extend(SubPixel);

/** The copy of longitude `lon` (±360°·n) closest to `ref`. */
const near = (lon, ref) => lon + 360 * Math.round((ref - lon) / 360);

/** Shift longitudes so consecutive points never jump by more than 180°. */
function unwrap(points) {
  let off = 0;
  return points.map((p, i) => {
    if (i > 0) {
      const d = p.lon + off - points[i - 1].lonU;
      if (d > 180) off -= 360; else if (d < -180) off += 360;
    }
    p.lonU = p.lon + off;
    return p;
  });
}

// --- day/night imagery: Blue Marble by day, Black Marble city lights by night ---
// Both are drawn into ONE canvas per tile and blended by the sun's altitude.
// (Two stacked tile layers let the lower one show through the hairline gaps
// some browsers leave between tiles.)

const MASK = 64; // mask samples per tile edge (4 px cells, smoothed when scaled up)
const maskCanvas = document.createElement('canvas');
maskCanvas.width = maskCanvas.height = MASK;
const maskCtx = maskCanvas.getContext('2d');
const maskData = maskCtx.createImageData(MASK, MASK);
const nightCanvas = document.createElement('canvas');
nightCanvas.width = nightCanvas.height = 256;
const nightCtx = nightCanvas.getContext('2d');

/** 0 in daylight → 1 in full night; the blend spans sunset to nautical dusk (sun 0° … −12°). */
function nightness(sinAlt) {
  const alt = Math.asin(sinAlt) * 180 / Math.PI;
  const x = Math.min(1, Math.max(0, (0.5 - alt) / 12.5));
  return x * x * (3 - 2 * x); // smoothstep
}

// Decoded imagery, most recently used last. Panning into another copy of the
// world creates new tiles for the same imagery; these paint at once instead of
// reloading and fading in.
const imageCache = new Map();
const IMAGE_CACHE_SIZE = 200;

function fetchImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function loadImage(src) {
  let entry = imageCache.get(src);
  if (entry) imageCache.delete(src);
  else {
    entry = { img: null };
    // GIBS now and then answers 500 (which the browser reports as a CORS error): retry twice
    entry.promise = (async () => {
      for (let attempt = 0; ; attempt++) {
        try {
          return (entry.img = await fetchImage(src));
        } catch (e) {
          if (attempt >= 2) { imageCache.delete(src); throw e; }
          await new Promise((r) => setTimeout(r, 700 * (attempt + 1)));
        }
      }
    })();
    if (imageCache.size >= IMAGE_CACHE_SIZE) imageCache.delete(imageCache.keys().next().value);
  }
  imageCache.set(src, entry);
  return entry;
}

const DayNightLayer = L.GridLayer.extend({
  initialize(dayUrl, nightUrl, options) {
    this._urls = [dayUrl, nightUrl];
    this._date = new Date();
    L.setOptions(this, options);
  },

  setDate(date) {
    this._date = date;
    for (const t of Object.values(this._tiles)) if (t.el._imgs) this._paint(t.el, this._wrapCoords(t.coords));
  },

  createTile(coords, done) {
    const tile = document.createElement('canvas');
    tile.width = tile.height = 256;
    const f = 2 ** Math.max(0, coords.z - GIBS_MAX_ZOOM); // beyond z8: crop and scale a z8 tile
    const url = (u) => u.replace('{z}', Math.min(coords.z, GIBS_MAX_ZOOM)).replace('{x}', Math.floor(coords.x / f)).replace('{y}', Math.floor(coords.y / f));
    const entries = this._urls.map((u) => loadImage(url(u)));
    tile._instant = entries.every((e) => e.img);
    Promise.allSettled(entries.map((e) => e.promise)).then(([day, night]) => {
      if (day.status === 'rejected') return done(day.reason, tile);
      tile._imgs = [day.value, night.value]; // without night imagery the tile shows daylight only
      this._paint(tile, coords);
      done(null, tile);
    });
    return tile;
  },

  _tileReady(coords, err, tile) {
    L.GridLayer.prototype._tileReady.call(this, coords, err, tile);
    // already-seen imagery: skip the fade-in
    const t = this._tiles[this._tileCoordsToKey(coords)];
    if (t && tile?._instant) { t.loaded = 1; L.DomUtil.setOpacity(t.el, 1); } // as if loaded long ago (0 means "not loaded")
  },

  _paint(tile, coords) {
    const [day, night] = tile._imgs;
    const f = 2 ** Math.max(0, coords.z - GIBS_MAX_ZOOM);
    const s = 256 / f, sx = (coords.x % f) * s, sy = (coords.y % f) * s;
    const ctx = tile.getContext('2d');
    if (!night) return ctx.drawImage(day, sx, sy, s, s, 0, 0, 256, 256);

    // alpha mask from the sun's altitude at each sample (web mercator → lat/lon)
    const sun = subSolarPoint(this._date);
    const sd = Math.sin(sun.lat * Math.PI / 180), cd = Math.cos(sun.lat * Math.PI / 180);
    const W = 256 * 2 ** coords.z;
    const px = maskData.data;
    for (let j = 0; j < MASK; j++) {
      const gy = coords.y * 256 + (j + 0.5) * (256 / MASK);
      const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / W)));
      const sl = Math.sin(lat), cl = Math.cos(lat);
      for (let i = 0; i < MASK; i++) {
        const gx = coords.x * 256 + (i + 0.5) * (256 / MASK);
        const lon = (gx / W) * 2 * Math.PI - Math.PI;
        px[(j * MASK + i) * 4 + 3] = Math.round(nightness(sl * sd + cl * cd * Math.cos(lon - sun.lon * Math.PI / 180)) * 255);
      }
    }
    maskCtx.putImageData(maskData, 0, 0);

    // night imagery cut by the mask, then laid over the day imagery
    nightCtx.globalCompositeOperation = 'source-over';
    nightCtx.clearRect(0, 0, 256, 256);
    nightCtx.drawImage(night, sx, sy, s, s, 0, 0, 256, 256);
    nightCtx.globalCompositeOperation = 'destination-in';
    nightCtx.imageSmoothingEnabled = true;
    nightCtx.drawImage(maskCanvas, 0, 0, MASK, MASK, 0, 0, 256, 256);

    ctx.drawImage(day, sx, sy, s, s, 0, 0, 256, 256);
    ctx.drawImage(nightCanvas, 0, 0);
  },
});

export class IssMap {
  constructor(el, { onLongPress } = {}) {
    this.map = L.map(el, {
      zoomControl: false, maxZoom: 10, // whole zoom levels: fractional ones leave hairline seams between tiles
      // no worldCopyJump: jumping back a world rebuilds every visible tile
      maxBounds: LAT_LIMIT, maxBoundsViscosity: 1, worldCopyJump: false,
    }).setView([20, 0], 2);
    L.control.zoom({ position: 'topright' }).addTo(this.map);
    this.fitMinZoom();
    this.map.setZoom(this.map.getMinZoom(), { animate: false });
    this.map.on('resize', () => this.fitMinZoom());

    // NASA GIBS: public domain, no API key, CORS-enabled
    this.imagery = new DayNightLayer(
      `${GIBS}/BlueMarble_ShadedRelief_Bathymetry/default/2004-08-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg`,
      `${GIBS}/VIIRS_Black_Marble/default/2016-01-01/GoogleMapsCompatible_Level8/{z}/{y}/{x}.png`,
      {
        className: 'imagery',
        attribution: 'Imagery <a href="https://earthdata.nasa.gov/gibs" target="_blank" rel="noopener">NASA GIBS</a> Blue Marble, Black Marble',
      },
    ).addTo(this.map);

    // Track lines and visibility rings are created once and moved every second
    // (recreating them would close an open popup and churn the DOM).
    this.trackPool = {}; // class → polylines, reused between redraws
    // outer ring first so the inner one is on top; click for an explanation
    this.rings = RINGS.map((ring) => ({
      ...ring,
      polys: COPIES.map(() => new SmoothPolygon([], { ...CRISP, className: ring.cls }).bindPopup(ring.info, POPUP).addTo(this.map)),
    }));
    this.obsLayer = L.layerGroup().addTo(this.map);
    this.marker = L.marker([0, 0], {
      icon: L.divIcon({ className: 'iss-icon', html: ISS_SVG, iconSize: [36, 36], iconAnchor: [18, 18], popupAnchor: [0, -12] }),
      zIndexOffset: 1000, keyboard: false,
    }).bindPopup('', POPUP).addTo(this.map);

    // Single markers sit on the world copy nearest the view centre; panning
    // into the next copy moves them (and their rings and track) along.
    this.map.on('move', () => this.rewrap());
    if (onLongPress) this.setupLongPress(onLongPress);
  }

  /**
   * Touch long-press and right-click arrive as `contextmenu`. A mouse
   * long-press doesn't, so time it here: hold still, then release.
   */
  setupLongPress(onLongPress) {
    const el = this.map.getContainer();
    const ring = L.DomUtil.create('div', 'press-ring', el);
    let press = null, swallowClick = false, last = 0;
    const fire = (latlng) => {
      if (Date.now() - last < 1000) return;
      last = Date.now();
      setTimeout(() => onLongPress(latlng.wrap())); // after Leaflet has seen the mouseup
    };
    const cancel = () => {
      if (!press) return;
      clearTimeout(press.timer);
      ring.className = 'press-ring';
      press = null;
    };
    el.addEventListener('pointerdown', (e) => {
      cancel();
      swallowClick = false;
      if (e.pointerType !== 'mouse' || e.button !== 0 || e.target.closest('.leaflet-marker-icon, .leaflet-popup, .leaflet-control')) return;
      const pt = this.map.mouseEventToContainerPoint(e);
      press = { x: e.clientX, y: e.clientY, latlng: this.map.containerPointToLatLng(pt), ready: false };
      press.timer = setTimeout(() => { press.ready = true; ring.classList.add('ready'); }, LONG_PRESS_MS);
      ring.style.left = `${pt.x}px`;
      ring.style.top = `${pt.y}px`;
      requestAnimationFrame(() => press && ring.classList.add('on'));
    });
    el.addEventListener('pointermove', (e) => {
      if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) cancel();
    });
    el.addEventListener('pointerup', () => {
      if (press?.ready) { swallowClick = true; fire(press.latlng); }
      cancel();
    });
    el.addEventListener('pointercancel', cancel);
    el.addEventListener('pointerleave', cancel);
    // the release shouldn't also open a ring's popup
    el.addEventListener('click', (e) => { if (swallowClick) { swallowClick = false; e.stopPropagation(); } }, true);
    this.map.on('contextmenu', (e) => fire(e.latlng));
  }

  /** Re-place the ISS, its rings and track and the observer on the copy of the world in view. */
  rewrap() {
    const c = this.map.getCenter().lng;
    if (this.iss && near(this.iss.lon, c) !== this.issLon) {
      this.updateIss(this.iss);
      if (this.track) this.drawTrack(...this.track);
    }
    if (this.loc && near(this.loc.lon, c) !== this.obsLon) this.setObserver(this.loc);
  }

  /** Lowest zoom at which one world copy fills the map area, so no place is shown twice. */
  fitMinZoom() {
    const { x, y } = this.map.getSize();
    if (!x || !y) return;
    const z = Math.max(0, Math.ceil(Math.log2(Math.max(x, y) / 256)));
    this.map.setMinZoom(z);
    if (this.map.getZoom() < z) this.map.setZoom(z);
  }

  /** The whole world in view (widest zoom), centred on the ISS. Waits until the map has a size. */
  focusIss() {
    if (!this.iss) return;
    if (!this.map.getSize().x) { this.map.once('resize', () => this.focusIss()); return; }
    this.fitMinZoom();
    this.map.setView([this.iss.lat, this.iss.lon], this.map.getMinZoom(), { animate: false });
  }

  updateIss(state) {
    this.iss = state;
    this.issLon = near(state.lon, this.map.getCenter().lng);
    this.marker.setLatLng([state.lat, this.issLon]);
    this.marker.getElement()?.classList.toggle('eclipsed', !state.sunlit);
    const info = `<b>ISS</b> · ${Math.round(state.alt)} km up · ${(Math.round(state.speed * 36) * 100).toLocaleString()} km/h<br>${state.sunlit ? 'In sunlight' : "In Earth's shadow, not visible"}`;
    if (this.marker.getPopup().getContent() !== info) this.marker.setPopupContent(info);
    this.drawFootprint(state, this.issLon - state.lon);
  }

  drawFootprint(state, shift) {
    for (const ring of this.rings) {
      const km = footprintRadiusKm(state.alt, ring.minEl);
      const pts = [];
      for (let b = 0; b <= 360; b += 1) pts.push(destination(state.lat, state.lon, b, km / RE));
      unwrap(pts);
      ring.polys.forEach((poly, i) => poly.setLatLngs(pts.map((p) => [p.lat, p.lonU + shift + COPIES[i]])));
    }
  }

  /** Ground track for exactly one orbit around `now` (longer would loop back next to the ISS). */
  drawTrack(satrec, now = Date.now()) {
    this.track = [satrec, now];
    const pts = [];
    // sampled relative to `now`, so the past/future split is exactly at the ISS
    for (let k = -80; k <= 100; k++) {
      const t = now + k * 30e3;
      const s = satState(satrec, new Date(t));
      if (s) pts.push({ ...s, past: k < 0 });
    }
    unwrap(pts);
    const iss = pts.find((p) => !p.past);
    const shift = iss ? near(iss.lonU, this.map.getCenter().lng) - iss.lonU : 0;
    // split into runs of equal (past, sunlit) so colour can change along the track
    const runs = [];
    for (const p of pts) {
      const key = `${p.past}|${p.sunlit}`;
      const last = runs[runs.length - 1];
      if (last && last.key === key) last.pts.push(p);
      else if (last && last.past !== p.past) {
        // past → future: both meet exactly at the ISS (the k = 0 sample)
        last.pts.push(p);
        runs.push({ key, past: p.past, sunlit: p.sunlit, pts: [p] });
      } else runs.push({ key, past: p.past, sunlit: p.sunlit, pts: last ? [last.pts[last.pts.length - 1], p] : [p] });
    }
    const used = {};
    for (const r of runs) {
      const cls = r.past ? 'track-past' : r.sunlit ? 'track-lit' : 'track-dark';
      const pool = (this.trackPool[cls] ??= []);
      for (const o of COPIES) {
        const n = (used[cls] = (used[cls] || 0) + 1) - 1;
        pool[n] ??= new SmoothPolyline([], { ...CRISP, className: cls, interactive: false }).addTo(this.map);
        pool[n].setLatLngs(r.pts.map((p) => [p.lat, p.lonU + shift + o]));
      }
    }
    // park the lines this redraw didn't need
    for (const [cls, pool] of Object.entries(this.trackPool)) pool.slice(used[cls] || 0).forEach((l) => l.setLatLngs([]));
  }

  /** Move the day/night boundary to `date`. */
  updateDaylight(date = new Date()) {
    this.imagery.setDate(date);
  }

  setObserver(loc) {
    this.loc = loc;
    this.obsLayer.clearLayers();
    if (!loc) return;
    this.obsLon = near(loc.lon, this.map.getCenter().lng);
    L.circleMarker([loc.lat, this.obsLon], { radius: 6, className: 'observer' }).bindPopup(`<b>${loc.name || 'You'}</b><br>Your viewing location`, POPUP).addTo(this.obsLayer);
  }

  focusObserver(loc) {
    this.map.setView([loc.lat, near(loc.lon, this.map.getCenter().lng)], Math.max(this.map.getMinZoom(), 3));
  }

  invalidate() { this.map.invalidateSize(); }
}

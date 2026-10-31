'use strict';

/**
 * Server-side place search against OpenStreetMap (Nominatim, then Photon).
 * When neither answers, the API returns 503 and the browser queries OpenStreetMap itself.
 */

const NOMINATIM_URL = process.env.NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const PHOTON_URL = process.env.PHOTON_URL || 'https://photon.komoot.io';
const USER_AGENT = process.env.GEOCODER_USER_AGENT || 'oujda-transit/1.0 (+https://github.com/tiralmos/oujda-transit)';
const DISABLED = /^(1|true|yes)$/i.test(process.env.DISABLE_SERVER_GEOCODING || '');
const TIMEOUT_MS = Number(process.env.GEOCODER_TIMEOUT_MS || 4000);
const COOLDOWN_MS = 60_000; // after a failure, skip the server path for a minute
const CACHE_MAX = 1000;
const CACHE_TTL_MS = 24 * 3600 * 1000;

const cache = new Map();
let unavailableUntil = 0;
let lastNominatimCall = 0;

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.t > CACHE_TTL_MS) { cache.delete(key); return null; }
  cache.delete(key); cache.set(key, hit); // refresh LRU position
  return hit.v;
}
function cacheSet(key, v) {
  cache.set(key, { t: Date.now(), v });
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
}

async function getJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json', 'Accept-Language': 'fr,ar,en' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

function viewbox(bounds, pad = 0.05) {
  const [[minLat, minLng], [maxLat, maxLng]] = bounds;
  return [minLng - pad, maxLat + pad, maxLng + pad, minLat - pad];
}

async function nominatim(q, bounds) {
  // Nominatim usage policy: at most one request per second.
  const wait = lastNominatimCall + 1000 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastNominatimCall = Date.now();
  const params = new URLSearchParams({
    q, format: 'jsonv2', limit: '8', addressdetails: '1', countrycodes: 'ma',
    viewbox: viewbox(bounds).join(','), bounded: '1',
  });
  const data = await getJson(`${NOMINATIM_URL}/search?${params}`);
  return data.map((p) => ({
    name: p.name || p.display_name.split(',')[0],
    detail: p.display_name,
    lat: parseFloat(p.lat),
    lng: parseFloat(p.lon),
    type: p.type || p.category,
    source: 'nominatim',
  }));
}

async function photon(q, bounds) {
  const [[minLat, minLng], [maxLat, maxLng]] = bounds;
  const vb = viewbox(bounds);
  const params = new URLSearchParams({
    q, limit: '8', lat: String((minLat + maxLat) / 2), lon: String((minLng + maxLng) / 2),
    bbox: [vb[0], vb[3], vb[2], vb[1]].join(','), // minLon,minLat,maxLon,maxLat
  });
  const data = await getJson(`${PHOTON_URL}/api/?${params}`);
  return (data.features || []).map((f) => {
    const p = f.properties || {};
    const detail = [p.name, p.street, p.district, p.city].filter(Boolean).join(', ');
    return {
      name: p.name || p.street || detail,
      detail,
      lat: f.geometry.coordinates[1],
      lng: f.geometry.coordinates[0],
      type: p.osm_value,
      source: 'photon',
    };
  });
}

function dedupe(places) {
  const out = [];
  for (const p of places) {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng) || !p.name) continue;
    if (out.some((o) => o.name === p.name && Math.abs(o.lat - p.lat) < 0.0005 && Math.abs(o.lng - p.lng) < 0.0005)) continue;
    out.push(p);
  }
  return out.slice(0, 8);
}

/** Returns { places } or throws an Error with .code = 'UNAVAILABLE'. */
async function searchPlaces(q, bounds) {
  const key = q.trim().toLowerCase();
  const cached = cacheGet(key);
  if (cached) return { places: cached, cached: true };
  if (DISABLED || Date.now() < unavailableUntil) {
    throw Object.assign(new Error('server geocoding unavailable'), { code: 'UNAVAILABLE' });
  }
  const errors = [];
  let results = [];
  for (const provider of [nominatim, photon]) {
    try {
      results = results.concat(await provider(q, bounds));
      if (results.length >= 3) break;
    } catch (e) {
      errors.push(e.message);
    }
  }
  if (errors.length === 2) {
    unavailableUntil = Date.now() + COOLDOWN_MS;
    throw Object.assign(new Error(errors.join('; ')), { code: 'UNAVAILABLE' });
  }
  const places = dedupe(results);
  cacheSet(key, places);
  return { places, cached: false };
}

module.exports = { searchPlaces, NOMINATIM_URL, PHOTON_URL };

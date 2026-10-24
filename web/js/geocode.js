// Address and place search. The server's /api/geocode endpoint forwards to a
// Nominatim instance limited to the Oujda area (see docker/40-oujda-config.sh).
// If the server can't reach it, the browser asks Nominatim directly (when
// configured). Only called when the user asks for it, never while typing, as
// Nominatim's usage policy requires.

const cache = new Map();

export class GeocodeError extends Error {
  constructor(status) {
    super(`HTTP ${status}`);
    this.status = status; // 0: network error or unreadable answer
  }
}

// Turn Nominatim "jsonv2" results into { name, detail, lat, lng }.
export function parseResults(results) {
  if (!Array.isArray(results)) return [];
  const seen = new Set();
  const out = [];
  for (const r of results) {
    const lat = Number(r.lat), lng = Number(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const parts = String(r.display_name || '').split(',').map((p) => p.trim()).filter(Boolean);
    const name = (r.name && String(r.name).trim()) || parts[0] || '';
    if (!name) continue;
    // The few parts after the name (street, neighbourhood); the rest is city,
    // province, region, postcode and country, the same for every result.
    const detail = parts.filter((p) => p !== name).slice(0, 3).join(', ');
    const key = `${name}|${detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, detail, lat, lng });
  }
  return out;
}

// The URL the browser uses when it asks the geocoder itself.
export function directUrl(base, viewbox, query, lang) {
  const params = new URLSearchParams({
    format: 'jsonv2', limit: '8', bounded: '1', countrycodes: 'ma',
    viewbox, 'accept-language': lang, q: query,
  });
  return `${base}?${params}`;
}

async function getJson(url, options) {
  let res;
  try {
    res = await fetch(url, options);
  } catch {
    throw new GeocodeError(0);
  }
  if (!res.ok) throw new GeocodeError(res.status);
  try {
    return await res.json();
  } catch {
    throw new GeocodeError(0);
  }
}

// fallback: { url, viewbox } of the geocoder for the browser to try when the
// server can't reach it; left out, only the server is asked.
export async function geocode(query, lang, fallback) {
  const q = query.trim();
  const key = `${lang}|${q.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);
  let json;
  try {
    json = await getJson(`api/geocode?q=${encodeURIComponent(q)}&lang=${encodeURIComponent(lang)}`);
  } catch (err) {
    // 429 is the site-wide rate limit doing its job; don't go around it.
    if (!fallback?.url || err.status === 429) throw err;
    try {
      json = await getJson(directUrl(fallback.url, fallback.viewbox, q, lang), { credentials: 'omit' });
    } catch {
      throw err;
    }
  }
  const places = parseResults(json);
  cache.set(key, places);
  return places;
}

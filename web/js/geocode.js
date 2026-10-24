// Address and place search through the server's /api/geocode endpoint, which
// forwards to a Nominatim instance limited to the Oujda area (see
// docker/default.conf.template). Only called when the user asks for it,
// never while typing, as Nominatim's usage policy requires.

const cache = new Map();

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

export async function geocode(query, lang) {
  const q = query.trim();
  const key = `${lang}|${q.toLowerCase()}`;
  if (cache.has(key)) return cache.get(key);
  const res = await fetch(`api/geocode?q=${encodeURIComponent(q)}&lang=${encodeURIComponent(lang)}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const places = parseResults(await res.json());
  cache.set(key, places);
  return places;
}

'use strict';

// Road shapes for each line direction (data/shapes.geojson), so the map draws
// the street a bus drives on instead of straight segments between stops.
const fs = require('fs');
const path = require('path');
const { distance } = require('./util');

/** Nearest point to p on segment a-b, in lat/lng (fine at city scale). */
function project(p, a, b) {
  const k = Math.cos((p[0] * Math.PI) / 180);
  const ax = a[1] * k, ay = a[0], bx = b[1] * k, by = b[0], px = p[1] * k, py = p[0];
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  const q = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  return { q, d: distance(p[0], p[1], q[0], q[1]) };
}

/**
 * Where each stop sits on the shape, in order. A stop takes the earliest point
 * of the remaining shape that is within 25 m of its closest approach, so a line
 * that comes back along the same street does not jump ahead to the return leg.
 */
function cutStops(shape, pts) {
  const cuts = [];
  let from = 0;
  for (const p of pts) {
    const cand = [];
    for (let k = from; k < shape.length - 1; k++) cand.push({ k, ...project(p, shape[k], shape[k + 1]) });
    if (!cand.length) return null;
    const best = Math.min(...cand.map((c) => c.d));
    if (best > 150) {
      // a stop still to be placed by hand, off the drawn route: keep it at the previous stop's point
      const prev = cuts[cuts.length - 1] || { seg: 0, q: shape[0] };
      cuts.push({ seg: prev.seg, q: prev.q, off: true, d: best });
      continue;
    }
    const c = cand.find((x) => x.d <= best + 25);
    cuts.push({ seg: c.k, q: c.q });
    from = c.k;
  }
  return cuts;
}

/**
 * Cuts from the shape file's own stop positions (`stop_at`: share of the line's
 * length at each stop, null for a stop the route does not pass).
 */
function cutsFromFractions(shape, fr) {
  const acc = [0];
  for (let k = 1; k < shape.length; k++) acc.push(acc[k - 1] + distance(shape[k - 1][0], shape[k - 1][1], shape[k][0], shape[k][1]));
  const total = acc[acc.length - 1];
  const cuts = [];
  let k = 0;
  for (const f of fr) {
    if (f == null) { const prev = cuts[cuts.length - 1] || { seg: 0, q: shape[0] }; cuts.push({ seg: prev.seg, q: prev.q, off: true }); continue; }
    const m = Math.max(0, Math.min(1, f)) * total;
    while (k < shape.length - 2 && acc[k + 1] < m) k++;
    const L = acc[k + 1] - acc[k], t = L ? (m - acc[k]) / L : 0;
    cuts.push({ seg: k, q: [shape[k][0] + (shape[k + 1][0] - shape[k][0]) * t, shape[k][1] + (shape[k + 1][1] - shape[k][1]) * t] });
  }
  return cuts;
}

/** The shape between stop i and stop j (i < j) of a direction, as [[lat, lng], ...]. */
function slice(dir, i, j) {
  if (!dir.path || !dir.cuts) return null;
  const a = dir.cuts[i], b = dir.cuts[j];
  const out = [a.q];
  for (let k = a.seg + 1; k <= b.seg; k++) out.push(dir.path[k]);
  out.push(b.q);
  return out;
}

function pathLength(pts) {
  let m = 0;
  for (let i = 1; i < pts.length; i++) m += distance(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]);
  return m;
}

/** Attach `path` and `cuts` to every direction that has a matching shape. Returns how many matched. */
function attachShapes(dataDir, stops, lines) {
  const file = path.join(dataDir, 'shapes.geojson');
  if (!fs.existsSync(file)) return 0;
  let gj;
  try { gj = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { console.warn(`Ignoring ${file}: ${e.message}`); return 0; }
  const byKey = new Map();
  for (const f of gj.features || []) {
    const pr = f.properties || {};
    if (f.geometry?.type === 'LineString') byKey.set(`${pr.line}|${pr.direction}`, { shape: f.geometry.coordinates.map(([lng, lat]) => [lat, lng]), ids: pr.stop_ids, at: pr.stop_at });
  }
  let n = 0;
  for (const line of lines.values()) {
    for (const d of line.directions) {
      const entry = byKey.get(`${line.name}|${d.id}`);
      if (!entry || entry.shape.length < 2) continue;
      const { shape } = entry;
      const sameStops = Array.isArray(entry.ids) && Array.isArray(entry.at) && entry.ids.length === d.stops.length && entry.ids.every((x, i) => String(x) === d.stops[i]);
      const cuts = sameStops ? cutsFromFractions(shape, entry.at) : cutStops(shape, d.stops.map((id) => [stops.get(id).lat, stops.get(id).lng]));
      if (!cuts) { console.warn(`Shape of ${line.name} ${d.id} does not match its stops: drawing straight segments`); continue; }
      d.path = shape;
      d.cuts = cuts;
      d.length = Math.round(pathLength(slice(d, 0, d.stops.length - 1)));
      n++;
    }
  }
  return n;
}

module.exports = { attachShapes, slice, pathLength };

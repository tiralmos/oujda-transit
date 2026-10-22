// Distance and walking-time helpers. Pure functions, no DOM.

const EARTH_RADIUS_M = 6371008.8;

// Walking speed (m/min, about 4.8 km/h) and how much longer streets are than
// the straight line between two points.
export const WALK_M_PER_MIN = 80;
export const WALK_DETOUR = 1.25;

export function distanceM(a, b) {
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLng = (b.lng - a.lng) * rad;
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Estimated walking time in minutes for a straight-line distance in metres.
export function walkMinutes(meters) {
  return (meters * WALK_DETOUR) / WALK_M_PER_MIN;
}

// Stops within maxM metres of a point, nearest first.
export function stopsNear(stops, point, maxM, limit = Infinity) {
  const out = [];
  for (const stop of stops) {
    const d = distanceM(point, stop);
    if (d <= maxM) out.push({ stop, meters: d });
  }
  out.sort((x, y) => x.meters - y.meters);
  return out.slice(0, limit);
}

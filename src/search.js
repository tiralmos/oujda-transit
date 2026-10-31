'use strict';

const { normalize, similarity, distance } = require('./util');
const { publicStop } = require('./data');

function scoreText(q, text) {
  if (!q || !text) return 0;
  if (text === q) return 1;
  if (text.startsWith(q)) return 0.95;
  const words = text.split(' ');
  const tokens = q.split(' ');
  // Every query token is a prefix of some word in the text.
  const prefixHits = tokens.filter((t) => words.some((w) => w.startsWith(t))).length;
  if (prefixHits === tokens.length) return 0.85 + 0.05 * (tokens.length / words.length);
  if (text.includes(q)) return 0.8;
  const partial = prefixHits / tokens.length;
  const sim = similarity(q, text);
  return Math.max(sim, partial * 0.7, 0) * 0.85;
}

/**
 * Search stops (and lines, when the query looks like a line number).
 * Optional lat/lng bias ranks nearer stops slightly higher among equal matches.
 */
function searchStops(db, query, { limit = 12, lat, lng } = {}) {
  const q = normalize(query);
  if (!q) return { stops: [], lines: [] };

  const lines = [];
  const lineMatch = q.match(/^(?:l|ligne|line|bus)?\s*0*(\d{1,3})$/);
  for (const line of db.lines.values()) {
    const num = line.number.toLowerCase();
    if ((lineMatch && lineMatch[1] === num) || normalize(line.name) === q) {
      lines.push(publicLineSummary(line));
    }
  }

  const results = [];
  for (const s of db.stops.values()) {
    let score = scoreText(q, s._norm);
    if (score < 0.35) continue;
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      const d = distance(lat, lng, s.lat, s.lng);
      score += 0.03 * Math.max(0, 1 - d / 5000);
    }
    score += 0.002 * s.lines.length; // well-served stops first on ties
    results.push({ s, score });
  }
  results.sort((a, b) => b.score - a.score || a.s.name.localeCompare(b.s.name));
  return {
    stops: results.slice(0, limit).map(({ s, score }) => ({ ...publicStop(s), score: Math.round(score * 100) / 100 })),
    lines,
  };
}

function publicLineSummary(line) {
  return {
    id: line.id,
    name: line.name,
    number: line.number,
    color: line.color,
    textColor: line.textColor,
    from: line.directions[0]?.from,
    to: line.directions[0]?.to,
  };
}

/** Stops sorted by distance from a point. */
function nearbyStops(db, lat, lng, { limit = 10, radius = 1500 } = {}) {
  const out = [];
  for (const s of db.stops.values()) {
    const d = distance(lat, lng, s.lat, s.lng);
    if (d <= radius) out.push({ ...publicStop(s), distance: Math.round(d) });
  }
  out.sort((a, b) => a.distance - b.distance);
  return out.slice(0, limit);
}

module.exports = { searchStops, nearbyStops, publicLineSummary, scoreText };

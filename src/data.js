'use strict';

const fs = require('fs');
const path = require('path');
const { parseCsv, distance, normalize, prettyName } = require('./util');

// 24 hand-picked colours that stay distinguishable from each other on an OSM basemap.
const PALETTE = [
  '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#0fa3b1',
  '#f032e6', '#9a6324', '#469990', '#800000', '#808000', '#000075',
  '#d4a017', '#2e8b57', '#c71585', '#1e90ff', '#ff6f61', '#6b8e23',
  '#8b4513', '#5d3fd3', '#7f8c8d', '#b22222', '#ff8c00', '#4b0082',
];

function textColorFor(hex) {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return lum > 0.4 ? '#111111' : '#ffffff';
}

/** True when the CSV colours are unusable (placeholders like #000000, #000001 or duplicates). */
function colorsArePlaceholders(rows) {
  const colors = rows.map((r) => (r.line_color || '').toLowerCase());
  const valid = colors.filter((c) => /^#[0-9a-f]{6}$/.test(c));
  if (valid.length !== colors.length) return true;
  if (new Set(valid).size !== valid.length) return true;
  return valid.every((c) => /^#0000[0-9a-f]{2}$/.test(c));
}

function readCsv(dir, name) {
  return parseCsv(fs.readFileSync(path.join(dir, name), 'utf8'));
}

function load(dataDir) {
  const stopRows = readCsv(dataDir, 'stops.csv');
  const lineRows = readCsv(dataDir, 'lines.csv');
  const lineStopRows = readCsv(dataDir, 'line_stops.csv');

  const stops = new Map();
  for (const r of stopRows) {
    const lat = parseFloat(r.lat);
    const lng = parseFloat(r.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const name = prettyName(r.station_label || r.station_name);
    stops.set(String(r.station_id), {
      id: String(r.station_id),
      slug: r.station_name,
      name,
      lat,
      lng,
      lines: [],
      _norm: normalize(/^\d{4}-/.test(r.station_name) ? name : `${name} ${r.station_name.replace(/-/g, ' ')}`),
    });
  }

  const usePalette = colorsArePlaceholders(lineRows);
  const lines = new Map();
  lineRows
    .slice()
    .sort((a, b) => Number(a.line_id) - Number(b.line_id))
    .forEach((r, i) => {
      const color = usePalette ? PALETTE[i % PALETTE.length] : r.line_color.toLowerCase();
      lines.set(String(r.line_id), {
        id: String(r.line_id),
        name: r.line_name,
        number: r.line_name.replace(/^L0*/i, '') || r.line_name,
        color,
        textColor: textColorFor(color),
        directions: [],
      });
    });

  // Group line_stops into ordered directions.
  const groups = new Map();
  for (const r of lineStopRows) {
    const lineId = String(r.line_id);
    if (!lines.has(lineId)) continue;
    const key = `${lineId}|${r.direction}`;
    if (!groups.has(key)) groups.set(key, { lineId, direction: r.direction, rows: [] });
    groups.get(key).rows.push(r);
  }

  for (const g of groups.values()) {
    g.rows.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
    const stopIds = [];
    for (const r of g.rows) {
      const id = String(r.station_id);
      if (!stops.has(id)) {
        // Stop only present in line_stops: create it from that row.
        const lat = parseFloat(r.lat);
        const lng = parseFloat(r.lng);
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
        const name = prettyName(r.station_label || r.station_name);
        stops.set(id, { id, slug: r.station_name, name, lat, lng, lines: [], _norm: normalize(name) });
      }
      if (stopIds[stopIds.length - 1] !== id) stopIds.push(id);
    }
    if (stopIds.length < 2) continue;
    const line = lines.get(g.lineId);
    let length = 0;
    for (let i = 1; i < stopIds.length; i++) {
      const a = stops.get(stopIds[i - 1]);
      const b = stops.get(stopIds[i]);
      length += distance(a.lat, a.lng, b.lat, b.lng);
    }
    line.directions.push({
      id: g.direction,
      from: stops.get(stopIds[0]).name,
      to: stops.get(stopIds[stopIds.length - 1]).name,
      stops: stopIds,
      length: Math.round(length),
    });
    for (const id of stopIds) {
      const s = stops.get(id);
      if (!s.lines.includes(g.lineId)) s.lines.push(g.lineId);
    }
  }

  for (const line of lines.values()) {
    line.directions.sort((a, b) => (a.id === 'aller' ? -1 : b.id === 'aller' ? 1 : 0));
  }
  const lineOrder = [...lines.keys()];
  for (const s of stops.values()) s.lines.sort((a, b) => lineOrder.indexOf(a) - lineOrder.indexOf(b));

  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const s of stops.values()) {
    minLat = Math.min(minLat, s.lat); maxLat = Math.max(maxLat, s.lat);
    minLng = Math.min(minLng, s.lng); maxLng = Math.max(maxLng, s.lng);
  }

  return {
    stops,
    lines,
    bounds: [[minLat, minLng], [maxLat, maxLng]],
    generatedColors: usePalette,
  };
}

/** Public JSON shape of a stop (without internal fields). */
function publicStop(s) {
  return { id: s.id, name: s.name, lat: s.lat, lng: s.lng, lines: s.lines };
}

module.exports = { load, publicStop, PALETTE, textColorFor };

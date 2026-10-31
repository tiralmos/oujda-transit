'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { load, publicStop } = require('./data');
const { searchStops, nearbyStops, publicLineSummary } = require('./search');
const { searchPlaces } = require('./geocode');
const { buildIndex, plan } = require('./planner');
const { distance } = require('./util');

const PORT = Number(process.env.PORT || 3002);
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const PUBLIC_DIR = path.resolve(path.join(__dirname, '..', 'public'));
// URLs the *browser* uses when the server cannot reach OpenStreetMap.
const PUBLIC_NOMINATIM_URL = process.env.PUBLIC_NOMINATIM_URL || 'https://nominatim.openstreetmap.org';
const PUBLIC_PHOTON_URL = process.env.PUBLIC_PHOTON_URL || 'https://photon.komoot.io';
const TILE_URL = process.env.TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';

function createApp(dataDir = DATA_DIR) {
  const db = load(dataDir);
  const index = buildIndex(db);
  const version = String(fs.statSync(path.join(dataDir, 'line_stops.csv')).mtimeMs | 0);

  const lineDetail = (line) => ({
    ...publicLineSummary(line),
    directions: line.directions.map((d) => ({
      id: d.id, from: d.from, to: d.to, length: d.length,
      stops: d.stops.map((id) => publicStop(db.stops.get(id))),
    })),
  });

  const networkJson = JSON.stringify({
    version,
    bounds: db.bounds,
    stops: [...db.stops.values()].map(publicStop),
    lines: [...db.lines.values()].map((l) => ({
      ...publicLineSummary(l),
      directions: l.directions.map((d) => ({ id: d.id, from: d.from, to: d.to, length: d.length, stops: d.stops })),
    })),
  });

  const meta = {
    name: 'Oujda Transit',
    version,
    bounds: db.bounds,
    stopCount: db.stops.size,
    lineCount: db.lines.size,
    generatedColors: db.generatedColors,
    tileUrl: TILE_URL,
    geocoder: { nominatim: PUBLIC_NOMINATIM_URL, photon: PUBLIC_PHOTON_URL },
  };

  const hostOf = (u) => { try { return new URL(u).origin; } catch { return ''; } };
  const tileOrigin = hostOf(TILE_URL.replace(/\{s\}/g, 'a').replace(/\{[xyz]\}/g, '0'));
  const csp = [
    "default-src 'self'",
    `img-src 'self' data: ${tileOrigin} https://*.tile.openstreetmap.org`,
    `connect-src 'self' ${hostOf(PUBLIC_NOMINATIM_URL)} ${hostOf(PUBLIC_PHOTON_URL)} ${tileOrigin}`,
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "manifest-src 'self'",
    "worker-src 'self'",
  ].join('; ');

  function send(req, res, status, body, type = 'application/json; charset=utf-8', extra = {}) {
    let buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const headers = {
      'Content-Type': type,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      ...extra,
    };
    if (type.startsWith('text/html')) headers['Content-Security-Policy'] = csp;
    const compressible = /json|javascript|css|html|svg|manifest|text/.test(type);
    if (compressible && buf.length > 1024 && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
      buf = zlib.gzipSync(buf);
      headers['Content-Encoding'] = 'gzip';
      headers.Vary = 'Accept-Encoding';
    }
    headers['Content-Length'] = buf.length;
    res.writeHead(status, headers);
    res.end(req.method === 'HEAD' ? undefined : buf);
  }

  const json = (req, res, status, obj, cache = 'no-cache') => send(req, res, status, obj, undefined, { 'Cache-Control': cache });
  const num = (v) => (v === undefined || v === null || v === '' ? NaN : Number(v));
  const parsePoint = (s) => {
    const m = String(s || '').match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
    return m ? { lat: Number(m[1]), lng: Number(m[2]) } : null;
  };

  const MIME = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  };

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html'; // SPA routes
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return send(req, res, 403, 'Forbidden', 'text/plain');
    fs.readFile(file, (err, buf) => {
      if (err) return send(req, res, 404, 'Not found', 'text/plain; charset=utf-8');
      const ext = path.extname(file);
      const cache = rel.startsWith('/vendor/') ? 'public, max-age=604800, immutable' : 'no-cache';
      send(req, res, 200, buf, MIME[ext] || 'application/octet-stream', { 'Cache-Control': cache });
    });
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    const q = url.searchParams;
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(req, res, 405, { error: 'Method not allowed' });

    if (p === '/healthz') return json(req, res, 200, { ok: true, stops: db.stops.size, lines: db.lines.size });
    if (p === '/api/meta') return json(req, res, 200, meta);
    if (p === '/api/network') return send(req, res, 200, networkJson, undefined, { 'Cache-Control': 'no-cache', ETag: `"${version}"` });
    if (p === '/api/stops') return json(req, res, 200, [...db.stops.values()].map(publicStop));

    let m;
    if ((m = p.match(/^\/api\/stops\/([^/]+)$/))) {
      const s = db.stops.get(decodeURIComponent(m[1]));
      if (!s) return json(req, res, 404, { error: 'Stop not found' });
      const services = [];
      for (const lineId of s.lines) {
        const line = db.lines.get(lineId);
        for (const d of line.directions) {
          const i = d.stops.indexOf(s.id);
          if (i < 0) continue;
          services.push({
            line: publicLineSummary(line),
            direction: d.id,
            headsign: d.to,
            position: i + 1,
            total: d.stops.length,
            terminus: i === d.stops.length - 1,
            next: d.stops.slice(i + 1, i + 4).map((id) => db.stops.get(id).name),
          });
        }
      }
      const nearby = nearbyStops(db, s.lat, s.lng, { limit: 6, radius: 500 }).filter((n) => n.id !== s.id);
      return json(req, res, 200, { ...publicStop(s), services, nearby });
    }

    if (p === '/api/lines') {
      return json(req, res, 200, [...db.lines.values()].map((l) => ({
        ...publicLineSummary(l),
        directions: l.directions.map((d) => ({ id: d.id, from: d.from, to: d.to, stopCount: d.stops.length, length: d.length })),
      })));
    }
    if ((m = p.match(/^\/api\/lines\/([^/]+)$/))) {
      const key = decodeURIComponent(m[1]);
      const line = db.lines.get(key) || [...db.lines.values()].find((l) => l.name.toLowerCase() === key.toLowerCase());
      if (!line) return json(req, res, 404, { error: 'Line not found' });
      return json(req, res, 200, lineDetail(line));
    }

    if (p === '/api/search') {
      const text = (q.get('q') || '').slice(0, 120);
      return json(req, res, 200, searchStops(db, text, { lat: num(q.get('lat')), lng: num(q.get('lng')), limit: Math.min(30, num(q.get('limit')) || 12) }));
    }

    if (p === '/api/places') {
      const text = (q.get('q') || '').trim().slice(0, 120);
      if (text.length < 3) return json(req, res, 200, { places: [] });
      try {
        const r = await searchPlaces(text, db.bounds);
        // Attach nearest stop to each place so the UI can say "250 m from X".
        const places = r.places.map((pl) => {
          const near = nearbyStops(db, pl.lat, pl.lng, { limit: 1, radius: 3000 })[0];
          return { ...pl, nearestStop: near ? { id: near.id, name: near.name, distance: near.distance } : null };
        });
        return json(req, res, 200, { places, cached: r.cached }, 'public, max-age=3600');
      } catch (e) {
        // The browser falls back to querying OpenStreetMap directly.
        return json(req, res, 503, { error: 'Place search is unavailable on the server', fallback: meta.geocoder });
      }
    }

    if (p === '/api/nearby') {
      const lat = num(q.get('lat'));
      const lng = num(q.get('lng'));
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json(req, res, 400, { error: 'lat and lng are required' });
      return json(req, res, 200, nearbyStops(db, lat, lng, {
        limit: Math.min(50, num(q.get('limit')) || 10),
        radius: Math.min(5000, num(q.get('radius')) || 1000),
      }));
    }

    if (p === '/api/plan') {
      const from = parsePoint(q.get('from'));
      const to = parsePoint(q.get('to'));
      if (!from || !to) return json(req, res, 400, { error: 'from and to must be "lat,lng"' });
      const [[minLat, minLng], [maxLat, maxLng]] = db.bounds;
      const far = (pt) => distance(pt.lat, pt.lng, (minLat + maxLat) / 2, (minLng + maxLng) / 2) > 60000;
      if (far(from) || far(to)) return json(req, res, 400, { error: 'Points must be in the Oujda area' });
      from.name = (q.get('fromName') || '').slice(0, 120) || 'Départ';
      to.name = (q.get('toName') || '').slice(0, 120) || 'Arrivée';
      return json(req, res, 200, { from, to, itineraries: plan(db, index, from, to) });
    }

    if (p.startsWith('/api/')) return json(req, res, 404, { error: 'Not found' });
    return serveStatic(req, res, p);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) json(req, res, 500, { error: 'Internal error' });
    });
  });
  return { server, db };
}

if (require.main === module) {
  const { server, db } = createApp();
  server.listen(PORT, HOST, () => {
    console.log(`Oujda Transit: ${db.stops.size} stops, ${db.lines.size} lines — listening on http://${HOST}:${PORT}`);
  });
  const stop = () => server.close(() => process.exit(0));
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

module.exports = { createApp };

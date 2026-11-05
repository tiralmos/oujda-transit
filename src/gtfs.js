'use strict';

// Builds a GTFS feed (https://gtfs.org/schedule/reference/) from the app's data:
// the same stops, lines, generated colours and road shapes that the map shows.
//
// The data has no timetables, so the feed is frequency based: one template trip
// per line direction, with stop times estimated from the distance along the road
// and headways per period of the day taken from gtfs.json (see DEFAULT_CONFIG).
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { load } = require('./data');
const { slice, pathLength } = require('./shapes');
const { distance } = require('./util');

const DEFAULT_CONFIG = {
  agency: {
    agency_id: 'oujda',
    agency_name: 'Bus urbain Oujda',
    agency_url: 'https://github.com/tiralmos/oujda-transit',
    agency_timezone: 'Africa/Casablanca',
    agency_lang: 'fr',
    agency_phone: '',
  },
  feed: {
    feed_publisher_name: 'Oujda Transit',
    feed_publisher_url: 'https://github.com/tiralmos/oujda-transit',
    feed_lang: 'fr',
    feed_contact_email: '',
    feed_contact_url: 'https://github.com/tiralmos/oujda-transit/issues',
  },
  // First day of service ("YYYYMMDD"); empty means the day the feed is built.
  start_date: '',
  // How many days the feed is valid for.
  valid_days: 365,
  // Days of the week with service, Monday first.
  service_days: [1, 1, 1, 1, 1, 1, 1],
  // Average bus speed between stops and time spent at each stop.
  speed_kmh: 18,
  dwell_seconds: 20,
  // A bus leaves each terminus every `headway_min` minutes between `start` and `end`.
  periods: [
    { start: '06:00', end: '09:00', headway_min: 15 },
    { start: '09:00', end: '16:00', headway_min: 20 },
    { start: '16:00', end: '19:00', headway_min: 15 },
    { start: '19:00', end: '21:00', headway_min: 30 },
  ],
  // Per-line changes, e.g. { "L13": { "periods": [{ "start": "07:00", "end": "19:00", "headway_min": 40 }] } }
  lines: {},
  // Single flat fare for every line. Leave price empty to leave fares out of the feed.
  fare: { price: '', currency_type: 'MAD', payment_method: 0, transfers: 0 },
};

function readConfig(dataDir) {
  const file = path.join(dataDir, 'gtfs.json');
  let user = {};
  if (fs.existsSync(file)) user = JSON.parse(fs.readFileSync(file, 'utf8'));
  const cfg = { ...DEFAULT_CONFIG, ...user };
  for (const k of ['agency', 'feed', 'fare']) cfg[k] = { ...DEFAULT_CONFIG[k], ...(user[k] || {}) };
  return cfg;
}

// ---------- small helpers ----------

const csvField = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function toCsv(columns, rows) {
  const lines = [columns.join(',')];
  for (const r of rows) lines.push(columns.map((c) => csvField(r[c])).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

const hms = (sec) => {
  const s = Math.round(sec);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
};

const parseHm = (t) => {
  const m = String(t).match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) throw new Error(`Bad time "${t}" in gtfs.json (use HH:MM)`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] || 0);
};

/** Today's date in the agency's time zone as YYYYMMDD. */
function today(timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return parts.replace(/-/g, '');
}

function addDays(yyyymmdd, n) {
  const d = new Date(Date.UTC(Number(yyyymmdd.slice(0, 4)), Number(yyyymmdd.slice(4, 6)) - 1, Number(yyyymmdd.slice(6, 8))));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

const round6 = (x) => Math.round(x * 1e6) / 1e6;
const round1 = (x) => Math.round(x * 10) / 10;

/**
 * Road path of a direction from its first to its last stop, and how far along
 * it each stop is (metres). Falls back to straight segments between stops when
 * the direction has no shape.
 */
function geometry(d, stops) {
  const pts = d.stops.map((id) => [stops.get(id).lat, stops.get(id).lng]);
  if (!d.path || !d.cuts) {
    const at = [0];
    for (let i = 1; i < pts.length; i++) at.push(at[i - 1] + distance(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1]));
    return { path: pts, at, shaped: false, offRoute: [] };
  }
  const at = [0];
  for (let i = 1; i < d.stops.length; i++) at.push(Math.max(at[i - 1], pathLength(slice(d, 0, i))));
  const offRoute = d.cuts.map((c, i) => (c.off ? d.stops[i] : null)).filter(Boolean);
  return { path: slice(d, 0, d.stops.length - 1), at, shaped: true, offRoute };
}

// ---------- feed ----------

/**
 * Build every GTFS file as text. `db` is the result of data.load().
 * Returns { files: { 'stops.txt': '...', ... }, summary }.
 */
function buildFeed(db, cfg = DEFAULT_CONFIG) {
  const agencyId = cfg.agency.agency_id;
  const speed = (Number(cfg.speed_kmh) || 18) / 3.6;
  const dwell = Number(cfg.dwell_seconds) || 0;
  const start = cfg.start_date || today(cfg.agency.agency_timezone);
  const end = addDays(start, Math.max(1, Number(cfg.valid_days) || 365) - 1);
  const serviceId = 'daily';

  const served = new Set();
  const routes = [], trips = [], stopTimes = [], shapes = [], frequencies = [];
  const warnings = [];

  for (const line of db.lines.values()) {
    if (!line.directions.length) continue;
    const first = line.directions[0];
    routes.push({
      route_id: line.name,
      agency_id: agencyId,
      route_short_name: line.number,
      route_long_name: `${first.from} – ${first.to}`,
      route_type: 3,
      route_color: line.color.replace('#', '').toUpperCase(),
      route_text_color: line.textColor.replace('#', '').toUpperCase(),
      route_sort_order: Number(line.id),
    });

    const periods = (cfg.lines[line.name] && cfg.lines[line.name].periods) || cfg.periods;
    for (const d of line.directions) {
      const directionId = d.id === 'retour' ? 1 : 0;
      const tripId = `${line.name}_${d.id}`;
      const g = geometry(d, db.stops);
      if (!g.shaped) warnings.push(`${line.name} ${d.id}: no road shape, using straight lines between stops`);
      if (g.offRoute.length) warnings.push(`${line.name} ${d.id}: stop(s) ${g.offRoute.join(', ')} are off the drawn road`);

      trips.push({
        route_id: line.name,
        service_id: serviceId,
        trip_id: tripId,
        trip_headsign: d.to,
        direction_id: directionId,
        shape_id: tripId,
      });

      // Shape, without repeated points.
      let acc = 0, seq = 0, prev = null;
      for (const p of g.path) {
        if (prev) {
          const step = distance(prev[0], prev[1], p[0], p[1]);
          if (step < 0.05) continue;
          acc += step;
        }
        shapes.push({ shape_id: tripId, shape_pt_lat: round6(p[0]), shape_pt_lon: round6(p[1]), shape_pt_sequence: seq++, shape_dist_traveled: round1(acc) });
        prev = p;
      }
      const scale = g.at[g.at.length - 1] ? acc / g.at[g.at.length - 1] : 1; // keep stop distances on the shape's scale
      const off = new Set(g.offRoute);

      // Distance along the shape at each stop, strictly increasing as GTFS requires
      // (two stops at the same point are nudged 10 cm apart). Empty for a stop
      // that is not on the drawn road.
      const on = d.stops.map((id) => !off.has(id));
      const dist = g.at.map((x) => Math.min(acc, x * scale));
      const idx = dist.map((_, i) => i).filter((i) => on[i]);
      for (let k = 1; k < idx.length; k++) dist[idx[k]] = Math.max(dist[idx[k]], dist[idx[k - 1]] + 0.1);
      for (let k = idx.length - 2; k >= 0; k--) if (dist[idx[k + 1]] > acc) dist[idx[k + 1]] = acc; else break;
      for (let k = idx.length - 2; k >= 0; k--) dist[idx[k]] = Math.min(dist[idx[k]], dist[idx[k + 1]] - 0.1);

      // Template trip starting at the first period; frequencies repeat it.
      // Time between stops = road distance / speed + dwell. A stop off the drawn
      // road is reached in a straight line, which is never faster than the road.
      const pts = d.stops.map((id) => db.stops.get(id));
      const crow = (i, j) => distance(pts[i].lat, pts[i].lng, pts[j].lat, pts[j].lng);
      const times = [parseHm(periods[0].start)];
      let last = 0; // last stop on the road
      for (let i = 1; i < d.stops.length; i++) {
        let t = times[i - 1] + crow(i - 1, i) / speed;
        if (on[i]) {
          t = Math.max(t, times[last] + (g.at[i] - g.at[last]) / speed + dwell * (i - last - 1));
          last = i;
        }
        times.push(t + dwell);
      }
      d.stops.forEach((id, i) => {
        served.add(id);
        stopTimes.push({
          trip_id: tripId,
          arrival_time: hms(times[i]),
          departure_time: hms(times[i]),
          stop_id: id,
          stop_sequence: i + 1,
          pickup_type: i === d.stops.length - 1 ? 1 : 0,
          drop_off_type: i === 0 ? 1 : 0,
          shape_dist_traveled: on[i] ? round1(Math.max(0, dist[i])) : '',
          timepoint: 0,
        });
      });

      for (const p of periods) {
        frequencies.push({
          trip_id: tripId,
          start_time: hms(parseHm(p.start)),
          end_time: hms(parseHm(p.end)),
          headway_secs: Math.round(Number(p.headway_min) * 60),
          exact_times: 0,
        });
      }
    }
  }

  const stops = [...db.stops.values()]
    .filter((s) => served.has(s.id))
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((s) => ({ stop_id: s.id, stop_code: s.id, stop_name: s.name, stop_lat: round6(s.lat), stop_lon: round6(s.lng), location_type: 0 }));

  const days = cfg.service_days;
  const files = {
    'agency.txt': toCsv(['agency_id', 'agency_name', 'agency_url', 'agency_timezone', 'agency_lang', 'agency_phone'], [cfg.agency]),
    'stops.txt': toCsv(['stop_id', 'stop_code', 'stop_name', 'stop_lat', 'stop_lon', 'location_type'], stops),
    'routes.txt': toCsv(['route_id', 'agency_id', 'route_short_name', 'route_long_name', 'route_type', 'route_color', 'route_text_color', 'route_sort_order'], routes),
    'trips.txt': toCsv(['route_id', 'service_id', 'trip_id', 'trip_headsign', 'direction_id', 'shape_id'], trips),
    'stop_times.txt': toCsv(['trip_id', 'arrival_time', 'departure_time', 'stop_id', 'stop_sequence', 'pickup_type', 'drop_off_type', 'shape_dist_traveled', 'timepoint'], stopTimes),
    'calendar.txt': toCsv(['service_id', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday', 'start_date', 'end_date'], [{
      service_id: serviceId,
      monday: days[0] ? 1 : 0, tuesday: days[1] ? 1 : 0, wednesday: days[2] ? 1 : 0, thursday: days[3] ? 1 : 0,
      friday: days[4] ? 1 : 0, saturday: days[5] ? 1 : 0, sunday: days[6] ? 1 : 0,
      start_date: start, end_date: end,
    }]),
    'frequencies.txt': toCsv(['trip_id', 'start_time', 'end_time', 'headway_secs', 'exact_times'], frequencies),
    'shapes.txt': toCsv(['shape_id', 'shape_pt_lat', 'shape_pt_lon', 'shape_pt_sequence', 'shape_dist_traveled'], shapes),
  };

  if (cfg.fare.price !== '' && cfg.fare.price !== null && cfg.fare.price !== undefined) {
    files['fare_attributes.txt'] = toCsv(['fare_id', 'price', 'currency_type', 'payment_method', 'transfers', 'agency_id'], [{
      fare_id: 'flat', price: Number(cfg.fare.price).toFixed(2), currency_type: cfg.fare.currency_type,
      payment_method: cfg.fare.payment_method, transfers: cfg.fare.transfers, agency_id: agencyId,
    }]);
    files['fare_rules.txt'] = toCsv(['fare_id', 'route_id'], routes.map((r) => ({ fare_id: 'flat', route_id: r.route_id })));
  }

  const f = cfg.feed;
  files['feed_info.txt'] = toCsv(['feed_publisher_name', 'feed_publisher_url', 'feed_lang', 'feed_start_date', 'feed_end_date', 'feed_version', 'feed_contact_email', 'feed_contact_url'], [{
    ...f, feed_start_date: start, feed_end_date: end, feed_version: `${start}-${stops.length}s-${routes.length}r`,
  }]);

  return {
    files,
    summary: { stops: stops.length, routes: routes.length, trips: trips.length, stopTimes: stopTimes.length, shapePoints: shapes.length, start, end, warnings },
  };
}

// ---------- zip (store + deflate, no dependencies) ----------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A .zip archive of { name: text } with deflate compression. */
function zip(files) {
  const local = [], central = [];
  let offset = 0;
  // Fixed timestamp (2026-01-01) so the same data gives the same archive.
  const dosTime = 0, dosDate = ((2026 - 1980) << 9) | (1 << 5) | 1;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const nameBuf = Buffer.from(name, 'utf8');
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(8, 8);
    h.writeUInt16LE(dosTime, 10); h.writeUInt16LE(dosDate, 12); h.writeUInt32LE(crc, 14);
    h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(nameBuf.length, 26); h.writeUInt16LE(0, 28);
    local.push(h, nameBuf, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(8, 10);
    c.writeUInt16LE(dosTime, 12); c.writeUInt16LE(dosDate, 14); c.writeUInt32LE(crc, 16); c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += h.length + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const e = Buffer.alloc(22);
  const count = Object.keys(files).length;
  e.writeUInt32LE(0x06054b50, 0); e.writeUInt16LE(count, 8); e.writeUInt16LE(count, 10);
  e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, cd, e]);
}

/** Load the data folder and build the feed. */
function exportFeed(dataDir) {
  const db = load(dataDir);
  return buildFeed(db, readConfig(dataDir));
}

module.exports = { buildFeed, exportFeed, readConfig, zip, DEFAULT_CONFIG };

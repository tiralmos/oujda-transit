'use strict';

/**
 * Journey planner on the stop/line graph. There are no timetables in the data, so durations are
 * estimates: walking at ~4.7 km/h, buses at ~18 km/h plus dwell time, and a fixed average wait.
 */

const { distance } = require('./util');
const { publicStop } = require('./data');
const { publicLineSummary } = require('./search');

const WALK_SPEED = 1.3; // m/s
const WALK_DETOUR = 1.25; // streets are not straight lines
const BUS_SPEED = 5; // m/s (18 km/h average in town)
const DWELL = 20; // s per intermediate stop
const WAIT = 7 * 60; // s average wait when boarding
const TRANSFER_PENALTY = 4 * 60; // extra cost (not time) per transfer, to prefer fewer changes
const ACCESS_RADIUS = 1200; // m walking to the first stop / from the last stop
const TRANSFER_RADIUS = 400; // m walking between two stops while changing lines

class MinHeap {
  constructor() { this.a = []; }
  get size() { return this.a.length; }
  push(item) {
    const a = this.a; a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].cost <= a[i].cost) break;
      [a[p], a[i]] = [a[i], a[p]]; i = p;
    }
  }
  pop() {
    const a = this.a; const top = a[0]; const last = a.pop();
    if (a.length) {
      a[0] = last; let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i;
        if (l < a.length && a[l].cost < a[m].cost) m = l;
        if (r < a.length && a[r].cost < a[m].cost) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]]; i = m;
      }
    }
    return top;
  }
}

const walkTime = (m) => (m * WALK_DETOUR) / WALK_SPEED;

/** Precompute stop → [{lineId, dir, idx}] and walking neighbours. Call once per dataset. */
function buildIndex(db) {
  const occurrences = new Map();
  const patterns = [];
  for (const line of db.lines.values()) {
    for (const dir of line.directions) {
      const p = { line, dir, stops: dir.stops, hop: [] };
      for (let i = 0; i < dir.stops.length - 1; i++) {
        const a = db.stops.get(dir.stops[i]);
        const b = db.stops.get(dir.stops[i + 1]);
        const d = distance(a.lat, a.lng, b.lat, b.lng) * 1.15;
        p.hop.push({ d, t: d / BUS_SPEED + DWELL });
      }
      const pi = patterns.push(p) - 1;
      dir.stops.forEach((sid, idx) => {
        if (!occurrences.has(sid)) occurrences.set(sid, []);
        occurrences.get(sid).push({ pi, idx });
      });
    }
  }
  const stopList = [...db.stops.values()];
  const neighbours = new Map();
  for (const a of stopList) {
    const list = [];
    for (const b of stopList) {
      if (a === b) continue;
      const d = distance(a.lat, a.lng, b.lat, b.lng);
      if (d <= TRANSFER_RADIUS) list.push({ id: b.id, d });
    }
    neighbours.set(a.id, list);
  }
  return { occurrences, patterns, neighbours, stopList };
}

function dijkstra(db, idx, from, to, banned) {
  const dist = new Map();
  const prev = new Map();
  const heap = new MinHeap();
  const relax = (node, cost, time, via, edge) => {
    const cur = dist.get(node);
    if (cur && cur.cost <= cost) return;
    dist.set(node, { cost, time });
    prev.set(node, { via, edge });
    heap.push({ node, cost, time });
  };

  // Walking straight there is always an option.
  const direct = distance(from.lat, from.lng, to.lat, to.lng);
  relax('D', walkTime(direct), walkTime(direct), 'O', { type: 'walk', d: direct });

  for (const s of idx.stopList) {
    const d = distance(from.lat, from.lng, s.lat, s.lng);
    if (d <= ACCESS_RADIUS) relax(`S:${s.id}`, walkTime(d), walkTime(d), 'O', { type: 'walk', d });
  }
  const egress = new Map();
  for (const s of idx.stopList) {
    const d = distance(s.lat, s.lng, to.lat, to.lng);
    if (d <= ACCESS_RADIUS) egress.set(s.id, d);
  }

  const done = new Set();
  while (heap.size) {
    const { node, cost, time } = heap.pop();
    if (done.has(node)) continue;
    done.add(node);
    if (node === 'D') break;
    const [kind, rest] = [node[0], node.slice(2)];

    if (kind === 'S' || kind === 'A') {
      const sid = rest;
      if (kind === 'A') {
        relax(`S:${sid}`, cost, time, node, { type: 'same' });
        for (const n of idx.neighbours.get(sid) || []) {
          relax(`S:${n.id}`, cost + walkTime(n.d), time + walkTime(n.d), node, { type: 'walk', d: n.d });
        }
      }
      if (egress.has(sid)) {
        const d = egress.get(sid);
        relax('D', cost + walkTime(d), time + walkTime(d), node, { type: 'walk', d });
      }
      if (kind === 'S') {
        const isTransfer = prev.get(node)?.via !== 'O';
        for (const occ of idx.occurrences.get(sid) || []) {
          const p = idx.patterns[occ.pi];
          if (banned.has(p.line.id) || occ.idx >= p.stops.length - 1) continue;
          relax(`R:${occ.pi}:${occ.idx}`, cost + WAIT + (isTransfer ? TRANSFER_PENALTY : 0), time + WAIT, node, { type: 'board' });
        }
      }
    } else if (kind === 'R') {
      const [pi, i] = rest.split(':').map(Number);
      const p = idx.patterns[pi];
      if (i + 1 < p.stops.length) {
        const h = p.hop[i];
        relax(`R:${pi}:${i + 1}`, cost + h.t, time + h.t, node, { type: 'ride', d: h.d });
      }
      if (i > 0) relax(`A:${p.stops[i]}`, cost, time, node, { type: 'alight' });
    }
  }

  if (!dist.has('D')) return null;
  // Reconstruct the node path.
  const path = [];
  let n = 'D';
  while (n !== 'O') {
    const pr = prev.get(n);
    path.unshift({ node: n, edge: pr.edge, via: pr.via });
    n = pr.via;
  }
  return { cost: dist.get('D').cost, time: dist.get('D').time, path };
}

function placeOf(db, node, from, to) {
  if (node === 'O') return { name: from.name, lat: from.lat, lng: from.lng };
  if (node === 'D') return { name: to.name, lat: to.lat, lng: to.lng };
  const s = db.stops.get(node.slice(2).split(':')[0]);
  return s ? { name: s.name, lat: s.lat, lng: s.lng, stopId: s.id } : null;
}

function toLegs(db, idx, result, from, to) {
  const legs = [];
  let ride = null;
  for (const step of result.path) {
    const { edge, via, node } = step;
    if (edge.type === 'walk') {
      const d = Math.round(edge.d);
      legs.push({
        type: 'walk',
        from: placeOf(db, via, from, to),
        to: placeOf(db, node, from, to),
        distance: d,
        duration: Math.round(walkTime(edge.d)),
      });
    } else if (edge.type === 'board') {
      const [pi, i] = node.slice(2).split(':').map(Number);
      ride = { pi, start: i, end: i, distance: 0, duration: 0 };
      ride.wait = WAIT;
      legs.push(ride);
    } else if (edge.type === 'ride') {
      const [pi, i] = node.slice(2).split(':').map(Number);
      ride.end = i;
      ride.distance += edge.d;
      ride.duration += idx.patterns[pi].hop[i - 1].t;
    }
  }
  return legs
    .map((l) => {
      if (l.type === 'walk') return l;
      const p = idx.patterns[l.pi];
      const stopIds = p.stops.slice(l.start, l.end + 1);
      return {
        type: 'bus',
        line: publicLineSummary(p.line),
        direction: p.dir.id,
        headsign: p.dir.to,
        from: placeOf(db, `S:${stopIds[0]}`),
        to: placeOf(db, `S:${stopIds[stopIds.length - 1]}`),
        stops: stopIds.map((id) => publicStop(db.stops.get(id))),
        distance: Math.round(l.distance),
        duration: Math.round(l.duration),
        wait: l.wait,
      };
    })
    .filter((l) => !(l.type === 'walk' && l.distance < 5));
}

/**
 * Plan up to `max` itineraries between two points ({lat, lng, name}).
 * Alternatives are found by banning, in turn, each line used by the best itinerary.
 */
function plan(db, idx, from, to, { max = 3 } = {}) {
  const found = [];
  const seen = new Set();
  const queue = [new Set()];
  const tried = new Set();
  while (queue.length && found.length < max + 2) {
    const banned = queue.shift();
    const key = [...banned].sort().join(',');
    if (tried.has(key)) continue;
    tried.add(key);
    const r = dijkstra(db, idx, from, to, banned);
    if (!r) continue;
    const legs = toLegs(db, idx, r, from, to);
    const sig = legs.map((l) => (l.type === 'bus' ? `${l.line.id}:${l.from.stopId}>${l.to.stopId}` : 'w')).join('|');
    const busLines = legs.filter((l) => l.type === 'bus').map((l) => l.line.id);
    const buses = legs.filter((l) => l.type === 'bus');
    const reboardsSameLine = buses.some((l, i) => i > 0 && buses[i - 1].line.id === l.line.id);
    if (!seen.has(sig) && !reboardsSameLine) {
      seen.add(sig);
      found.push({
        duration: Math.round(r.time),
        cost: r.cost,
        walkDistance: legs.filter((l) => l.type === 'walk').reduce((s, l) => s + l.distance, 0),
        transfers: Math.max(0, busLines.length - 1),
        legs,
      });
    }
    if (tried.size < 8) for (const id of busLines) queue.push(new Set([...banned, id]));
  }
  found.sort((a, b) => a.cost - b.cost);
  // Keep the walk-only option only if it is reasonable or the only one.
  const withBus = found.filter((f) => f.legs.some((l) => l.type === 'bus'));
  const walkOnly = found.find((f) => !f.legs.some((l) => l.type === 'bus'));
  // Drop alternatives that are much slower than the best one.
  const best = withBus[0];
  const out = withBus.filter((f) => f === best || f.duration <= best.duration * 1.35 + 600).slice(0, max);
  if (walkOnly && (out.length === 0 || walkOnly.duration < 25 * 60)) out.push(walkOnly);
  out.sort((a, b) => a.cost - b.cost);
  return out.map(({ cost, ...rest }) => rest);
}

module.exports = { buildIndex, plan, constants: { WALK_SPEED, BUS_SPEED, WAIT, ACCESS_RADIUS, TRANSFER_RADIUS } };

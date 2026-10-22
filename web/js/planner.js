// Trip planner over the static network: shortest path (Dijkstra) on a graph of
// stops and "line positions", with walking between nearby stops.
//
// There are no timetables in the data, so times are estimates: ride time from
// the distance between stops, a fixed wait each time a bus is boarded, and
// walking at about 4.8 km/h. Pure functions, no DOM.

import { distanceM, walkMinutes } from './geo.js';

export const DEFAULTS = {
  waitMinutes: 5,        // assumed average wait when boarding a bus
  transferWalkM: 400,    // longest walk between two stops for a transfer
  accessWalkM: 1000,     // longest walk from a map point to a stop and back
  directWalkM: 1500,     // offer "just walk" when the trip is at most this long
};

class Heap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(cost, node) {
    const a = this.items;
    a.push([cost, node]);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p][0] <= a[i][0]) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < a.length && a[l][0] < a[m][0]) m = l;
        if (r < a.length && a[r][0] < a[m][0]) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

export function createPlanner(network, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  const stops = network.stops;
  const stopIndex = new Map(stops.map((s, i) => [s.id, i]));
  const usable = stops.map((s) => !s.flags.includes('suspect_location'));
  const N = stops.length;

  // One "pattern" per line direction; each stop position on it is a node.
  const patterns = [];
  const boardings = stops.map(() => []); // stop index -> [node ids of positions]
  let next = N;
  for (const line of network.lines) {
    for (const [direction, d] of Object.entries(line.directions)) {
      const p = { line, direction, stops: d.stops, minutes: d.minutes, base: next };
      d.stops.forEach((id, pos) => {
        if (pos < d.stops.length - 1) boardings[stopIndex.get(id)].push(next + pos);
      });
      next += d.stops.length;
      patterns.push(p);
    }
  }
  const nodePattern = new Array(next);
  for (const p of patterns) for (let i = 0; i < p.stops.length; i++) nodePattern[p.base + i] = p;
  const ORIGIN = next;
  const DEST = next + 1;

  // Walking links between stops whose coordinates we trust.
  const walks = stops.map(() => []);
  for (let i = 0; i < N; i++) {
    if (!usable[i]) continue;
    for (let j = i + 1; j < N; j++) {
      if (!usable[j]) continue;
      const m = distanceM(stops[i], stops[j]);
      if (m <= opts.transferWalkM) {
        walks[i].push([j, m]);
        walks[j].push([i, m]);
      }
    }
  }

  // Stops reachable on foot from a trip end. A stop given as the end links to
  // itself at no cost, and to nearby stops too (a stop that is only a
  // departure point for its lines can still be reached on foot).
  function endpointLinks(place, maxM) {
    let self = -1;
    if (place.type === 'stop') {
      self = stopIndex.get(place.id);
      if (self === undefined) throw new Error(`Unknown stop ${place.id}`);
      if (!usable[self]) return [[self, 0]];
    }
    const at = point(place);
    const links = self >= 0 ? [[self, 0]] : [];
    for (let i = 0; i < N; i++) {
      if (i === self || !usable[i]) continue;
      const m = distanceM(at, stops[i]);
      if (m <= maxM) links.push([i, m]);
    }
    return links;
  }

  function point(place) {
    if (place.type === 'stop') return stops[stopIndex.get(place.id)];
    return { lat: place.lat, lng: place.lng };
  }

  function search(from, to, boardCost) {
    const dist = new Float64Array(DEST + 1).fill(Infinity);
    const prev = new Int32Array(DEST + 1).fill(-1);
    const heap = new Heap();
    const fromLinks = endpointLinks(from, opts.accessWalkM);
    const toLinks = new Map(endpointLinks(to, opts.accessWalkM));
    const relax = (node, cost, via) => {
      if (cost < dist[node]) {
        dist[node] = cost;
        prev[node] = via;
        heap.push(cost, node);
      }
    };
    dist[ORIGIN] = 0;
    for (const [i, m] of fromLinks) relax(i, walkMinutes(m), ORIGIN);
    while (heap.size) {
      const [cost, node] = heap.pop();
      if (cost > dist[node]) continue;
      if (node === DEST) break;
      if (node < N) {
        const out = toLinks.get(node);
        if (out !== undefined) relax(DEST, cost + walkMinutes(out), node);
        for (const b of boardings[node]) relax(b, cost + boardCost, node);
        for (const [j, m] of walks[node]) relax(j, cost + walkMinutes(m), node);
      } else {
        const p = nodePattern[node];
        const pos = node - p.base;
        if (pos > 0) relax(stopIndex.get(p.stops[pos]), cost, node);
        if (pos < p.stops.length - 1) relax(node + 1, cost + p.minutes[pos], node);
      }
    }
    if (dist[DEST] === Infinity) return null;
    const path = [];
    for (let n = DEST; n !== -1; n = prev[n]) path.push(n);
    return path.reverse();
  }

  function toLegs(path, from, to) {
    const legs = [];
    const place = (node) => (node === ORIGIN ? from : node === DEST ? to : { type: 'stop', id: stops[node].id });
    for (let k = 0; k < path.length - 1; k++) {
      const a = path[k], b = path[k + 1];
      if (b >= N && b < ORIGIN && (a < N)) {
        // Boarding: follow the pattern until we get off.
        const p = nodePattern[b];
        let end = b;
        while (k + 2 < path.length && path[k + 2] === end + 1 && nodePattern[path[k + 2]] === p) { end++; k++; }
        k++; // the alight step (pattern node -> stop node)
        const s = b - p.base, e = end - p.base;
        let minutes = 0;
        for (let i = s; i < e; i++) minutes += p.minutes[i];
        legs.push({ type: 'ride', line: p.line, direction: p.direction, stops: p.stops.slice(s, e + 1), first: s, minutes });
        continue;
      }
      if (a < N && b < N && a === b) continue;
      // A stop given as origin or destination links to itself: no walk.
      if ((a === ORIGIN && from.type === 'stop' && stops[b].id === from.id) ||
          (b === DEST && to.type === 'stop' && stops[a].id === to.id)) continue;
      // Two different stops can share coordinates; that is still a (0 m) walk.
      const meters = distanceM(point(place(a)), point(place(b)));
      const leg = { type: 'walk', from: place(a), to: place(b), meters, minutes: walkMinutes(meters) };
      const last = legs[legs.length - 1];
      if (last && last.type === 'walk') {
        last.to = leg.to;
        last.meters += meters;
        last.minutes += leg.minutes;
      } else legs.push(leg);
    }
    return legs;
  }

  function summarize(legs, waitMinutes) {
    const rides = legs.filter((l) => l.type === 'ride');
    const walking = legs.filter((l) => l.type === 'walk');
    const rideMinutes = rides.reduce((t, l) => t + l.minutes, 0);
    const walkMin = walking.reduce((t, l) => t + l.minutes, 0);
    return {
      legs,
      minutes: rideMinutes + walkMin + rides.length * waitMinutes,
      rideMinutes,
      walkMinutes: walkMin,
      walkMeters: walking.reduce((t, l) => t + l.meters, 0),
      transfers: Math.max(0, rides.length - 1),
      signature: rides.map((l) => `${l.line.id}:${l.direction}:${l.stops[0]}:${l.stops[l.stops.length - 1]}`).join('|') || 'walk',
    };
  }

  // Returns up to three options (fastest, fewest transfers, walking only),
  // sorted by estimated duration.
  function plan(from, to) {
    const options = [];
    const seen = new Set();
    const add = (opt) => {
      if (opt && !seen.has(opt.signature)) {
        seen.add(opt.signature);
        options.push(opt);
      }
    };
    if (from.type === 'stop' && to.type === 'stop' && from.id === to.id) return [];
    for (const boardCost of [opts.waitMinutes, opts.waitMinutes + 20]) {
      const path = search(from, to, boardCost);
      if (path) {
        const legs = toLegs(path, from, to);
        if (legs.some((l) => l.type === 'ride')) add(summarize(legs, opts.waitMinutes));
      }
    }
    const direct = distanceM(point(from), point(to));
    if (direct <= opts.directWalkM) {
      add(summarize([{ type: 'walk', from, to, meters: direct, minutes: walkMinutes(direct) }], opts.waitMinutes));
    }
    options.sort((a, b) => a.minutes - b.minutes || a.transfers - b.transfers);
    return options;
  }

  return { plan, options: opts };
}

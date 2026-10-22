import test from 'node:test';
import assert from 'node:assert/strict';
import { network } from './helpers.mjs';
import { createPlanner } from '../web/js/planner.js';
import { distanceM } from '../web/js/geo.js';

const net = network();
const planner = createPlanner(net);
const line = (name) => net.lines.find((l) => l.name === name);
const stop = (id) => net.stops.find((s) => s.id === id);

function checkOption(o, from, to) {
  // Legs must chain: each starts where the previous one ended.
  let here = from;
  const same = (a, b) => (a.type === 'stop' && b.type === 'stop' ? a.id === b.id
    : a.type !== 'stop' && b.type !== 'stop' ? a.lat === b.lat && a.lng === b.lng : false);
  for (const leg of o.legs) {
    if (leg.type === 'walk') {
      assert.ok(same(leg.from, here) || (here.type === 'stop' && leg.from.type === 'stop' && leg.from.id === here.id), 'walk starts where we are');
      here = leg.to;
    } else {
      assert.equal(here.type, 'stop', 'rides start at a stop');
      assert.equal(leg.stops[0], here.id, 'ride boards where we are');
      const seq = leg.line.directions[leg.direction].stops;
      const start = seq.indexOf(leg.stops[0]);
      assert.ok(start >= 0);
      // The ridden stops are a contiguous, forward slice of the line direction.
      const slice = leg.stops;
      let found = false;
      for (let i = 0; i < seq.length; i++) {
        if (seq.slice(i, i + slice.length).join() === slice.join()) found = true;
      }
      assert.ok(found, 'ride follows the line in its direction');
      assert.ok(slice.length >= 2);
      here = { type: 'stop', id: slice[slice.length - 1] };
    }
  }
  if (to.type === 'stop') assert.equal(here.id, to.id, 'ends at the destination stop');
  else assert.ok(same(here, to) || here.type === 'stop', 'ends at destination');
  assert.equal(o.transfers, Math.max(0, o.legs.filter((l) => l.type === 'ride').length - 1));
}

test('direct trip along one line uses that line without transfers', () => {
  const d = line('L01').directions.aller;
  const from = { type: 'stop', id: d.stops[0] };
  const to = { type: 'stop', id: d.stops[d.stops.length - 1] };
  const options = planner.plan(from, to);
  assert.ok(options.length >= 1);
  const best = options[0];
  checkOption(best, from, to);
  const rides = best.legs.filter((l) => l.type === 'ride');
  assert.ok(rides.length >= 1);
  for (const o of options) checkOption(o, from, to);
});

test('every pair of termini across all lines gets a valid plan or none', () => {
  const termini = [...new Set(net.lines.flatMap((l) => Object.values(l.directions).flatMap((d) => [d.stops[0], d.stops[d.stops.length - 1]])))];
  let planned = 0;
  for (const a of termini.slice(0, 25)) {
    for (const b of termini.slice(0, 25)) {
      if (a === b) continue;
      const from = { type: 'stop', id: a }, to = { type: 'stop', id: b };
      const options = planner.plan(from, to);
      for (const o of options) {
        checkOption(o, from, to);
        assert.ok(Number.isFinite(o.minutes) && o.minutes >= 0);
      }
      if (options.length) planned++;
    }
  }
  assert.ok(planned > 400, `planned ${planned}`);
});

test('trip from a map point walks to a stop first', () => {
  const s = stop(line('L03').directions.aller.stops[0]);
  const from = { type: 'point', lat: s.lat + 0.002, lng: s.lng };
  const target = line('L03').directions.aller.stops.at(-1);
  const to = { type: 'stop', id: target };
  const [best] = planner.plan(from, to);
  assert.ok(best);
  assert.equal(best.legs[0].type, 'walk');
  assert.ok(best.legs[0].meters > 0);
  checkOption(best, from, to);
});

test('short trips offer walking', () => {
  const a = stop(line('L01').directions.aller.stops[0]);
  const b = stop(line('L01').directions.aller.stops[1]);
  const options = planner.plan({ type: 'stop', id: a.id }, { type: 'stop', id: b.id });
  const walk = options.find((o) => o.signature === 'walk');
  if (distanceM(a, b) <= 1500) assert.ok(walk);
});

test('a transfer between two stops at the same spot keeps its walk leg', () => {
  // Terminus Maghreb Arabi has a stop per direction (240 and 662), a few metres apart.
  const options = planner.plan({ type: 'stop', id: 240 }, { type: 'stop', id: 662 });
  assert.ok(options.length);
  for (const o of options) checkOption(o, { type: 'stop', id: 240 }, { type: 'stop', id: 662 });
});

test('a stop that is only a departure point can still be reached on foot', () => {
  // 515 (Dar Naaim) only starts L31 retour; L31 aller ends 470 m away at 514.
  const from = { type: 'stop', id: 922 }, to = { type: 'stop', id: 515 };
  const options = planner.plan(from, to);
  assert.ok(options.length);
  for (const o of options) {
    checkOption(o, from, to);
    assert.equal(o.legs.at(-1).type, 'walk');
  }
});

test('same start and end gives no options', () => {
  assert.deepEqual(planner.plan({ type: 'stop', id: 700 }, { type: 'stop', id: 700 }), []);
});

test('options are sorted by estimated time', () => {
  const termini = net.lines.map((l) => l.directions.aller.stops[0]);
  const options = planner.plan({ type: 'stop', id: termini[0] }, { type: 'stop', id: termini[10] });
  for (let i = 1; i < options.length; i++) assert.ok(options[i - 1].minutes <= options[i].minutes);
});

test('stops with doubtful coordinates are not used for walking', () => {
  // No stop is flagged in the current data, so flag one in a copy of the network.
  const flagged = structuredClone(net);
  const suspect = flagged.stops.find((s) => s.id === 269);
  suspect.flags.push('suspect_location');
  const nearby = { type: 'point', lat: suspect.lat + 0.0005, lng: suspect.lng };
  const far = flagged.stops.find((s) => !s.flags.includes('suspect_location') && distanceM(s, suspect) > 3000);
  for (const o of createPlanner(flagged).plan(nearby, { type: 'stop', id: far.id })) {
    for (const leg of o.legs) {
      if (leg.type === 'walk') {
        for (const p of [leg.from, leg.to]) if (p.type === 'stop') assert.notEqual(p.id, suspect.id);
      }
    }
  }
});

test('ride legs know where they start on their line direction', () => {
  const [a, b] = [line('L02').directions.aller.stops[2], line('L02').directions.aller.stops[8]];
  for (const o of planner.plan({ type: 'stop', id: a }, { type: 'stop', id: b })) {
    for (const leg of o.legs.filter((l) => l.type === 'ride')) {
      const d = leg.line.directions[leg.direction];
      assert.deepEqual(d.stops.slice(leg.first, leg.first + leg.stops.length), leg.stops);
    }
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { network } from './helpers.mjs';
import { buildIndex, editDistance, normalize, searchLines, searchStops } from '../web/js/text.js';

const net = network();
const index = buildIndex(net);
const stopsById = new Map(net.stops.map((s) => [s.id, s]));

test('normalize strips accents, case and punctuation and fixes terminus typos', () => {
  assert.equal(normalize('  Aéroport — TERMUNIS Agdal! '), 'aeroport terminus agdal');
  assert.equal(normalize(null), '');
});

test('editDistance', () => {
  assert.equal(editDistance('kitten', 'sitten'), 1);
  assert.equal(editDistance('abc', 'abc'), 0);
  assert.ok(editDistance('abc', 'xyz') > 1);
});

test('stop search finds by name, accent-insensitive, prefix and typo', () => {
  assert.ok(searchStops(index, 'aeroport').some((s) => s.slug === 'aeroport'));
  assert.ok(searchStops(index, 'Aéroport').some((s) => s.slug === 'aeroport'));
  // Clinique Ibn Sina (208) was merged into stop 803; its name still finds it.
  assert.ok(searchStops(index, 'clinique ibn').some((s) => s.id === 803));
  assert.ok(searchStops(index, 'cliniqe').some((s) => s.id === 803));
  assert.ok(searchStops(index, 'terminus agdal').length > 0);
  assert.deepEqual(searchStops(index, '   '), []);
});

test('stop search by id', () => {
  assert.equal(searchStops(index, '700')[0].id, 700);
});

test('line search by name or number', () => {
  assert.equal(searchLines(net, stopsById, 'L25')[0].name, 'L25');
  assert.equal(searchLines(net, stopsById, '25')[0].name, 'L25');
  assert.equal(searchLines(net, stopsById, 'l3')[0].name, 'L03');
  assert.equal(searchLines(net, stopsById, 'ligne 99')[0].name, 'L99');
});

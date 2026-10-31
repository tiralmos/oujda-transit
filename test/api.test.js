'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

process.env.DISABLE_SERVER_GEOCODING = 'true'; // tests must not call OpenStreetMap
const { createApp } = require('../src/server');
const { parseCsv, normalize } = require('../src/util');

let server;
let base;
before(async () => {
  ({ server } = createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const get = async (p) => {
  const res = await fetch(base + p);
  return { status: res.status, body: res.headers.get('content-type').includes('json') ? await res.json() : await res.text() };
};

test('csv parser handles BOM, quotes and CRLF', () => {
  const rows = parseCsv('﻿a,b\r\n1,"x, ""y"""\r\n2,z\n');
  assert.deepStrictEqual(rows, [{ a: '1', b: 'x, "y"' }, { a: '2', b: 'z' }]);
});

test('normalize folds accents and the "termunis" typo', () => {
  assert.strictEqual(normalize('Lycée  TERMUNIS'), 'lycee terminus');
});

test('health and network load every stop and line', async () => {
  const h = await get('/healthz');
  assert.strictEqual(h.body.stops, 698);
  assert.strictEqual(h.body.lines, 24);
  const n = await get('/api/network');
  assert.strictEqual(n.body.stops.length, 698);
  assert.strictEqual(n.body.lines.length, 24);
});

test('placeholder colours are replaced by distinct generated colours', async () => {
  const { body } = await get('/api/lines');
  const colors = body.map((l) => l.color);
  assert.strictEqual(new Set(colors).size, colors.length);
  assert.ok(!colors.includes('#000000'));
});

test('stop search is typo tolerant and finds lines by number', async () => {
  const a = await get('/api/search?q=termunis');
  assert.ok(a.body.stops.length > 0);
  assert.match(a.body.stops[0].name, /^Terminus/);
  const b = await get('/api/search?q=L08');
  assert.strictEqual(b.body.lines[0].name, 'L08');
  const c = await get('/api/search?q=lycee');
  assert.ok(c.body.stops.some((s) => /lyc/i.test(s.name)));
});

test('places endpoint asks the browser to fall back when the server cannot geocode', async () => {
  const r = await get('/api/places?q=Lycee%20Zineb%20Ennafzaouia');
  assert.strictEqual(r.status, 503);
  assert.ok(r.body.fallback.nominatim.startsWith('https://'));
});

test('stop detail lists services in both directions', async () => {
  const { body } = await get('/api/stops/476');
  assert.ok(body.services.length >= 4);
  assert.ok(body.services.every((s) => s.line.color && s.headsign));
});

test('line detail returns ordered stops per direction', async () => {
  const { body } = await get('/api/lines/L01');
  assert.strictEqual(body.directions.length, 2);
  assert.strictEqual(body.directions[0].stops[0].name, 'Terminus Sahat Nakheel');
});

test('trip planner finds a bus itinerary across town', async () => {
  const { body } = await get('/api/plan?from=34.70,-1.95&to=34.65,-1.88');
  assert.ok(body.itineraries.length >= 1);
  const best = body.itineraries[0];
  assert.ok(best.legs.some((l) => l.type === 'bus'));
  for (const l of best.legs) assert.ok(l.duration >= 0 && l.from && l.to);
  // never re-board the same line straight after leaving it
  const buses = best.legs.filter((l) => l.type === 'bus');
  for (let i = 1; i < buses.length; i++) assert.notStrictEqual(buses[i].line.id, buses[i - 1].line.id);
});

test('planner rejects bad input', async () => {
  assert.strictEqual((await get('/api/plan?from=x&to=1,2')).status, 400);
  assert.strictEqual((await get('/api/plan?from=48.85,2.35&to=34.68,-1.91')).status, 400);
});

test('static files are served, path traversal is not', async () => {
  const r = await get('/');
  assert.match(r.body, /<div id="map"/);
  const t = await fetch(`${base}/..%2f..%2fpackage.json`);
  assert.notStrictEqual(t.status, 200);
});

test('startup script has Unix line endings', () => {
  const sh = fs.readFileSync(path.join(__dirname, '..', 'docker-entrypoint.sh'), 'utf8');
  assert.ok(!sh.includes('\r'));
  assert.ok(sh.startsWith('#!/bin/sh\n'));
});

test('labels mangled into dates by a spreadsheet are restored', async () => {
  const { body } = await get('/api/stops/608');
  assert.strictEqual(body.name, '9 Juillet');
});

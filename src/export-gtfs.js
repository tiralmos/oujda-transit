#!/usr/bin/env node
'use strict';

// Writes the GTFS feed for the current data:
//   node src/export-gtfs.js [output folder]     (default: ./gtfs)
// Output: <folder>/oujda-gtfs.zip and the same files unzipped in <folder>/oujda-gtfs/.
// Reads DATA_DIR (default ./data), including the optional DATA_DIR/gtfs.json settings.
const fs = require('fs');
const path = require('path');
const { exportFeed, zip } = require('./gtfs');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const outDir = path.resolve(process.argv[2] || 'gtfs');

const { files, summary } = exportFeed(dataDir);
const txtDir = path.join(outDir, 'oujda-gtfs');
fs.mkdirSync(txtDir, { recursive: true });
for (const f of fs.readdirSync(txtDir)) if (f.endsWith('.txt')) fs.unlinkSync(path.join(txtDir, f));
for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(txtDir, name), text);
const zipFile = path.join(outDir, 'oujda-gtfs.zip');
fs.writeFileSync(zipFile, zip(files));

console.log(`GTFS feed written to ${zipFile}`);
console.log(`  ${summary.stops} stops, ${summary.routes} routes, ${summary.trips} trips, ${summary.stopTimes} stop times, ${summary.shapePoints} shape points`);
console.log(`  valid ${summary.start} to ${summary.end}`);
for (const w of summary.warnings) console.log(`  note: ${w}`);

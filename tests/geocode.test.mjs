import test from 'node:test';
import assert from 'node:assert/strict';
import { parseResults, directUrl } from '../web/js/geocode.js';

test('parses Nominatim results into name, detail and coordinates', () => {
  const places = parseResults([
    {
      lat: '34.6775498', lon: '-1.9205325', name: 'Lycée Omar Ibn Abdelaziz',
      display_name: 'Lycée Omar Ibn Abdelaziz, Boulevard Bir Anzarene, Hay Al Mahatta, Hay Oued Nachef, Oujda, Oriental, 60000, Maroc',
    },
    // No name: the first part of the address is used.
    { lat: '34.68', lon: '-1.91', name: '', display_name: '12, Rue 20, Hay Al Qods, Oujda, Maroc' },
  ]);
  assert.deepEqual(places, [
    { name: 'Lycée Omar Ibn Abdelaziz', detail: 'Boulevard Bir Anzarene, Hay Al Mahatta, Hay Oued Nachef', lat: 34.6775498, lng: -1.9205325 },
    { name: '12', detail: 'Rue 20, Hay Al Qods, Oujda', lat: 34.68, lng: -1.91 },
  ]);
});

test('skips duplicates and results without coordinates', () => {
  const r = { lat: '34.7', lon: '-1.9', name: 'Café', display_name: 'Café, Rue 1, Oujda' };
  assert.equal(parseResults([r, { ...r }, { ...r, lat: 'x' }]).length, 1);
  assert.deepEqual(parseResults(null), []);
  assert.deepEqual(parseResults({ error: 'x' }), []);
});

test('builds the URL the browser uses to ask the geocoder directly', () => {
  const url = new URL(directUrl('https://nominatim.openstreetmap.org/search', '-2.10,34.92,-1.75,34.55', 'pharmacie le paris', 'fr'));
  assert.equal(url.origin + url.pathname, 'https://nominatim.openstreetmap.org/search');
  assert.equal(url.searchParams.get('q'), 'pharmacie le paris');
  assert.equal(url.searchParams.get('viewbox'), '-2.10,34.92,-1.75,34.55');
  assert.equal(url.searchParams.get('bounded'), '1');
  assert.equal(url.searchParams.get('accept-language'), 'fr');
  assert.equal(url.searchParams.get('format'), 'jsonv2');
});

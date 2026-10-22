import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from './helpers.mjs';
import { _strings, escapeHtml, raw, th } from '../web/js/i18n.js';

test('every language has the same keys and placeholders', () => {
  const [base, ...others] = Object.keys(_strings);
  const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join();
  for (const lang of others) {
    assert.deepEqual(Object.keys(_strings[lang]).sort(), Object.keys(_strings[base]).sort(), lang);
    for (const key of Object.keys(_strings[base])) {
      assert.equal(placeholders(_strings[lang][key]), placeholders(_strings[base][key]), `${lang}.${key}`);
    }
  }
});

test('every string key used by the app exists', () => {
  const src = readFileSync(join(ROOT, 'web', 'js', 'app.js'), 'utf8');
  const used = new Set([...src.matchAll(/\bth?\(\s*'(\w+)'/g)].map((m) => m[1]));
  // Keys picked from lookup tables, e.g. { auto: 'themeAuto' }[x].
  for (const m of src.matchAll(/\b\w+: '((?:theme|tab|issue|map)[A-Z]\w*)'/g)) used.add(m[1]);
  assert.ok(used.size > 50);
  for (const key of used) assert.ok(key in _strings.en, `missing key ${key}`);
});

test('th escapes the string and values but not raw()', () => {
  assert.equal(escapeHtml('<a href="x">&\'</a>'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  assert.equal(th('towards', { name: '<b>' }).includes('&lt;b&gt;'), true);
  assert.equal(th('board', { line: raw('<span>L1</span>'), towards: 'x' }).includes('<span>L1</span>'), true);
});

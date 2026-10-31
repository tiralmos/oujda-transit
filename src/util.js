'use strict';

/** Parse CSV text (RFC 4180: quoted fields, doubled quotes, CRLF or LF). */
function parseCsv(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1); // strip BOM
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const header = rows.shift().map((h) => h.trim());
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

/** Great-circle distance in metres. */
function distance(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Lowercase, strip accents and punctuation, and unify common spelling variants. */
function normalize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .replace(/\btermunis\b|\btermunus\b|\bterminal\b/g, 'terminus')
    .replace(/\bav\b/g, 'avenue')
    .replace(/\bbd\b/g, 'boulevard')
    .trim()
    .replace(/\s+/g, ' ');
}

function trigrams(s) {
  const t = `  ${s} `;
  const out = new Set();
  for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
  return out;
}

/** Similarity in [0, 1] between two normalised strings using trigram overlap. */
function similarity(a, b) {
  if (!a || !b) return 0;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let common = 0;
  for (const g of ta) if (tb.has(g)) common++;
  return (2 * common) / (ta.size + tb.size);
}

const MONTHS_FR = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

/**
 * Spreadsheets turn street names like "9 Juillet" into dates ("2026-07-09 00:00:00").
 * Turn such labels back into "9 Juillet".
 */
function undoSpreadsheetDate(s) {
  const m = String(s || '').trim().match(/^\d{4}-(\d{2})-(\d{2})(?:[ T-]00[:-]00[:-]00)?$/);
  if (!m) return s;
  const month = MONTHS_FR[Number(m[1]) - 1];
  return month ? `${Number(m[2])} ${month}` : s;
}

/** Title-case a label like "TERMUNIS SAHAT NAKHEEL" for display. */
function prettyName(s) {
  const str = String(undoSpreadsheetDate(s) || '').replace(/\s+/g, ' ').trim();
  if (!str) return str;
  const fixed = str.replace(/\bterm[iu]n[iu]s\b/gi, (w) => (w === w.toUpperCase() ? 'TERMINUS' : 'Terminus'));
  if (fixed !== fixed.toUpperCase() && fixed !== fixed.toLowerCase()) return fixed;
  return fixed.toLowerCase().replace(/(^|[\s\-'(/])([a-zà-ÿ])/g, (m, p, c) => p + c.toUpperCase());
}

module.exports = { parseCsv, distance, normalize, similarity, prettyName };

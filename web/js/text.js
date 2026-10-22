// Text normalisation and search over stops and lines. Pure functions, no DOM.

const TERMINUS_TYPOS = /\b(termunis|terminis|termenus)\b/g;

// Lower case, no accents, punctuation turned into spaces, common typos fixed.
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ')
    .replace(TERMINUS_TYPOS, 'terminus')
    .trim();
}

export function tokens(text) {
  const n = normalize(text);
  return n ? n.split(' ') : [];
}

// Levenshtein distance, giving up (returning max + 1) once it exceeds max.
export function editDistance(a, b, max = 1) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      best = Math.min(best, cur[j]);
    }
    if (best > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

// How well one query token matches a list of words (0 = no match).
function tokenScore(q, words) {
  let best = 0;
  for (const w of words) {
    if (w === q) return 3;
    if (w.startsWith(q)) best = Math.max(best, 2);
    else if (q.length >= 3 && w.includes(q)) best = Math.max(best, 1);
    else if (q.length >= 4 && editDistance(q, w.slice(0, q.length + 1), 1) <= 1) best = Math.max(best, 0.5);
  }
  return best;
}

// Score a document (its words) against the query; every query token must match.
export function matchScore(queryTokens, words, fullText) {
  if (!queryTokens.length) return 0;
  let score = 0;
  for (const q of queryTokens) {
    const s = tokenScore(q, words);
    if (!s) return 0;
    score += s;
  }
  if (fullText.startsWith(queryTokens.join(' '))) score += 2;
  return score;
}

export function buildIndex(network) {
  const stops = network.stops.map((s) => {
    const words = [...new Set([...tokens(s.name), ...tokens(s.slug), String(s.id)])];
    return { item: s, words, full: normalize(s.name) };
  });
  return { stops };
}

export function searchStops(index, query, limit = 20) {
  const q = tokens(query);
  if (!q.length) return [];
  const hits = [];
  for (const d of index.stops) {
    const score = matchScore(q, d.words, d.full);
    if (score) hits.push({ stop: d.item, score });
  }
  hits.sort((a, b) => b.score - a.score || a.stop.name.localeCompare(b.stop.name) || a.stop.id - b.stop.id);
  return hits.slice(0, limit).map((h) => h.stop);
}

// Lines match on their name ("L03", "l3", "3") or on a terminus name.
export function searchLines(network, stopsById, query) {
  const n = normalize(query).replace(/\s+/g, '');
  if (!n) return [];
  const num = n.replace(/^l(ine|igne)?/, '');
  const q = tokens(query);
  const out = [];
  for (const line of network.lines) {
    const name = normalize(line.name).replace(/\s+/g, '');
    const lineNum = String(parseInt(name.replace(/^l/, ''), 10));
    let score = 0;
    if (name === n || (/^\d+$/.test(num) && String(parseInt(num, 10)) === lineNum)) score = 10;
    else if (name.startsWith(n)) score = 5;
    else {
      const termini = Object.values(line.directions).flatMap((d) => [d.stops[0], d.stops[d.stops.length - 1]]);
      for (const id of termini) {
        const s = stopsById.get(id);
        score = Math.max(score, matchScore(q, tokens(s.name), normalize(s.name)));
      }
    }
    if (score) out.push({ line, score });
  }
  out.sort((a, b) => b.score - a.score);
  return out.map((o) => o.line);
}

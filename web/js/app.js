// Oujda Transit: map, search, lines, stops, nearby, favorites and trip planning
// from the static network data in data/network.json.

import { distanceM, stopsNear, walkMinutes } from './geo.js';
import { buildIndex, searchLines, searchStops } from './text.js';
import { geocode } from './geocode.js';
import { createPlanner, DEFAULTS as PLAN_DEFAULTS } from './planner.js';
import { createFavorites, createRecents, load, save } from './store.js';
import { LANGUAGES, escapeHtml as esc, getLanguage, initLanguage, raw, setLanguage, t, th } from './i18n.js';

const L = window.L;
const CONFIG = {
  tileUrl: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  tileAttribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  tileMaxZoom: 19,
  defaultLanguage: 'fr',
  geocoder: false,
  geocoderBrowserUrl: '',
  geocoderViewbox: '-2.10,34.92,-1.75,34.55',
  ...(window.OUJDA_CONFIG || {}),
};

const NEARBY_M = 800;
const STOP_NEARBY_M = 400;

let net = null;
let stopsById = new Map();
// Stops merged by the data corrections keep working in old links, favorites and recents.
const currentStopId = (id) => net?.mergedStops?.[id] ?? id;
let linesById = new Map();
let index = null;
let planner = null;
const favorites = createFavorites();
const recents = createRecents();
const state = { picking: null, location: null };
let map;
const layers = {};
const stopMarkers = new Map();

const $ = (sel, root = document) => root.querySelector(sel);
const view = () => $('#view');

// ---------- formatting ----------

// Estimates never show "0 min" unless there is truly nothing to do.
function fmtMinutes(min) {
  return t('minutes', { n: min > 0 ? Math.max(1, Math.round(min)) : 0 });
}

function fmtDistance(m) {
  if (m < 1000) return t('meters', { n: Math.round(m / 10) * 10 });
  const km = (m / 1000).toLocaleString(getLanguage() === 'ar' ? 'ar-MA' : getLanguage(), { maximumFractionDigits: 1 });
  return t('km', { n: km });
}

function badge(line, extra = '') {
  return `<span class="badge${extra}" style="--line:${esc(line.color)};--line-text:${esc(line.textColor)}">${esc(line.name)}</span>`;
}

function lineLink(line, dir) {
  return `<a class="badge-link" href="#/line/${line.id}${dir ? '/' + dir : ''}" title="${esc(t('line', { name: line.name }))}">${badge(line)}</a>`;
}

function badges(lineIds) {
  return lineIds.map((id) => badge(linesById.get(id))).join('');
}

function lastStop(line, dir) {
  const s = line.directions[dir].stops;
  return stopsById.get(s[s.length - 1]);
}

function directionMinutes(d) {
  return d.minutes.reduce((a, b) => a + b, 0);
}

function directionMeters(d) {
  let m = 0;
  for (let i = 0; i < d.stops.length - 1; i++) m += distanceM(stopsById.get(d.stops[i]), stopsById.get(d.stops[i + 1]));
  return m;
}

function starButton(kind, id) {
  const on = favorites.has(kind, id);
  return `<button class="icon-btn star${on ? ' on' : ''}" data-fav="${kind}:${id}" aria-pressed="${on}"
    title="${esc(t(on ? 'removeFavorite' : 'addFavorite'))}" aria-label="${esc(t(on ? 'removeFavorite' : 'addFavorite'))}">${on ? '★' : '☆'}</button>`;
}

function shareButton() {
  return `<button class="icon-btn" data-share title="${esc(t('share'))}" aria-label="${esc(t('share'))}">${ICONS.share}</button>`;
}

function stopFlagsHtml(stop) {
  return stop.flags.includes('suspect_location')
    ? `<span class="warn-dot" title="${esc(t('suspectShort'))}" aria-label="${esc(t('suspectShort'))}">!</span>` : '';
}

const ICONS = {
  share: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 16a3 3 0 0 0-2.4 1.2l-6.7-3.4a3 3 0 0 0 0-1.6l6.7-3.4A3 3 0 1 0 15 7l-6.7 3.4a3 3 0 1 0 0 3.2L15 17a3 3 0 1 0 3-1z"/></svg>',
  locate: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm9 3h-2.1A7 7 0 0 0 13 5.1V3h-2v2.1A7 7 0 0 0 5.1 11H3v2h2.1A7 7 0 0 0 11 18.9V21h2v-2.1a7 7 0 0 0 5.9-5.9H21v-2zm-9 6a5 5 0 1 1 0-10 5 5 0 0 1 0 10z"/></svg>',
  lines: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z"/></svg>',
  fit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h6v2H6v4H4zm10 0h6v6h-2V6h-4zM4 14h2v4h4v2H4zm14 0h2v6h-6v-2h4z"/></svg>',
  swap: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4 3 8l4 4V9h10V7H7zm10 8v3H7v2h10v3l4-4z"/></svg>',
  theme_auto: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 18V4a8 8 0 0 1 0 16z"/></svg>',
  theme_light: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10zM11 1h2v3h-2zm0 19h2v3h-2zM1 11h3v2H1zm19 0h3v2h-3zM4.2 5.6l1.4-1.4 2.1 2.1-1.4 1.4zm12.1 12.1 1.4-1.4 2.1 2.1-1.4 1.4zM4.2 18.4l2.1-2.1 1.4 1.4-2.1 2.1zM16.3 6.3l2.1-2.1 1.4 1.4-2.1 2.1z"/></svg>',
  theme_dark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 14.5A9 9 0 0 1 9.5 3a9 9 0 1 0 11.5 11.5z"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 3a7 7 0 0 1 5.6 11.2l5.1 5.1-1.4 1.4-5.1-5.1A7 7 0 1 1 10 3zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10z"/></svg>',
  pin: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5A2.5 2.5 0 1 1 12 6a2.5 2.5 0 0 1 0 5.5z"/></svg>',
};

// ---------- toast ----------

let toastTimer;
function toast(message) {
  const el = $('#toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
}

// ---------- theme ----------

const THEMES = ['auto', 'light', 'dark'];
function applyTheme() {
  const theme = load('theme', 'auto');
  if (theme === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  const btn = $('#theme-btn');
  const label = t({ auto: 'themeAuto', light: 'themeLight', dark: 'themeDark' }[theme] || 'themeAuto');
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = ICONS[`theme_${theme}`] || ICONS.theme_auto;
}

// ---------- map ----------

function setupMap() {
  map = L.map('map', { zoomControl: false, preferCanvas: true, attributionControl: true });
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer(CONFIG.tileUrl, {
    maxZoom: Number(CONFIG.tileMaxZoom) || 19,
    attribution: CONFIG.tileAttribution,
  }).addTo(map);
  map.setView([34.68, -1.91], 13);
  // The map area changes size when the phone bottom sheet opens or closes.
  if (window.ResizeObserver) new ResizeObserver(() => map.invalidateSize()).observe($('#map'));

  layers.allLines = L.layerGroup();
  layers.focus = L.layerGroup().addTo(map);
  layers.stops = L.layerGroup().addTo(map);
  layers.highlight = L.layerGroup().addTo(map);
  layers.user = L.layerGroup().addTo(map);

  const Controls = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const box = L.DomUtil.create('div', 'leaflet-bar map-buttons');
      box.innerHTML = `
        <button type="button" data-map="locate" title="${esc(t('mapLocate'))}" aria-label="${esc(t('mapLocate'))}">${ICONS.locate}</button>
        <button type="button" data-map="lines" title="${esc(t('mapAllLines'))}" aria-label="${esc(t('mapAllLines'))}" aria-pressed="false">${ICONS.lines}</button>
        <button type="button" data-map="fit" title="${esc(t('mapFit'))}" aria-label="${esc(t('mapFit'))}">${ICONS.fit}</button>`;
      L.DomEvent.disableClickPropagation(box);
      box.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.map === 'locate') locate().then((p) => map.setView([p.lat, p.lng], 16)).catch((err) => toast(err.message));
        if (b.dataset.map === 'fit') fitNetwork();
        if (b.dataset.map === 'lines') {
          const on = !map.hasLayer(layers.allLines);
          if (on) layers.allLines.addTo(map); else layers.allLines.remove();
          b.setAttribute('aria-pressed', String(on));
          b.classList.toggle('active', on);
          save('allLines', on);
        }
      });
      return box;
    },
  });
  map.addControl(new Controls());

  map.on('click', (e) => {
    if (!state.picking) return;
    const which = state.picking;
    state.picking = null;
    document.body.classList.remove('picking');
    setPlanEnd(which, { type: 'pt', lat: e.latlng.lat, lng: e.latlng.lng });
  });
}

function fitNetwork(animate = true) {
  map.fitBounds(net.bounds, { padding: [20, 20], animate });
}

function drawNetwork() {
  const radius = () => (map.getZoom() >= 15 ? 6 : map.getZoom() >= 13 ? 4 : 2.5);
  for (const stop of net.stops) {
    const m = L.circleMarker([stop.lat, stop.lng], {
      radius: radius(), color: '#37474f', weight: 1.5, fillColor: '#ffffff', fillOpacity: 1,
    });
    m.bindTooltip(stop.name, { direction: 'top', offset: [0, -4] });
    m.on('click', (e) => {
      L.DomEvent.stop(e);
      onStopClick(stop.id);
    });
    m.addTo(layers.stops);
    stopMarkers.set(stop.id, m);
  }
  map.on('zoomend', () => {
    const r = radius();
    stopMarkers.forEach((m) => m.setRadius(r));
  });
  for (const line of net.lines) {
    for (const d of Object.values(line.directions)) {
      L.polyline(routeShape(d), {
        color: line.color, weight: 3, opacity: 0.55, interactive: false,
      }).addTo(layers.allLines);
    }
  }
  if (load('allLines', false)) {
    layers.allLines.addTo(map);
    const b = $('[data-map="lines"]');
    b.setAttribute('aria-pressed', 'true');
    b.classList.add('active');
  }
}

// Clicking a stop on the map opens it, or picks it as a trip end in pick mode.
function onStopClick(id) {
  if (state.picking) {
    const which = state.picking;
    state.picking = null;
    document.body.classList.remove('picking');
    setPlanEnd(which, { type: 'stop', id });
  } else {
    go(`#/stop/${id}`);
  }
}

function clearFocus() {
  layers.focus.clearLayers();
  layers.highlight.clearLayers();
}

function latlngs(ids) {
  return ids.map((id) => [stopsById.get(id).lat, stopsById.get(id).lng]);
}

// The road shape of a direction between two of its stop positions, or straight lines without one.
function routeShape(d, from = 0, to = d.stops.length - 1) {
  if (!d.shape) return latlngs(d.stops.slice(from, to + 1));
  return d.shape.slice(d.shapeStops[from], d.shapeStops[to] + 1);
}

function drawDirection(line, dir, { weight = 6, opacity = 0.9, stopsToo = true } = {}) {
  const d = line.directions[dir];
  const pts = routeShape(d);
  L.polyline(pts, { color: '#ffffff', weight: weight + 4, opacity: opacity * 0.8, interactive: false }).addTo(layers.focus);
  L.polyline(pts, { color: line.color, weight, opacity, interactive: false }).addTo(layers.focus);
  if (!stopsToo) return pts;
  d.stops.forEach((id, i) => {
    const s = stopsById.get(id);
    const end = i === 0 || i === d.stops.length - 1;
    const suspect = s.flags.includes('suspect_location');
    const m = L.circleMarker([s.lat, s.lng], {
      radius: end ? 8 : 5.5, color: suspect ? '#e65100' : line.color, weight: end ? 4 : 3,
      dashArray: suspect ? '3 3' : null, fillColor: '#ffffff', fillOpacity: 1,
    });
    m.bindTooltip(`${i + 1}. ${s.name}`, { direction: 'top', offset: [0, -6], permanent: false });
    m.on('click', (e) => { L.DomEvent.stop(e); onStopClick(id); });
    m.addTo(layers.highlight);
  });
  return pts;
}

function highlightStop(stop, zoom) {
  L.circleMarker([stop.lat, stop.lng], {
    radius: 11, color: '#d32f2f', weight: 4, fillColor: '#ffffff', fillOpacity: 0.9, interactive: false,
  }).addTo(layers.highlight);
  if (zoom) map.setView([stop.lat, stop.lng], Math.max(map.getZoom(), zoom));
}

function showUser(p) {
  layers.user.clearLayers();
  L.circleMarker([p.lat, p.lng], { radius: 8, color: '#ffffff', weight: 3, fillColor: '#1e88e5', fillOpacity: 1, interactive: false }).addTo(layers.user);
  if (p.accuracy) L.circle([p.lat, p.lng], { radius: p.accuracy, color: '#1e88e5', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(layers.user);
}

function locate() {
  return new Promise((resolve, reject) => {
    if (!window.isSecureContext) return reject(new Error(t('locationInsecure')));
    if (!navigator.geolocation) return reject(new Error(t('locationDenied', { reason: '—' })));
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        state.location = { lat: pos.coords.latitude, lng: pos.coords.longitude, accuracy: pos.coords.accuracy };
        showUser(state.location);
        resolve(state.location);
      },
      (err) => reject(new Error(t('locationDenied', { reason: err.message || err.code }))),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 },
    );
  });
}

// ---------- routing ----------

function go(hash) {
  if (location.hash === hash) route();
  else location.hash = hash;
}

function parseHash() {
  const h = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = h.split('?');
  return { parts: path.split('/').filter(Boolean), params: new URLSearchParams(query) };
}

function setActiveTab(name) {
  document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
}

function route() {
  if (!net) return;
  const { parts, params } = parseHash();
  const [name, a, b] = parts;
  if (name !== 'plan' && state.picking) {
    state.picking = null;
    document.body.classList.remove('picking');
  }
  closeSearch();
  clearFocus();
  const tab = { line: 'lines', stop: null, place: null, nearby: 'nearby', plan: 'plan', favorites: 'favorites', about: 'about' }[name] ?? 'lines';
  setActiveTab(tab);
  if (name === 'line') renderLine(Number(a), b, params);
  else if (name === 'stop') renderStop(Number(a));
  else if (name === 'place') renderPlace(params);
  else if (name === 'nearby') renderNearby(params);
  else if (name === 'plan') renderPlan(params);
  else if (name === 'favorites') renderFavorites();
  else if (name === 'about') renderAbout();
  else renderHome();
  view().dataset.hash = location.hash; // lets tests wait for a render
}

function setView(html, title) {
  const v = view();
  v.innerHTML = html;
  v.scrollTop = 0;
  document.title = title ? `${title} · ${t('appName')}` : `${t('appName')} · ${t('tagline')}`;
}

function notFound() {
  setView(`<p class="empty">${th('notFound')}</p><p><a href="#/">${th('backHome')}</a></p>`);
}

// ---------- views ----------

function renderHome() {
  const recent = recents.list().map((id) => stopsById.get(currentStopId(id))).filter(Boolean);
  let html = '';
  if (recent.length) {
    html += `<section><div class="section-head"><h2>${th('recentStops')}</h2>
      <button class="link-btn" data-clear-recents>${th('clear')}</button></div>
      <ul class="list">${recent.map(stopItem).join('')}</ul></section>`;
  }
  html += `<section><h2>${th('allLines')}</h2><ul class="line-grid">${net.lines.map(lineCard).join('')}</ul></section>`;
  setView(html);
}

function lineCard(line) {
  const dirs = Object.keys(line.directions);
  const first = line.directions[dirs[0]];
  const from = stopsById.get(first.stops[0]);
  const to = lastStop(line, dirs[0]);
  return `<li><a class="line-card" href="#/line/${line.id}">
    ${badge(line, ' big')}
    <span class="line-ends"><span>${esc(from.name)}</span><span class="arrow" aria-hidden="true">⇄</span><span>${esc(to.name)}</span></span>
  </a></li>`;
}

function stopItem(stop, extra = '') {
  return `<li><a class="stop-item" href="#/stop/${stop.id}">
    <span class="stop-name">${esc(stop.name)}${stopFlagsHtml(stop)}</span>
    ${extra ? `<span class="muted">${extra}</span>` : ''}
    <span class="badges">${badges(stop.lines)}</span>
  </a></li>`;
}

function renderLine(id, dir, params) {
  const line = linesById.get(id);
  if (!line) return notFound();
  const dirs = Object.keys(line.directions);
  if (!dirs.includes(dir)) dir = dirs[0];
  const d = line.directions[dir];
  const focusStop = Number(params.get('stop')) || null;
  let cum = 0;
  const items = d.stops.map((sid, i) => {
    if (i > 0) cum += d.minutes[i - 1];
    const s = stopsById.get(sid);
    const others = s.lines.filter((l) => l !== line.id);
    const end = i === 0 || i === d.stops.length - 1;
    return `<li class="${end ? 'end' : ''}${sid === focusStop ? ' focus' : ''}" data-stop="${sid}">
      <a href="#/stop/${sid}">
        <span class="tl-dot" aria-hidden="true"></span>
        <span class="tl-main"><span class="stop-name">${esc(s.name)}${stopFlagsHtml(s)}</span>
        ${others.length ? `<span class="badges small">${badges(others)}</span>` : ''}</span>
        <span class="tl-time muted">${i === 0 ? '' : '+' + esc(fmtMinutes(cum))}</span>
      </a></li>`;
  }).join('');
  const toggle = dirs.map((k) => {
    const end = lastStop(line, k);
    return `<a class="seg${k === dir ? ' active' : ''}" href="#/line/${line.id}/${k}" aria-current="${k === dir}">${th('towards', { name: end.name })}</a>`;
  }).join('');
  setView(`
    <div class="view-head" style="--line:${esc(line.color)}">
      ${badge(line, ' big')}
      <h1>${th('line', { name: line.name })}</h1>
      <div class="head-actions">${starButton('lines', line.id)}${shareButton()}</div>
    </div>
    <p class="muted">${esc(stopsById.get(d.stops[0]).name)} → ${esc(lastStop(line, dir).name)}</p>
    ${dirs.length > 1 ? `<nav class="segmented" aria-label="${esc(t('direction'))}">${toggle}</nav>` : ''}
    <p class="stats">${th('lineStops', { n: d.stops.length })} · ${th('lineDuration', { min: fmtMinutes(directionMinutes(d)) })} · ${esc(fmtDistance(directionMeters(d)))}</p>
    <ol class="timeline" style="--line:${esc(line.color)}">${items}</ol>
    <p class="note">${th('planDisclaimer', { kmh: net.assumptions.busKmh, fast: net.assumptions.fastKmh, wait: PLAN_DEFAULTS.waitMinutes })}</p>
  `, t('line', { name: line.name }));
  const pts = drawDirection(line, dir);
  if (focusStop && stopsById.has(focusStop)) {
    highlightStop(stopsById.get(focusStop));
    const el = view().querySelector(`li[data-stop="${focusStop}"]`);
    if (el) el.scrollIntoView({ block: 'center' });
  }
  map.fitBounds(L.latLngBounds(pts), { padding: [30, 30] });
}

function renderStop(id) {
  if (currentStopId(id) !== id) { location.replace(`#/stop/${currentStopId(id)}`); return; }
  const stop = stopsById.get(id);
  if (!stop) return notFound();
  recents.add(id);
  const rows = [];
  for (const lid of stop.lines) {
    const line = linesById.get(lid);
    for (const [dir, d] of Object.entries(line.directions)) {
      d.stops.forEach((sid, pos) => {
        if (sid !== id) return;
        const next = d.stops.slice(pos + 1, pos + 4).map((x) => stopsById.get(x).name);
        const isEnd = pos === d.stops.length - 1;
        rows.push(`<li><a class="serve" href="#/line/${lid}/${dir}?stop=${id}">
          ${badge(line)}
          <span class="serve-main"><span>${th('towards', { name: lastStop(line, dir).name })}</span>
          <span class="muted small">${isEnd ? th('terminus') : th('nextStops', { list: next.join(' · ') })}</span></span>
          <span class="muted small nowrap">${th('stopOf', { k: pos + 1, n: d.stops.length })}</span>
        </a></li>`);
      });
    }
  }
  const near = stopsNear(net.stops, stop, STOP_NEARBY_M, 11).filter((n) => n.stop.id !== id).slice(0, 10);
  const warnings = [];
  if (stop.flags.includes('missing_name')) warnings.push(th('warnMissingName', { raw: stop.sourceName }));
  if (stop.flags.includes('suspect_location')) warnings.push(th('warnSuspect'));
  const osm = `https://www.openstreetmap.org/?mlat=${stop.lat}&mlon=${stop.lng}#map=18/${stop.lat}/${stop.lng}`;
  setView(`
    <div class="view-head">
      <span class="stop-icon" aria-hidden="true">${ICONS.pin}</span>
      <h1>${esc(stop.name)}</h1>
      <div class="head-actions">${starButton('stops', id)}${shareButton()}</div>
    </div>
    ${warnings.map((w) => `<p class="warning">${w}</p>`).join('')}
    <div class="actions">
      <a class="btn" href="#/plan?from=stop:${id}">${th('planFrom')}</a>
      <a class="btn" href="#/plan?to=stop:${id}">${th('planTo')}</a>
    </div>
    <section><h2>${th('stopsServed')}</h2><ul class="list">${rows.join('')}</ul></section>
    <section><h2>${th('nearbyStops')}</h2>
      ${near.length ? `<ul class="list">${near.map((n) => stopItem(n.stop, esc(fmtDistance(n.meters)))).join('')}</ul>`
        : `<p class="empty">${th('noNearby', { m: fmtDistance(STOP_NEARBY_M) })}</p>`}
    </section>
    <details class="meta"><summary>${th('details')}</summary>
      <dl>
        <dt>${th('stopId')}</dt><dd>${id}</dd>
        <dt>${th('sourceName')}</dt><dd>${esc(stop.sourceName)}</dd>
        ${stop.altNames?.length ? `<dt>${th('altNames')}</dt><dd>${stop.altNames.map(esc).join('<br>')}</dd>` : ''}
        <dt>${th('coordinates')}</dt><dd dir="ltr">${stop.lat.toFixed(6)}, ${stop.lng.toFixed(6)}</dd>
      </dl>
      <a href="${esc(osm)}" target="_blank" rel="noopener">${th('openOsm')}</a>
    </details>
  `, stop.name);
  for (const lid of stop.lines) {
    const line = linesById.get(lid);
    for (const [dir, d] of Object.entries(line.directions)) {
      if (d.stops.includes(id)) drawDirection(line, dir, { weight: 4, opacity: 0.6, stopsToo: false });
    }
  }
  for (const n of near) {
    L.circleMarker([n.stop.lat, n.stop.lng], { radius: 6, color: '#37474f', weight: 2, fillColor: '#ffd54f', fillOpacity: 1 })
      .bindTooltip(n.stop.name).on('click', (e) => { L.DomEvent.stop(e); onStopClick(n.stop.id); }).addTo(layers.highlight);
  }
  highlightStop(stop, 16);
  expandPanel();
}

function renderNearby(params) {
  const source = params.get('at') === 'center' ? 'center' : 'me';
  const head = `<h1>${th('tabNearby')}</h1>
    <div class="actions">
      <a class="btn${source === 'me' ? ' primary' : ''}" href="#/nearby">${ICONS.locate}<span>${th('useMyLocation')}</span></a>
      <a class="btn${source === 'center' ? ' primary' : ''}" href="#/nearby?at=center">${th('useMapCenter')}</a>
    </div>`;
  const show = (p, placeLabel) => {
    const near = stopsNear(net.stops, p, NEARBY_M, 30);
    setView(`${head}<p class="muted">${th('nearbyWithin', { m: fmtDistance(NEARBY_M), place: placeLabel })}</p>
      ${near.length ? `<ul class="list">${near.map((n) => stopItem(n.stop,
        `${esc(fmtDistance(n.meters))} · ${th('walk', { min: fmtMinutes(walkMinutes(n.meters)) })}`)).join('')}</ul>`
        : `<p class="empty">${th('noStopsNearby', { m: fmtDistance(NEARBY_M) })}</p>`}`, t('tabNearby'));
    L.circle([p.lat, p.lng], { radius: NEARBY_M, color: '#1e88e5', weight: 1, fillOpacity: 0.05, interactive: false }).addTo(layers.focus);
    for (const n of near) {
      L.circleMarker([n.stop.lat, n.stop.lng], { radius: 6, color: '#37474f', weight: 2, fillColor: '#ffd54f', fillOpacity: 1 })
        .bindTooltip(n.stop.name).on('click', (e) => { L.DomEvent.stop(e); onStopClick(n.stop.id); }).addTo(layers.highlight);
    }
    map.fitBounds(L.latLng(p.lat, p.lng).toBounds(NEARBY_M * 2), { padding: [10, 10] });
  };
  if (source === 'center') {
    const c = map.getCenter();
    show({ lat: c.lat, lng: c.lng }, t('mapCenter'));
    return;
  }
  setView(`${head}<p class="muted">${th('locating')}</p>`, t('tabNearby'));
  const hash = location.hash;
  locate().then((p) => {
    if (location.hash === hash) show(p, t('yourLocation'));
  }).catch((err) => {
    if (location.hash === hash) setView(`${head}<p class="warning">${esc(err.message)}</p>`, t('tabNearby'));
  });
}

// An address or place found by the address search: #/place?at=lat,lng&name=...
function placeHash(place) {
  return `#/place?at=${encodeEnd({ type: 'pt', ...place }).slice(3)}&name=${encodeURIComponent(place.name)}`;
}

function renderPlace(params) {
  const end = parseEnd(`pt:${params.get('at') || ''}`, params.get('name'));
  if (!end) return notFound();
  const name = end.name || endLabel(end);
  const near = stopsNear(net.stops, end, NEARBY_M, 30);
  const osm = `https://www.openstreetmap.org/?mlat=${end.lat}&mlon=${end.lng}#map=18/${end.lat}/${end.lng}`;
  setView(`
    <div class="view-head">
      <span class="stop-icon place-icon" aria-hidden="true">${ICONS.pin}</span>
      <h1>${esc(name)}</h1>
      <div class="head-actions">${shareButton()}</div>
    </div>
    <div class="actions">
      <a class="btn" href="${esc(planHash(end, null))}">${th('planFrom')}</a>
      <a class="btn" href="${esc(planHash(null, end))}">${th('planTo')}</a>
    </div>
    <section><h2>${th('nearbyStops')}</h2>
      ${near.length ? `<ul class="list">${near.map((n) => stopItem(n.stop,
        `${esc(fmtDistance(n.meters))} · ${th('walk', { min: fmtMinutes(walkMinutes(n.meters)) })}`)).join('')}</ul>`
        : `<p class="empty">${th('noStopsNearby', { m: fmtDistance(NEARBY_M) })}</p>`}
    </section>
    <details class="meta"><summary>${th('details')}</summary>
      <dl><dt>${th('coordinates')}</dt><dd dir="ltr">${end.lat.toFixed(6)}, ${end.lng.toFixed(6)}</dd></dl>
      <a href="${esc(osm)}" target="_blank" rel="noopener">${th('openOsm')}</a>
    </details>
  `, name);
  L.circle([end.lat, end.lng], { radius: NEARBY_M, color: '#1e88e5', weight: 1, fillOpacity: 0.05, interactive: false }).addTo(layers.focus);
  for (const n of near) {
    L.circleMarker([n.stop.lat, n.stop.lng], { radius: 6, color: '#37474f', weight: 2, fillColor: '#ffd54f', fillOpacity: 1 })
      .bindTooltip(n.stop.name).on('click', (e) => { L.DomEvent.stop(e); onStopClick(n.stop.id); }).addTo(layers.highlight);
  }
  L.circleMarker([end.lat, end.lng], { radius: 10, color: '#ffffff', weight: 3, fillColor: '#d32f2f', fillOpacity: 1, interactive: false })
    .bindTooltip(name, { permanent: true, direction: 'top', offset: [0, -10] }).addTo(layers.highlight);
  map.fitBounds(L.latLng(end.lat, end.lng).toBounds(NEARBY_M * 2), { padding: [10, 10] });
  expandPanel();
}

// Plan endpoints in the URL: "stop:123" or "pt:34.68,-1.91", plus an
// optional name for points (an address picked from the search).
function parseEnd(v, name) {
  if (!v) return null;
  let m = /^stop:(\d+)$/.exec(v);
  if (m && stopsById.has(currentStopId(Number(m[1])))) return { type: 'stop', id: currentStopId(Number(m[1])) };
  m = /^pt:(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/.exec(v);
  if (m) {
    const lat = Number(m[1]), lng = Number(m[2]);
    if (Math.abs(lat) <= 90 && Math.abs(lng) <= 180) return name ? { type: 'pt', lat, lng, name } : { type: 'pt', lat, lng };
  }
  return null;
}

function encodeEnd(e) {
  if (!e) return '';
  return e.type === 'stop' ? `stop:${e.id}` : `pt:${e.lat.toFixed(6)},${e.lng.toFixed(6)}`;
}

function endLabel(e) {
  if (!e) return '';
  if (e.type === 'stop') return stopsById.get(e.id).name;
  if (e.name) return e.name;
  return `${t('mapPoint')} (${e.lat.toFixed(5)}, ${e.lng.toFixed(5)})`;
}

// Endpoint values only use URL-safe characters, so they are not encoded,
// which keeps shared links readable. Place names are encoded.
function planHash(from, to, opt) {
  const q = [];
  if (from) q.push(`from=${encodeEnd(from)}`);
  if (from?.name) q.push(`fromName=${encodeURIComponent(from.name)}`);
  if (to) q.push(`to=${encodeEnd(to)}`);
  if (to?.name) q.push(`toName=${encodeURIComponent(to.name)}`);
  if (opt) q.push(`opt=${opt}`);
  return `#/plan${q.length ? '?' + q.join('&') : ''}`;
}

function currentPlanEnds() {
  const { params } = parseHash();
  return { from: parseEnd(params.get('from'), params.get('fromName')), to: parseEnd(params.get('to'), params.get('toName')) };
}

function setPlanEnd(which, end) {
  const ends = currentPlanEnds();
  ends[which] = end;
  go(planHash(ends.from, ends.to));
}

function renderPlan(params) {
  const from = parseEnd(params.get('from'), params.get('fromName'));
  const to = parseEnd(params.get('to'), params.get('toName'));
  const field = (which, end) => `
    <div class="plan-field">
      <label for="plan-${which}">${th(which)}</label>
      <div class="field-row">
        <div class="ac">
          <input id="plan-${which}" type="search" autocomplete="off" spellcheck="false"
            placeholder="${esc(t((which === 'from' ? 'fromPlaceholder' : 'toPlaceholder') + (CONFIG.geocoder ? 'Places' : '')))}" value="${esc(endLabel(end))}"
            role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="plan-${which}-list">
          <ul class="ac-list" id="plan-${which}-list" role="listbox" hidden></ul>
        </div>
        <button type="button" class="icon-btn" data-plan-locate="${which}" title="${esc(t('useMyLocation'))}" aria-label="${esc(t('useMyLocation'))}">${ICONS.locate}</button>
        <button type="button" class="icon-btn" data-plan-pick="${which}" title="${esc(t('pickOnMap'))}" aria-label="${esc(t('pickOnMap'))}">${ICONS.pin}</button>
      </div>
    </div>`;
  let results = '';
  let options = [];
  let selected = 0;
  if (!from || !to) results = `<p class="muted">${th('planNeedBoth')}</p>`;
  else {
    options = planner.plan(toPlannerPlace(from), toPlannerPlace(to));
    if (from.type === 'stop' && to.type === 'stop' && from.id === to.id) results = `<p class="muted">${th('planSame')}</p>`;
    else if (!options.length) results = `<p class="warning">${th('planNone', { m: fmtDistance(PLAN_DEFAULTS.accessWalkM) })}</p>`;
    else {
      selected = Math.min(Math.max(0, Number(params.get('opt')) || 0), options.length - 1);
      results = `<ol class="options">${options.map((o, i) => optionCard(o, i, i === selected, from, to)).join('')}</ol>
        <p class="note">${th('planDisclaimer', { kmh: net.assumptions.busKmh, fast: net.assumptions.fastKmh, wait: PLAN_DEFAULTS.waitMinutes })}</p>`;
    }
  }
  const picking = state.picking
    ? `<div class="pick-banner" role="status">${th('pickBanner', { which: t(state.picking === 'from' ? 'pickFrom' : 'pickTo') })}
        <button type="button" class="link-btn" data-pick-cancel>${th('cancel')}</button></div>` : '';
  setView(`
    <h1>${th('planTitle')}</h1>
    ${picking}
    <div class="plan-form">
      ${field('from', from)}
      <button type="button" class="icon-btn swap" data-plan-swap title="${esc(t('swap'))}" aria-label="${esc(t('swap'))}">${ICONS.swap}</button>
      ${field('to', to)}
    </div>
    <div id="plan-results">${results}</div>
  `, t('planTitle'));

  for (const which of ['from', 'to']) {
    attachAutocomplete($(`#plan-${which}`), (item, kind) => setPlanEnd(which, kind === 'place'
      ? { type: 'pt', lat: item.lat, lng: item.lng, name: item.name }
      : { type: 'stop', id: item.id }), { withPlaces: true });
  }
  const markEnd = (e, color) => {
    if (!e) return;
    const p = e.type === 'stop' ? stopsById.get(e.id) : e;
    L.circleMarker([p.lat, p.lng], { radius: 9, color: '#ffffff', weight: 3, fillColor: color, fillOpacity: 1, interactive: false })
      .bindTooltip(endLabel(e)).addTo(layers.highlight);
  };
  if (options.length) drawOption(options[selected], from, to);
  markEnd(from, '#2e7d32');
  markEnd(to, '#c62828');
  if (!options.length && (from || to)) {
    const pts = [from, to].filter(Boolean).map((e) => (e.type === 'stop' ? stopsById.get(e.id) : e));
    if (pts.length === 1) map.setView([pts[0].lat, pts[0].lng], Math.max(map.getZoom(), 15));
    else map.fitBounds(L.latLngBounds(pts.map((p) => [p.lat, p.lng])), { padding: [40, 40] });
  }
}

function toPlannerPlace(e) {
  return e.type === 'stop' ? e : { type: 'point', lat: e.lat, lng: e.lng, name: e.name };
}

// Walks only end at a map point when that point is the destination.
function placeName(place) {
  return place.type === 'stop' ? stopsById.get(place.id).name : place.name || t('destination');
}

function optionCard(o, i, selected, from, to) {
  const rides = o.legs.filter((l) => l.type === 'ride');
  const summary = rides.length
    ? rides.map((l) => badge(l.line)).join('<span class="sep" aria-hidden="true">›</span>')
    : `<span class="walk-tag">${th('walkOnly')}</span>`;
  const transfers = o.transfers === 0 ? th('transfers0') : o.transfers === 1 ? th('transfers1') : th('transfersN', { n: o.transfers });
  const legs = o.legs.map((leg) => {
    if (leg.type === 'walk') {
      return `<li class="leg walk"><span class="leg-icon" aria-hidden="true">🚶</span><span>${th('walkTo', {
        m: fmtDistance(leg.meters), min: fmtMinutes(leg.minutes), place: placeName(leg.to),
      })}</span></li>`;
    }
    const first = stopsById.get(leg.stops[0]);
    const last = stopsById.get(leg.stops[leg.stops.length - 1]);
    const n = leg.stops.length - 1;
    const middle = leg.stops.slice(1, -1).map((id) => `<li>${esc(stopsById.get(id).name)}</li>`).join('');
    return `<li class="leg ride" style="--line:${esc(leg.line.color)}">
      <span class="leg-icon" aria-hidden="true">🚌</span>
      <div>
        <div>${th('board', { line: raw(badge(leg.line)), towards: t('towards', { name: lastStop(leg.line, leg.direction).name }) })}</div>
        <div class="muted small">${th('boardAt', { name: first.name })}${stopFlagsHtml(first)}</div>
        <div class="muted small">${th(n === 1 ? 'rideStops1' : 'rideStops', { n, min: fmtMinutes(leg.minutes) })}</div>
        ${middle ? `<details><summary>${th('showStops')}</summary><ol class="mini">${middle}</ol></details>` : ''}
        <div class="muted small">${th('alightAt', { name: last.name })}${stopFlagsHtml(last)}</div>
      </div></li>`;
  }).join('');
  return `<li class="option${selected ? ' selected' : ''}">
    <a class="option-head" href="${esc(planHash(from, to, i))}" aria-current="${selected}">
      <span class="option-time">${esc(fmtMinutes(o.minutes))}</span>
      <span class="option-lines">${summary}</span>
      <span class="muted small">${rides.length ? transfers + ' · ' : ''}${th('walkTotal', { m: fmtDistance(o.walkMeters) })}</span>
    </a>
    ${selected ? `<ol class="legs">${legs}</ol>` : ''}
  </li>`;
}

function drawOption(o, from, to) {
  const all = [];
  const pt = (place) => (place.type === 'stop' ? stopsById.get(place.id) : place);
  for (const leg of o.legs) {
    if (leg.type === 'walk') {
      const a = pt(leg.from), b = pt(leg.to);
      const line = [[a.lat, a.lng], [b.lat, b.lng]];
      L.polyline(line, { color: '#546e7a', weight: 4, dashArray: '2 8', lineCap: 'round', interactive: false }).addTo(layers.focus);
      all.push(...line);
    } else {
      const pts = routeShape(leg.line.directions[leg.direction], leg.first, leg.first + leg.stops.length - 1);
      L.polyline(pts, { color: '#ffffff', weight: 10, opacity: 0.8, interactive: false }).addTo(layers.focus);
      L.polyline(pts, { color: leg.line.color, weight: 6, interactive: false }).addTo(layers.focus);
      leg.stops.forEach((id, i) => {
        const s = stopsById.get(id);
        const end = i === 0 || i === leg.stops.length - 1;
        L.circleMarker([s.lat, s.lng], { radius: end ? 7 : 4, color: leg.line.color, weight: 3, fillColor: '#ffffff', fillOpacity: 1 })
          .bindTooltip(s.name).on('click', (e) => { L.DomEvent.stop(e); onStopClick(id); }).addTo(layers.highlight);
      });
      all.push(...pts);
    }
  }
  if (!all.length) all.push(...[from, to].map((e) => { const p = pt(toPlannerPlace(e)); return [p.lat, p.lng]; }));
  map.fitBounds(L.latLngBounds(all), { padding: [40, 40] });
}

function renderFavorites() {
  const stops = favorites.list('stops').map((id) => stopsById.get(currentStopId(id))).filter(Boolean);
  const lines = favorites.list('lines').map((id) => linesById.get(id)).filter(Boolean);
  let html = `<h1>${th('tabFavorites')}</h1>`;
  if (!stops.length && !lines.length) html += `<p class="empty">${th('noFavorites')}</p>`;
  if (lines.length) html += `<section><h2>${th('favoriteLines')}</h2><ul class="line-grid">${lines.map(lineCard).join('')}</ul></section>`;
  if (stops.length) html += `<section><h2>${th('favoriteStops')}</h2><ul class="list">${stops.map((s) => stopItem(s)).join('')}</ul></section>`;
  setView(html, t('tabFavorites'));
  for (const s of stops) {
    L.circleMarker([s.lat, s.lng], { radius: 7, color: '#37474f', weight: 2, fillColor: '#ffca28', fillOpacity: 1 })
      .bindTooltip(s.name).on('click', (e) => { L.DomEvent.stop(e); onStopClick(s.id); }).addTo(layers.highlight);
  }
}

function renderAbout() {
  // The date the CSVs were exported from the operator, not the image build date.
  const date = new Date(net.exported ? `${net.exported}T12:00:00` : net.generated).toLocaleDateString(getLanguage() === 'ar' ? 'ar-MA' : getLanguage(), { dateStyle: 'long' });
  const issueLabel = { missing_name: 'issueMissingName', suspect_location: 'issueSuspect', repeated_stop: 'issueRepeated', placeholder_colors: 'issueColors' };
  const issues = net.issues.map((i) => {
    const what = [];
    if (i.line) what.push(lineLink(linesById.get(i.line), i.direction));
    if (i.stop) what.push(`<a href="#/stop/${i.stop}">${esc(stopsById.get(i.stop).name)}</a>`);
    return `<li><strong>${th(issueLabel[i.type] || i.type)}</strong> ${what.join(' ')}<br><span class="muted small" dir="ltr">${esc(i.detail)}</span></li>`;
  }).join('');
  const files = [
    ['data/lines.csv', 'lines.csv'], ['data/stops.csv', 'stops.csv'], ['data/line_stops.csv', 'line_stops.csv'], ['data/shapes.csv', 'shapes.csv'],
    ['data/network.geojson', 'network.geojson'], ['data/network.json', 'network.json'],
  ];
  setView(`
    <h1>${th('aboutTitle')}</h1>
    <p>${th('aboutText', { lines: net.lines.length, stops: net.stops.length, date })}</p>
    <section><h2>${th('liveTitle')}</h2><p>${th('liveText')}</p></section>
    <section><h2>${th('downloadsTitle')}</h2><ul class="downloads">${files.map(([href, name]) =>
      `<li><a href="${href}" download>${esc(name)}</a></li>`).join('')}</ul></section>
    <section><h2>${th('issuesTitle')}</h2><ul class="issues">${issues}</ul></section>
    <section><h2>${th('creditsTitle')}</h2><p>${th('creditsText')}</p></section>
  `, t('aboutTitle'));
}

// ---------- search ----------

// Search box with a suggestion list. Stops (and lines) are suggested while
// typing; with withPlaces, a last row searches addresses and places too, but
// only when chosen, so the geocoder gets one request per search.
function attachAutocomplete(input, onPick, { withLines = false, withPlaces = false } = {}) {
  const list = document.getElementById(input.getAttribute('aria-controls'));
  const places = withPlaces && CONFIG.geocoder;
  let results = [];
  let active = -1;
  let searchId = 0;
  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
    searchId++;
  };
  const paint = () => {
    list.querySelectorAll('[role="option"]').forEach((el, i) => {
      el.classList.toggle('active', i === active);
      el.setAttribute('aria-selected', String(i === active));
      if (i === active) el.scrollIntoView({ block: 'nearest' });
    });
  };
  const row = (r, i) => {
    const attrs = `role="option" id="${list.id}-${i}" data-i="${i}"`;
    if (r.kind === 'line') return `<li ${attrs}>${badge(r.item)}<span>${th('towards', { name: lastStop(r.item, Object.keys(r.item.directions)[0]).name })}</span></li>`;
    if (r.kind === 'geo') return `<li ${attrs} class="geo-row">${ICONS.search}<span>${th('searchPlaces', { q: r.item })}</span></li>`;
    if (r.kind === 'place') return `<li ${attrs} class="place-row">${ICONS.pin}<span class="place-text"><span class="stop-name">${esc(r.item.name)}</span>${r.item.detail ? `<span class="muted small">${esc(r.item.detail)}</span>` : ''}</span></li>`;
    return `<li ${attrs}><span class="stop-name">${esc(r.item.name)}${stopFlagsHtml(r.item)}</span><span class="badges small">${badges(r.item.lines)}</span></li>`;
  };
  const show = (items, message) => {
    results = items;
    list.innerHTML = items.map(row).join('') + (message ? `<li class="muted" aria-disabled="true">${message}</li>` : '');
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    active = items.length ? 0 : -1;
    paint();
  };
  const searchPlaces = async (q) => {
    const id = ++searchId;
    show([], th('searchingPlaces'));
    try {
      const fallback = CONFIG.geocoderBrowserUrl ? { url: CONFIG.geocoderBrowserUrl, viewbox: CONFIG.geocoderViewbox } : null;
      const found = await geocode(q, getLanguage(), fallback);
      if (id !== searchId) return;
      show(found.map((p) => ({ kind: 'place', item: p })), found.length ? '' : th('noPlaces'));
    } catch (err) {
      if (id !== searchId) return;
      const status = err?.status || 0;
      show([], status === 429 ? th('placesBusy') : `${th('placesError')} <span class="small">(${status ? th('placesErrorCode', { code: status }) : th('placesErrorNetwork')})</span>`);
    }
  };
  const choose = (r) => {
    if (r.kind === 'geo') { searchPlaces(r.item); return; }
    close();
    onPick(r.item, r.kind);
  };
  input.addEventListener('input', () => {
    searchId++;
    const q = input.value.trim();
    if (!q) { close(); return; }
    const lines = withLines ? searchLines(net, stopsById, q).slice(0, 5).map((l) => ({ kind: 'line', item: l })) : [];
    const stops = searchStops(index, q, 12).map((s) => ({ kind: 'stop', item: s }));
    const geo = places && q.length >= 3 ? [{ kind: 'geo', item: q }] : [];
    const items = [...lines, ...stops, ...geo];
    show(items, items.length ? '' : th('noResults'));
  });
  input.addEventListener('keydown', (e) => {
    if (list.hidden) return;
    if (e.key === 'ArrowDown') { active = Math.min(results.length - 1, active + 1); paint(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(0, active - 1); paint(); e.preventDefault(); }
    else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); choose(results[active]); }
    else if (e.key === 'Escape') close();
  });
  list.addEventListener('mousedown', (e) => e.preventDefault());
  list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-i]');
    if (li) choose(results[Number(li.dataset.i)]);
  });
  input.addEventListener('blur', () => setTimeout(() => { if (document.activeElement !== input) close(); }, 100));
  return close;
}

let closeMainSearch = () => {};
function closeSearch() { closeMainSearch(); }

function setupSearch() {
  const input = $('#search');
  closeMainSearch = attachAutocomplete(input, (item, kind) => {
    input.value = '';
    input.blur();
    go(kind === 'line' ? `#/line/${item.id}` : kind === 'place' ? placeHash(item) : `#/stop/${item.id}`);
  }, { withLines: true, withPlaces: true });
}

// ---------- chrome ----------

function expandPanel() {
  document.body.classList.remove('panel-collapsed');
}

function renderChrome() {
  $('#app-name').textContent = t('appName');
  $('#search').placeholder = t(CONFIG.geocoder ? 'searchPlaceholderPlaces' : 'searchPlaceholder');
  $('#search').setAttribute('aria-label', t('searchLabel'));
  $('#lang').setAttribute('aria-label', t('language'));
  $('#panel-handle').setAttribute('aria-label', t('panelToggle'));
  for (const b of document.querySelectorAll('[data-map]')) {
    const label = t({ locate: 'mapLocate', lines: 'mapAllLines', fit: 'mapFit' }[b.dataset.map]);
    b.title = label;
    b.setAttribute('aria-label', label);
  }
  for (const a of document.querySelectorAll('.tabs a')) {
    a.textContent = t({ lines: 'tabLines', nearby: 'tabNearby', plan: 'tabPlan', favorites: 'tabFavorites', about: 'tabAbout' }[a.dataset.tab]);
  }
  applyTheme();
}

function setupChrome() {
  const select = $('#lang');
  select.innerHTML = LANGUAGES.map((l) => `<option value="${l.code}"${l.code === getLanguage() ? ' selected' : ''}>${esc(l.label)}</option>`).join('');
  select.addEventListener('change', () => {
    setLanguage(select.value);
    renderChrome();
    if (net) route();
  });
  $('#theme-btn').addEventListener('click', () => {
    const cur = load('theme', 'auto');
    save('theme', THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
    applyTheme();
  });
  $('#panel-handle').addEventListener('click', () => {
    document.body.classList.toggle('panel-collapsed');
  });

  // Delegated actions inside views.
  view().addEventListener('click', async (e) => {
    const fav = e.target.closest('[data-fav]');
    if (fav) {
      const [kind, id] = fav.dataset.fav.split(':');
      const on = favorites.toggle(kind, Number(id));
      fav.classList.toggle('on', on);
      fav.textContent = on ? '★' : '☆';
      fav.setAttribute('aria-pressed', String(on));
      fav.title = t(on ? 'removeFavorite' : 'addFavorite');
      fav.setAttribute('aria-label', fav.title);
      return;
    }
    if (e.target.closest('[data-share]')) {
      const url = location.href;
      try {
        if (navigator.share) await navigator.share({ title: document.title, url });
        else { await navigator.clipboard.writeText(url); toast(t('linkCopied')); }
      } catch (err) {
        if (err && err.name !== 'AbortError') toast(url);
      }
      return;
    }
    if (e.target.closest('[data-clear-recents]')) {
      recents.clear();
      route();
      return;
    }
    const swap = e.target.closest('[data-plan-swap]');
    if (swap) {
      const { from, to } = currentPlanEnds();
      go(planHash(to, from));
      return;
    }
    const loc = e.target.closest('[data-plan-locate]');
    if (loc) {
      const which = loc.dataset.planLocate;
      loc.disabled = true;
      try {
        const p = await locate();
        setPlanEnd(which, { type: 'pt', lat: p.lat, lng: p.lng });
      } catch (err) {
        toast(err.message);
        loc.disabled = false;
      }
      return;
    }
    const pick = e.target.closest('[data-plan-pick]');
    if (pick) {
      state.picking = pick.dataset.planPick;
      document.body.classList.add('picking');
      if (window.matchMedia('(max-width: 760px)').matches) document.body.classList.add('panel-collapsed');
      route();
      return;
    }
    if (e.target.closest('[data-pick-cancel]')) {
      state.picking = null;
      document.body.classList.remove('picking');
      route();
    }
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return;
  // When an update installs a new service worker, reload once so the page
  // runs the new version instead of what it was first loaded with.
  const hadController = Boolean(navigator.serviceWorker.controller);
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (hadController && !reloading) {
      reloading = true;
      location.reload();
    }
  });
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
}

async function loadNetwork() {
  const res = await fetch('data/network.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function start() {
  initLanguage(CONFIG.defaultLanguage);
  setupChrome();
  renderChrome();
  setupMap();
  view().innerHTML = `<p class="muted">${th('loading')}</p>`;
  try {
    net = await loadNetwork();
  } catch (err) {
    view().innerHTML = `<p class="warning">${th('loadError')} <span class="muted">(${esc(err.message)})</span></p>
      <button class="btn" type="button" id="retry">${th('retry')}</button>`;
    $('#retry').addEventListener('click', () => location.reload());
    return;
  }
  stopsById = new Map(net.stops.map((s) => [s.id, s]));
  linesById = new Map(net.lines.map((l) => [l.id, l]));
  index = buildIndex(net);
  planner = createPlanner(net);
  fitNetwork(false);
  drawNetwork();
  setupSearch();
  window.addEventListener('hashchange', route);
  window.addEventListener('offline', () => toast(t('offline')));
  route();
  registerServiceWorker();
}

start();

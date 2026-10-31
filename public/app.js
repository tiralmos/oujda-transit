'use strict';
/* Oujda Transit front end: Leaflet map, search, lines, stops, trip planner, favourites. */
(function () {
  // ---------- small helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const LS = {
    get(k, d) { try { const v = JSON.parse(localStorage.getItem(`ot.${k}`)); return v ?? d; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(`ot.${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  function h(tag, props, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'text') el.textContent = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [prop, val] of Object.entries(v)) {
          if (prop.startsWith('--')) el.style.setProperty(prop, val); else el.style[prop] = val;
        }
      }
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9؀-ۿ]+/g, ' ').replace(/\bterm[iu]n[iu]s\b/g, 'terminus').trim();

  function distance(a, b) {
    const R = 6371000, rad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * rad, dLng = (b.lng - a.lng) * rad;
    const x = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(x));
  }

  // ---------- state ----------
  const langs = Object.keys(window.I18N);
  const browserLang = (navigator.language || 'fr').slice(0, 2);
  const state = {
    lang: LS.get('lang', langs.includes(browserLang) ? browserLang : 'fr'),
    theme: LS.get('theme', matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'),
    meta: null,
    stops: new Map(),
    lines: new Map(),
    favs: LS.get('favs', { stops: [], lines: [], trips: [] }),
    recent: LS.get('recent', []),
    showAllLines: LS.get('allLines', false),
    userPos: null,
    pick: null, // 'f' or 't' while choosing a trip point on the map
    planCache: new Map(),
  };

  function t(key, vars) {
    const dict = window.I18N[state.lang] || window.I18N.fr;
    let s = dict[key] ?? window.I18N.fr[key] ?? key;
    for (const [k, v] of Object.entries(vars || {})) s = s.replace(`{${k}}`, v);
    return s;
  }
  const fmtDist = (m) => (m >= 1000 ? t('km', { n: (m / 1000).toFixed(1) }) : t('m', { n: Math.round(m / 10) * 10 }));
  const fmtDur = (s) => {
    const min = Math.max(1, Math.round(s / 60));
    return min >= 60 ? `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}` : t('min', { n: min });
  };
  const walkMin = (m) => fmtDur((m * 1.25) / 1.3);

  async function api(path, opts) {
    const res = await fetch(path, opts);
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status });
    return res.json();
  }

  let toastTimer;
  function toast(msg) {
    const el = $('#toast');
    el.textContent = msg; el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2500);
  }

  // ---------- favourites & recent ----------
  const isFav = (kind, id) => state.favs[kind].some((f) => (f.id ?? f) === id);
  function toggleFav(kind, item) {
    const id = item.id ?? item;
    const list = state.favs[kind];
    const i = list.findIndex((f) => (f.id ?? f) === id);
    if (i >= 0) list.splice(i, 1); else list.unshift(item);
    LS.set('favs', state.favs);
  }
  function favButton(kind, item) {
    const id = item.id ?? item;
    const btn = h('button', { class: 'icon-btn fav-btn', type: 'button' });
    const paint = () => {
      const on = isFav(kind, id);
      btn.textContent = on ? '★' : '☆';
      btn.classList.toggle('on', on);
      btn.title = on ? t('removeFav') : t('addFav');
      btn.setAttribute('aria-label', btn.title);
    };
    btn.addEventListener('click', () => { toggleFav(kind, item); paint(); });
    paint();
    return btn;
  }
  function addRecent(entry) {
    state.recent = [entry, ...state.recent.filter((r) => r.href !== entry.href)].slice(0, 8);
    LS.set('recent', state.recent);
  }

  function shareButton() {
    return h('button', {
      class: 'icon-btn', type: 'button', title: t('share'), 'aria-label': t('share'),
      onclick: async () => {
        const url = location.href;
        try {
          if (navigator.share) { await navigator.share({ title: document.title, url }); return; }
          await navigator.clipboard.writeText(url);
          toast(t('copied'));
        } catch { /* cancelled */ }
      },
    }, '⤴');
  }

  const lineChip = (line, extra = {}) => h('span', {
    class: 'chip', style: { background: line.color, color: line.textColor }, title: `${line.name} ${line.from || ''} – ${line.to || ''}`, ...extra,
  }, line.number);

  // ---------- map ----------
  let map, stopRenderer, stopsLayer, allLinesLayer, focusLayer, userLayer;
  const stopMarkers = new Map();

  function initMap() {
    map = L.map('map', { zoomControl: false, preferCanvas: true, worldCopyJump: false });
    L.control.zoom({ position: 'topright' }).addTo(map);
    L.tileLayer(state.meta.tileUrl, {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);
    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);

    // City centre: median of all stops (the bounds include a few far-away stops).
    const lats = [...state.stops.values()].map((s) => s.lat).sort((a, b) => a - b);
    const lngs = [...state.stops.values()].map((s) => s.lng).sort((a, b) => a - b);
    map.setView([lats[lats.length >> 1], lngs[lngs.length >> 1]], 13);

    stopRenderer = L.canvas({ padding: 0.5 });
    allLinesLayer = L.layerGroup();
    stopsLayer = L.layerGroup().addTo(map);
    focusLayer = L.layerGroup().addTo(map);
    userLayer = L.layerGroup().addTo(map);

    for (const s of state.stops.values()) {
      const m = L.circleMarker([s.lat, s.lng], {
        renderer: stopRenderer, radius: 4, weight: 1.5, color: '#1f2937', fillColor: '#ffffff', fillOpacity: 1,
      });
      m.bindTooltip(s.name, { direction: 'top', offset: [0, -4] });
      m.on('click', (e) => { L.DomEvent.stopPropagation(e); go(`/stop/${s.id}`); });
      m.addTo(stopsLayer);
      stopMarkers.set(s.id, m);
    }
    const resize = () => {
      const z = map.getZoom();
      const r = z < 12 ? 1.5 : z < 14 ? 3 : z < 16 ? 4.5 : 6;
      for (const m of stopMarkers.values()) m.setRadius(r);
    };
    map.on('zoomend', resize); resize();

    for (const line of state.lines.values()) {
      const coords = line.directions[0]?.stops.map((id) => [state.stops.get(id).lat, state.stops.get(id).lng]) || [];
      L.polyline(coords, { color: line.color, weight: 3, opacity: 0.55 })
        .bindTooltip(`${line.name}: ${line.from} – ${line.to}`, { sticky: true })
        .on('click', () => go(`/line/${line.id}`))
        .addTo(allLinesLayer);
    }
    setAllLines(state.showAllLines);

    // Locate button
    const Locate = L.Control.extend({
      onAdd() {
        const b = L.DomUtil.create('button', 'map-btn');
        b.type = 'button'; b.textContent = '◎'; b.title = t('locateMe'); b.setAttribute('aria-label', t('locateMe'));
        L.DomEvent.on(b, 'click', (e) => { L.DomEvent.stop(e); locate(true); });
        return b;
      },
    });
    new Locate({ position: 'topright' }).addTo(map);

    map.on('click', onMapClick);
  }

  function setAllLines(on) {
    state.showAllLines = on; LS.set('allLines', on);
    if (on) { allLinesLayer.addTo(map); stopsLayer.remove(); stopsLayer.addTo(map); } else allLinesLayer.remove();
  }

  function lineCoords(line, dirId) {
    const dir = line.directions.find((d) => d.id === dirId) || line.directions[0];
    return dir.stops.map((id) => state.stops.get(id)).map((s) => [s.lat, s.lng]);
  }

  function pin(lat, lng, cls, label) {
    return L.marker([lat, lng], {
      icon: L.divIcon({ className: `pin ${cls}`, html: `<span><b>${label || ''}</b></span>`, iconSize: [28, 28], iconAnchor: [14, 28] }),
      keyboard: false,
    });
  }

  /** Padding so fitted features are not hidden behind the panel. */
  function fitOpts(extra = {}) {
    const panel = $('#panel').getBoundingClientRect();
    const mobile = innerWidth <= 720;
    const rtl = document.documentElement.dir === 'rtl';
    if (mobile) return { paddingTopLeft: [20, 60], paddingBottomRight: [20, innerHeight - panel.top + 20], ...extra };
    const side = panel.width + 40;
    return rtl
      ? { paddingTopLeft: [60, 30], paddingBottomRight: [side, 30], ...extra }
      : { paddingTopLeft: [side, 30], paddingBottomRight: [60, 30], ...extra };
  }
  function fit(bounds, extra) { if (bounds.isValid()) map.fitBounds(bounds, fitOpts(extra)); }
  function centerOn(lat, lng, zoom) {
    // setView, shifted so the point sits in the visible part of the map.
    const o = fitOpts();
    const z = zoom ?? map.getZoom();
    const pt = map.project([lat, lng], z);
    const dx = (o.paddingTopLeft[0] - o.paddingBottomRight[0]) / 2;
    const dy = (o.paddingTopLeft[1] - o.paddingBottomRight[1]) / 2;
    map.setView(map.unproject(pt.subtract([dx, dy]), z), z);
  }

  function highlightStop(s, color = '#0d6efd') {
    L.circleMarker([s.lat, s.lng], { radius: 9, weight: 3, color, fillColor: '#fff', fillOpacity: 1 }).addTo(focusLayer);
  }

  function nearestStops(pt, n = 5, radius = 1500) {
    const out = [];
    for (const s of state.stops.values()) {
      const d = distance(pt, s);
      if (d <= radius) out.push({ s, d });
    }
    return out.sort((a, b) => a.d - b.d).slice(0, n);
  }

  function onMapClick(e) {
    const pt = { lat: +e.latlng.lat.toFixed(6), lng: +e.latlng.lng.toFixed(6) };
    const near = nearestStops(pt, 1, 800)[0];
    pt.name = near ? t('near', { name: near.s.name }) : t('mapPoint');
    if (state.pick) {
      const which = state.pick; state.pick = null;
      document.body.classList.remove('picking');
      setTripPoint(which, pt);
      return;
    }
    const content = h('div', { class: 'popup' },
      h('strong', { text: pt.name }),
      h('div', { class: 'popup-actions' },
        h('button', { type: 'button', class: 'btn small', onclick: () => { map.closePopup(); setTripPoint('f', pt); } }, t('fromHere')),
        h('button', { type: 'button', class: 'btn small', onclick: () => { map.closePopup(); setTripPoint('t', pt); } }, t('toHere')),
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => { map.closePopup(); go(placeHref(pt)); } }, t('nearbyStops'))));
    L.popup({ closeButton: true }).setLatLng(e.latlng).setContent(content).openOn(map);
  }

  // ---------- geolocation ----------
  function locate(fly) {
    return new Promise((resolve) => {
      if (!navigator.geolocation) { toast(t('locationDenied')); resolve(null); return; }
      toast(t('locating'));
      navigator.geolocation.getCurrentPosition((pos) => {
        state.userPos = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy };
        userLayer.clearLayers();
        L.circle([state.userPos.lat, state.userPos.lng], { radius: Math.min(state.userPos.acc, 300), color: '#0d6efd', weight: 1, fillOpacity: 0.12, interactive: false }).addTo(userLayer);
        L.circleMarker([state.userPos.lat, state.userPos.lng], { radius: 7, color: '#fff', weight: 2, fillColor: '#0d6efd', fillOpacity: 1 }).bindTooltip(t('myLocation')).addTo(userLayer);
        if (fly) centerOn(state.userPos.lat, state.userPos.lng, 16);
        $('#toast').hidden = true;
        if (currentRoute().path === '/') render();
        resolve(state.userPos);
      }, () => { toast(t('locationDenied')); resolve(null); }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 });
    });
  }

  // ---------- search (stops, lines, places) ----------
  function localStopSearch(q) {
    const nq = norm(q);
    if (!nq) return { stops: [], lines: [] };
    const tokens = nq.split(' ');
    const stops = [...state.stops.values()]
      .map((s) => {
        const n = norm(s.name);
        const words = n.split(' ');
        let score = 0;
        if (n.startsWith(nq)) score = 0.95;
        else if (tokens.every((tk) => words.some((w) => w.startsWith(tk)))) score = 0.88;
        else if (n.includes(nq)) score = 0.8;
        else if (tokens.some((tk) => tk.length > 2 && words.some((w) => w.startsWith(tk)))) score = 0.5;
        return { ...s, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 12);
    const m = nq.match(/^(?:l|ligne|line|bus)?\s*0*(\d{1,3})$/);
    const lines = m ? [...state.lines.values()].filter((l) => l.number === m[1]) : [];
    return { stops, lines };
  }

  async function searchStops(q, signal) {
    try {
      const pos = state.userPos ? `&lat=${state.userPos.lat}&lng=${state.userPos.lng}` : '';
      return await api(`/api/search?q=${encodeURIComponent(q)}${pos}`, { signal });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      return localStopSearch(q);
    }
  }

  const placeCache = new Map();
  let lastBrowserGeocode = 0;

  function viewbox() {
    const [[a, b], [c, d]] = state.meta.bounds;
    return [b - 0.05, c + 0.05, d + 0.05, a - 0.05]; // left, top, right, bottom
  }

  async function browserNominatim(q, signal) {
    const wait = lastBrowserGeocode + 1000 - Date.now(); // Nominatim policy: 1 request per second
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    if (signal.aborted) throw new DOMException('aborted', 'AbortError');
    lastBrowserGeocode = Date.now();
    const p = new URLSearchParams({
      q, format: 'jsonv2', limit: '8', countrycodes: 'ma', viewbox: viewbox().join(','), bounded: '1',
      'accept-language': state.lang === 'ar' ? 'ar,fr' : `${state.lang},fr`,
    });
    const res = await fetch(`${state.meta.geocoder.nominatim}/search?${p}`, { signal });
    if (!res.ok) throw new Error(`nominatim ${res.status}`);
    return (await res.json()).map((x) => ({
      name: x.name || x.display_name.split(',')[0], detail: x.display_name, lat: +x.lat, lng: +x.lon, type: x.type,
    }));
  }

  async function browserPhoton(q, signal) {
    const vb = viewbox();
    const [[a, b], [c, d]] = state.meta.bounds;
    const p = new URLSearchParams({ q, limit: '8', lat: String((a + c) / 2), lon: String((b + d) / 2), bbox: [vb[0], vb[3], vb[2], vb[1]].join(',') });
    const res = await fetch(`${state.meta.geocoder.photon}/api/?${p}`, { signal });
    if (!res.ok) throw new Error(`photon ${res.status}`);
    return ((await res.json()).features || []).map((f) => {
      const pr = f.properties || {};
      const detail = [pr.name, pr.street, pr.district, pr.city].filter(Boolean).join(', ');
      return { name: pr.name || pr.street || detail, detail, lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0], type: pr.osm_value };
    });
  }

  /** Places from the server; if the server cannot reach OpenStreetMap, the browser asks OSM itself. */
  async function searchPlaces(q, signal) {
    const key = q.trim().toLowerCase();
    if (placeCache.has(key)) return placeCache.get(key);
    let result;
    try {
      const r = await api(`/api/places?q=${encodeURIComponent(q)}`, { signal });
      result = { places: r.places, via: 'server' };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      let places = [];
      let ok = false;
      for (const fn of [browserNominatim, browserPhoton]) {
        try {
          places = places.concat(await fn(q, signal));
          ok = true;
          if (places.length >= 3) break;
        } catch (err) { if (err.name === 'AbortError') throw err; }
      }
      if (!ok) return { places: [], via: 'failed' };
      result = { places: dedupePlaces(places), via: 'browser' };
    }
    placeCache.set(key, result);
    return result;
  }

  function dedupePlaces(list) {
    const out = [];
    for (const p of list) {
      if (!Number.isFinite(p.lat) || !p.name) continue;
      if (out.some((o) => o.name === p.name && Math.abs(o.lat - p.lat) < 5e-4 && Math.abs(o.lng - p.lng) < 5e-4)) continue;
      out.push(p);
    }
    return out.slice(0, 8);
  }

  /**
   * Autocomplete over stops, lines and places, used by the main search and the trip inputs.
   * onPick receives {kind:'stop'|'line'|'place', item}.
   */
  function autocomplete(input, box, onPick, { lines = true, extra } = {}) {
    let ctrl = null;
    let timer = null;
    let placeTimer = null;
    let items = [];
    let active = -1;

    const close = () => { box.hidden = true; box.replaceChildren(); items = []; active = -1; input.setAttribute('aria-expanded', 'false'); };
    const setActive = (i) => {
      items.forEach((el, j) => el.classList.toggle('active', j === i));
      active = i;
      if (items[i]) items[i].scrollIntoView({ block: 'nearest' });
    };
    const option = (content, pick) => {
      const el = h('div', { class: 'result', role: 'option', tabindex: '-1', onmousedown: (e) => { e.preventDefault(); close(); pick(); } }, content);
      el._pick = pick;
      items.push(el);
      return el;
    };

    function renderResults(q, data, places) {
      box.replaceChildren(); items = [];
      if (extra) {
        const ex = extra(q);
        if (ex.length) box.append(...ex.map(([content, pick]) => option(content, pick)));
      }
      if (lines && data.lines.length) {
        box.append(h('div', { class: 'result-head', text: t('lines') }));
        for (const l of data.lines) {
          const line = state.lines.get(l.id) || l;
          box.append(option([lineChip(line), h('span', { class: 'r-main', text: `${line.from} – ${line.to}` })], () => onPick({ kind: 'line', item: line })));
        }
      }
      // Stops come first when the query clearly names a stop; otherwise places do.
      const strong = data.stops.some((s) => (s.score ?? 1) >= 0.85);
      const stopSection = () => {
        const list = strong ? data.stops : data.stops.slice(0, 4);
        box.append(h('div', { class: 'result-head', text: t('stops') }));
        if (!list.length) box.append(h('div', { class: 'result-empty', text: t('noResults') }));
        for (const s of list) {
          const stop = state.stops.get(s.id) || s;
          const chips = stop.lines.slice(0, 6).map((id) => state.lines.get(id)).filter(Boolean).map((l) => lineChip(l, { class: 'chip sm' }));
          const dist = state.userPos ? h('span', { class: 'r-dist', text: fmtDist(distance(state.userPos, stop)) }) : null;
          box.append(option([h('span', { class: 'r-icon stop-icon' }), h('span', { class: 'r-main', text: stop.name }), h('span', { class: 'r-chips' }, chips), dist],
            () => onPick({ kind: 'stop', item: stop })));
        }
      };
      const placeSection = () => {
        if (q.length < 3) return;
        box.append(h('div', { class: 'result-head', text: t('places') }));
        if (!places) box.append(h('div', { class: 'result-empty', text: t('placesLoading') }));
        else if (places.via === 'failed') box.append(h('div', { class: 'result-empty', text: t('placesFailed') }));
        else {
          if (!places.places.length) box.append(h('div', { class: 'result-empty', text: t('noResults') }));
          for (const p of places.places) {
            const near = nearestStops(p, 1, 3000)[0];
            box.append(option([
              h('span', { class: 'r-icon place-icon' }),
              h('span', { class: 'r-main' }, p.name, h('small', { text: shortDetail(p) })),
              near ? h('span', { class: 'r-dist', text: fmtDist(near.d) }) : null,
            ], () => onPick({ kind: 'place', item: p })));
          }
          if (places.via === 'browser' && places.places.length) box.append(h('div', { class: 'result-note', text: t('placesBrowser') }));
        }
      };
      const placesFirst = !strong && places && places.places?.length;
      if (placesFirst) { placeSection(); stopSection(); } else { stopSection(); placeSection(); }
      box.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (items.length) setActive(0);
    }

    input.addEventListener('input', () => {
      const q = input.value.trim();
      clearTimeout(timer); clearTimeout(placeTimer);
      if (ctrl) ctrl.abort();
      if (!q) { close(); return; }
      ctrl = new AbortController();
      const { signal } = ctrl;
      timer = setTimeout(async () => {
        let data;
        try { data = await searchStops(q, signal); } catch { return; }
        if (signal.aborted) return;
        renderResults(q, data, null);
        if (q.length < 3) return;
        placeTimer = setTimeout(async () => {
          try {
            const places = await searchPlaces(q, signal);
            if (!signal.aborted) renderResults(q, data, places);
          } catch { /* aborted */ }
        }, 450);
      }, 150);
    });
    input.addEventListener('keydown', (e) => {
      if (box.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive(Math.min(items.length - 1, active + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(Math.max(0, active - 1)); }
      else if (e.key === 'Enter' && items[active]) { e.preventDefault(); const p = items[active]._pick; close(); p(); }
      else if (e.key === 'Escape') close();
    });
    input.addEventListener('blur', () => setTimeout(close, 150));
    input.addEventListener('focus', () => { if (input.value.trim()) input.dispatchEvent(new Event('input')); });
    return { close };
  }

  function shortDetail(p) {
    const parts = String(p.detail || '').split(',').map((s) => s.trim()).filter((s) => s && s !== p.name);
    return parts.slice(0, 3).join(', ');
  }

  const placeHref = (p) => `/place?lat=${p.lat}&lng=${p.lng}&name=${encodeURIComponent(p.name || '')}${p.detail ? `&d=${encodeURIComponent(shortDetail(p))}` : ''}`;

  function initSearch() {
    const input = $('#searchInput');
    const clear = $('#searchClear');
    input.addEventListener('input', () => { clear.hidden = !input.value; });
    clear.addEventListener('click', () => { input.value = ''; clear.hidden = true; input.focus(); });
    autocomplete(input, $('#searchResults'), ({ kind, item }) => {
      input.blur();
      if (kind === 'stop') { addRecent({ kind, label: item.name, href: `/stop/${item.id}` }); go(`/stop/${item.id}`); }
      else if (kind === 'line') { addRecent({ kind, label: `${item.name} ${item.from} – ${item.to}`, href: `/line/${item.id}` }); go(`/line/${item.id}`); }
      else { const href = placeHref(item); addRecent({ kind, label: item.name, href }); go(href); }
    });
  }

  // ---------- trip planning ----------
  function tripFromRoute(params) {
    const pt = (k) => {
      const v = params.get(k);
      const m = v && v.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
      return m ? { lat: +m[1], lng: +m[2], name: params.get(`${k}n`) || t('mapPoint') } : null;
    };
    return { f: pt('f'), t: pt('t') };
  }
  function planHref(trip, i) {
    const p = new URLSearchParams();
    for (const k of ['f', 't']) {
      if (!trip[k]) continue;
      p.set(k, `${(+trip[k].lat).toFixed(6)},${(+trip[k].lng).toFixed(6)}`);
      p.set(`${k}n`, trip[k].name || '');
    }
    if (i) p.set('i', i);
    return `/plan?${p}`;
  }
  function setTripPoint(which, pt) {
    const r = currentRoute();
    const trip = r.path === '/plan' ? tripFromRoute(r.params) : (state.lastTrip || { f: null, t: null });
    trip[which] = pt;
    state.lastTrip = trip;
    go(planHref(trip));
  }
  const stopPoint = (s) => ({ lat: s.lat, lng: s.lng, name: s.name });

  // ---------- routing ----------
  function currentRoute() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, query] = raw.split('?');
    return { path: path || '/', params: new URLSearchParams(query || '') };
  }
  function go(path) {
    const target = `#${path}`;
    if (location.hash === target) render(); else location.hash = target;
  }

  function setTab(name) {
    document.querySelectorAll('.tabs a').forEach((a) => a.classList.toggle('active', a.dataset.tab === name));
  }

  function render() {
    const { path, params } = currentRoute();
    focusLayer.clearLayers();
    map.closePopup();
    const view = $('#view');
    view.replaceChildren();
    let m;
    if (path === '/' || path === '') { setTab('explore'); viewExplore(view); }
    else if (path === '/lines') { setTab('lines'); viewLines(view); }
    else if ((m = path.match(/^\/line\/([^/]+)$/))) { setTab('lines'); viewLine(view, decodeURIComponent(m[1]), params.get('d')); }
    else if ((m = path.match(/^\/stop\/([^/]+)$/))) { setTab('explore'); viewStop(view, decodeURIComponent(m[1])); }
    else if (path === '/place') { setTab('explore'); viewPlace(view, params); }
    else if (path === '/plan') { setTab('plan'); viewPlan(view, params); }
    else if (path === '/favs') { setTab('favs'); viewFavs(view); }
    else { setTab('explore'); viewExplore(view); }
    view.scrollTop = 0;
    document.body.classList.remove('picking');
    state.pick = null;
  }

  const backBtn = () => h('button', { class: 'icon-btn', type: 'button', title: t('back'), 'aria-label': t('back'), onclick: () => (history.length > 1 ? history.back() : go('/')) }, state.lang === 'ar' ? '→' : '←');

  // ---------- views ----------
  function viewExplore(view) {
    const nearSection = h('section', { class: 'section' }, h('h2', { text: t('nearbyTitle') }));
    if (state.userPos) {
      const list = nearestStops(state.userPos, 8, 1500);
      if (!list.length) nearSection.append(h('p', { class: 'muted', text: t('noResults') }));
      nearSection.append(stopList(list.map(({ s, d }) => ({ s, d }))));
      for (const { s } of list) highlightStop(s, '#0d6efd');
    } else {
      nearSection.append(h('p', { class: 'muted', text: t('nearbyHint') }),
        h('button', { class: 'btn', type: 'button', onclick: () => locate(true) }, '◎ ', t('locateMe')));
    }
    view.append(nearSection);

    if (state.recent.length) {
      view.append(h('section', { class: 'section' },
        h('div', { class: 'section-head' }, h('h2', { text: t('recent') }),
          h('button', { class: 'link-btn', type: 'button', onclick: () => { state.recent = []; LS.set('recent', []); render(); } }, t('clear'))),
        h('ul', { class: 'list' }, state.recent.map((r) => h('li', {}, h('a', { href: `#${r.href}`, class: 'row' },
          h('span', { class: `r-icon ${r.kind === 'place' ? 'place-icon' : r.kind === 'line' ? 'line-icon' : 'stop-icon'}` }),
          h('span', { class: 'r-main', text: r.label })))))));
    }

    view.append(h('section', { class: 'section' }, h('h2', { text: t('lines') }),
      h('div', { class: 'chip-grid' }, [...state.lines.values()].map((l) => h('a', { href: `#/line/${l.id}`, 'aria-label': `${l.name} ${l.from} – ${l.to}` }, lineChip(l, { class: 'chip lg' }))))));
  }

  function stopList(entries) {
    return h('ul', { class: 'list' }, entries.map(({ s, d }) => h('li', {},
      h('a', { href: `#/stop/${s.id}`, class: 'row' },
        h('span', { class: 'r-icon stop-icon' }),
        h('span', { class: 'r-main' }, s.name, d !== undefined ? h('small', { text: `${fmtDist(d)} · ${walkMin(d)}` }) : null),
        h('span', { class: 'r-chips' }, s.lines.map((id) => state.lines.get(id)).filter(Boolean).map((l) => lineChip(l, { class: 'chip sm' })))))));
  }

  function viewLines(view) {
    const toggle = h('input', { type: 'checkbox', id: 'allLinesToggle', onchange: (e) => setAllLines(e.target.checked) });
    toggle.checked = state.showAllLines;
    view.append(h('label', { class: 'toggle', for: 'allLinesToggle' }, toggle, t('showAllLines')));
    view.append(h('ul', { class: 'list' }, [...state.lines.values()].map((l) => h('li', {},
      h('a', { href: `#/line/${l.id}`, class: 'row' },
        lineChip(l, { class: 'chip lg' }),
        h('span', { class: 'r-main' }, `${l.from} ⇄ ${l.to}`,
          h('small', { text: l.directions.map((d) => t('stopsCount', { n: d.stops.length })).join(' / ') + ` · ${fmtDist(l.directions[0].length)}` })))))));
    if (state.showAllLines) {
      const b = L.latLngBounds([]);
      allLinesLayer.eachLayer((pl) => b.extend(pl.getBounds()));
      fit(b);
    }
  }

  function viewLine(view, id, dirId) {
    const line = state.lines.get(id) || [...state.lines.values()].find((l) => l.name.toLowerCase() === id.toLowerCase());
    if (!line) { view.append(h('p', { text: t('noResults') })); return; }
    const dir = line.directions.find((d) => d.id === dirId) || line.directions[0];

    view.append(h('div', { class: 'detail-head' }, backBtn(), lineChip(line, { class: 'chip lg' }),
      h('div', { class: 'title' }, h('h1', { text: `${line.from} – ${line.to}` }), h('small', { text: line.name })),
      favButton('lines', line.id), shareButton()));

    if (line.directions.length > 1) {
      view.append(h('div', { class: 'segmented', role: 'tablist' }, line.directions.map((d) => h('a', {
        href: `#/line/${line.id}?d=${d.id}`, class: d === dir ? 'active' : '', role: 'tab',
      }, `${t('towards')} ${d.to}`))));
    }
    view.append(h('p', { class: 'muted', text: `${t('stopsCount', { n: dir.stops.length })} · ${fmtDist(dir.length)}` }));

    const ol = h('ol', { class: 'timeline', style: { '--line': line.color } });
    dir.stops.forEach((sid, i) => {
      const s = state.stops.get(sid);
      const others = s.lines.filter((l) => l !== line.id).map((l) => state.lines.get(l)).filter(Boolean);
      ol.append(h('li', { class: i === 0 || i === dir.stops.length - 1 ? 'end' : '' },
        h('a', { href: `#/stop/${s.id}`, class: 'tl-stop', onmouseenter: () => stopMarkers.get(s.id)?.openTooltip(), onmouseleave: () => stopMarkers.get(s.id)?.closeTooltip() }, s.name),
        others.length ? h('span', { class: 'r-chips' }, others.map((l) => h('a', { href: `#/line/${l.id}` }, lineChip(l, { class: 'chip sm' })))) : null));
    });
    view.append(ol);

    // Map: other direction faint and dashed, selected direction bold with stop dots.
    for (const d of line.directions) {
      if (d === dir) continue;
      L.polyline(lineCoords(line, d.id), { color: line.color, weight: 3, opacity: 0.45, dashArray: '6 8' }).addTo(focusLayer);
    }
    const coords = lineCoords(line, dir.id);
    L.polyline(coords, { color: '#fff', weight: 9, opacity: 0.8 }).addTo(focusLayer);
    const pl = L.polyline(coords, { color: line.color, weight: 5, opacity: 0.95 }).addTo(focusLayer);
    dir.stops.forEach((sid, i) => {
      const s = state.stops.get(sid);
      const end = i === 0 || i === dir.stops.length - 1;
      L.circleMarker([s.lat, s.lng], { radius: end ? 7 : 4.5, weight: 2, color: line.color, fillColor: '#fff', fillOpacity: 1 })
        .bindTooltip(`${i + 1}. ${s.name}`).on('click', () => go(`/stop/${s.id}`)).addTo(focusLayer);
    });
    pin(coords[0][0], coords[0][1], 'pin-start', 'A').addTo(focusLayer);
    pin(coords[coords.length - 1][0], coords[coords.length - 1][1], 'pin-end', 'B').addTo(focusLayer);
    fit(pl.getBounds());
  }

  function viewStop(view, id) {
    const s = state.stops.get(id);
    if (!s) { view.append(h('p', { text: t('noResults') })); return; }
    view.append(h('div', { class: 'detail-head' }, backBtn(), h('span', { class: 'r-icon stop-icon big' }),
      h('div', { class: 'title' }, h('h1', { text: s.name }),
        state.userPos ? h('small', { text: t('distanceFrom', { d: fmtDist(distance(state.userPos, s)) }) }) : null),
      favButton('stops', s.id), shareButton()));
    view.append(h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => setTripPoint('f', stopPoint(s)) }, t('fromHere')),
      h('button', { class: 'btn', type: 'button', onclick: () => setTripPoint('t', stopPoint(s)) }, t('toHere')),
      h('button', { class: 'btn ghost', type: 'button', onclick: () => centerOn(s.lat, s.lng, 17) }, t('zoomToStop'))));

    const services = [];
    for (const lid of s.lines) {
      const line = state.lines.get(lid);
      for (const d of line.directions) {
        const i = d.stops.indexOf(s.id);
        if (i >= 0) services.push({ line, d, i });
      }
    }
    view.append(h('section', { class: 'section' }, h('h2', { text: t('linesAtStop') }),
      h('ul', { class: 'list' }, services.map(({ line, d, i }) => {
        const terminus = i === d.stops.length - 1;
        const next = d.stops.slice(i + 1, i + 4).map((x) => state.stops.get(x).name).join(' · ');
        return h('li', {}, h('a', { href: `#/line/${line.id}?d=${d.id}`, class: 'row' }, lineChip(line, { class: 'chip lg' }),
          h('span', { class: 'r-main' }, terminus ? `${t('terminus')}` : `${t('towards')} ${d.to}`,
            h('small', { text: terminus ? `${t('stopsCount', { n: i + 1 })}` : `${t('nextStops')}: ${next}` }))));
      }))));

    const near = nearestStops(s, 7, 400).filter((n) => n.s.id !== s.id);
    if (near.length) view.append(h('section', { class: 'section' }, h('h2', { text: t('nearbyStops') }), stopList(near)));

    // Map: serving lines faint, the stop highlighted.
    for (const { line, d } of services) {
      L.polyline(lineCoords(line, d.id), { color: line.color, weight: 4, opacity: 0.6 }).addTo(focusLayer);
    }
    for (const { s: n } of near) highlightStop(n, '#6b7280');
    highlightStop(s, '#0d6efd');
    centerOn(s.lat, s.lng, Math.max(map.getZoom(), 16));
  }

  function viewPlace(view, params) {
    const p = { lat: +params.get('lat'), lng: +params.get('lng'), name: params.get('name') || t('mapPoint'), detail: params.get('d') || '' };
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) { go('/'); return; }
    view.append(h('div', { class: 'detail-head' }, backBtn(), h('span', { class: 'r-icon place-icon big' }),
      h('div', { class: 'title' }, h('h1', { text: p.name }), p.detail ? h('small', { text: p.detail }) : null), shareButton()));
    view.append(h('div', { class: 'actions' },
      h('button', { class: 'btn', type: 'button', onclick: () => setTripPoint('f', p) }, t('fromHere')),
      h('button', { class: 'btn', type: 'button', onclick: () => setTripPoint('t', p) }, t('toHere'))));
    const near = nearestStops(p, 6, 1500);
    view.append(h('section', { class: 'section' }, h('h2', { text: t('nearbyStops') }),
      near.length ? stopList(near) : h('p', { class: 'muted', text: t('noResults') })));
    pin(p.lat, p.lng, 'pin-place', '').bindTooltip(p.name).addTo(focusLayer);
    for (const { s } of near) {
      highlightStop(s, '#0d6efd');
      L.polyline([[p.lat, p.lng], [s.lat, s.lng]], { color: '#6b7280', weight: 2, dashArray: '2 6', interactive: false }).addTo(focusLayer);
    }
    const b = L.latLngBounds([[p.lat, p.lng], ...near.slice(0, 3).map(({ s }) => [s.lat, s.lng])]);
    fit(b.pad(0.2), { maxZoom: 17 });
  }

  function viewPlan(view, params) {
    const trip = tripFromRoute(params);
    state.lastTrip = trip;
    const selected = Math.max(0, parseInt(params.get('i') || '0', 10) || 0);

    const field = (k, label) => {
      const input = h('input', { type: 'search', autocomplete: 'off', placeholder: t('searchPlaceholder'), value: trip[k]?.name || '', 'aria-label': label });
      const box = h('div', { class: 'search-results', role: 'listbox', hidden: true });
      autocomplete(input, box, ({ kind, item }) => {
        if (kind === 'line') { go(`/line/${item.id}`); return; }
        const pt = kind === 'stop' ? stopPoint(item) : { lat: item.lat, lng: item.lng, name: item.name };
        trip[k] = pt;
        go(planHref(trip));
      }, {
        lines: false,
        extra: () => [
          [[h('span', { class: 'r-icon loc-icon' }), h('span', { class: 'r-main', text: t('myLocation') })], async () => {
            const pos = state.userPos || (await locate(false));
            if (pos) { trip[k] = { lat: +pos.lat.toFixed(6), lng: +pos.lng.toFixed(6), name: t('myLocation') }; go(planHref(trip)); }
          }],
        ],
      });
      const pickBtn = h('button', {
        class: 'icon-btn', type: 'button', title: t('pickOnMap'), 'aria-label': t('pickOnMap'),
        onclick: () => { state.pick = k; document.body.classList.add('picking'); toast(t('pickHint')); },
      }, '⌖');
      const locBtn = h('button', {
        class: 'icon-btn', type: 'button', title: t('myLocation'), 'aria-label': t('myLocation'),
        onclick: async () => {
          const pos = state.userPos || (await locate(false));
          if (pos) { trip[k] = { lat: +pos.lat.toFixed(6), lng: +pos.lng.toFixed(6), name: t('myLocation') }; go(planHref(trip)); }
        },
      }, '◎');
      return h('div', { class: 'trip-field' }, h('span', { class: `dot ${k === 'f' ? 'dot-from' : 'dot-to'}`, 'aria-hidden': 'true' }),
        h('div', { class: 'search inline' }, input, box), locBtn, pickBtn);
    };

    const swap = h('button', {
      class: 'icon-btn swap', type: 'button', title: t('swap'), 'aria-label': t('swap'),
      onclick: () => go(planHref({ f: trip.t, t: trip.f })),
    }, '⇅');

    view.append(h('div', { class: 'trip-form' }, h('div', { class: 'trip-fields' }, field('f', t('from')), field('t', t('to'))), swap));

    if (trip.f) pin(trip.f.lat, trip.f.lng, 'pin-start', 'A').bindTooltip(trip.f.name).addTo(focusLayer);
    if (trip.t) pin(trip.t.lat, trip.t.lng, 'pin-end', 'B').bindTooltip(trip.t.name).addTo(focusLayer);

    if (!trip.f || !trip.t) {
      view.append(h('p', { class: 'muted', text: t('planFirst') }));
      if (state.favs.trips.length) view.append(savedTrips());
      const pt = trip.f || trip.t;
      if (pt) centerOn(pt.lat, pt.lng, Math.max(map.getZoom(), 15));
      return;
    }

    const results = h('div', { class: 'itineraries' }, h('p', { class: 'muted', text: t('planning') }));
    const tripId = `${trip.f.lat},${trip.f.lng}>${trip.t.lat},${trip.t.lng}`;
    view.append(h('div', { class: 'section-head' }, h('span', {}),
      h('span', {}, favButton('trips', { id: tripId, f: trip.f, t: trip.t, label: `${trip.f.name} → ${trip.t.name}` }), shareButton())));
    view.append(results);

    const key = planHref({ f: trip.f, t: trip.t }) + state.lang;
    const load = state.planCache.get(key) || api(`/api/plan?from=${trip.f.lat},${trip.f.lng}&to=${trip.t.lat},${trip.t.lng}&fromName=${encodeURIComponent(trip.f.name)}&toName=${encodeURIComponent(trip.t.name)}`);
    state.planCache.set(key, load);
    load.then((data) => {
      if (currentRoute().path !== '/plan' || !results.isConnected) return;
      renderItineraries(results, data.itineraries, trip, selected);
    }).catch(() => {
      state.planCache.delete(key);
      results.replaceChildren(h('p', { class: 'error', text: navigator.onLine ? t('serverError') : t('offline') }));
    });
  }

  function renderItineraries(box, its, trip, selected) {
    box.replaceChildren();
    if (!its.length) { box.append(h('p', { class: 'muted', text: t('noItinerary') })); return; }
    const sel = Math.min(selected, its.length - 1);
    its.forEach((it, i) => {
      const buses = it.legs.filter((l) => l.type === 'bus');
      const summary = h('div', { class: 'it-summary' },
        h('strong', { class: 'it-time', text: fmtDur(it.duration) }),
        h('span', { class: 'it-legs' }, it.legs.map((l, j) => [
          j ? h('span', { class: 'sep', text: '›' }) : null,
          l.type === 'walk' ? h('span', { class: 'walk-icon', title: t('walk') }, '🚶') : lineChip(l.line, { class: 'chip sm' }),
        ])),
        h('small', { text: [buses.length ? (it.transfers ? t('transfers', { n: it.transfers }) : t('direct')) : t('walkOnly'), t('totalWalk', { n: fmtDist(it.walkDistance) })].join(' · ') }));
      const card = h('a', { class: `it-card${i === sel ? ' active' : ''}`, href: `#${planHref(trip, i)}` }, summary);
      if (i === sel) card.append(itinerarySteps(it));
      box.append(card);
    });
    box.append(h('p', { class: 'muted small', text: t('estimateNote') }));
    drawItinerary(its[sel], trip);
  }

  function itinerarySteps(it) {
    return h('ol', { class: 'steps' }, it.legs.map((l) => {
      if (l.type === 'walk') {
        return h('li', { class: 'step walk' }, h('span', { class: 'step-icon' }, '🚶'),
          h('div', {}, t('walkTo', { name: l.to.name }), h('small', { text: `${fmtDist(l.distance)} · ${fmtDur(l.duration)}` })));
      }
      const line = state.lines.get(l.line.id) || l.line;
      return h('li', { class: 'step bus', style: { '--line': line.color } }, lineChip(line, { class: 'chip' }),
        h('div', {},
          h('div', {}, t('take', { line: line.name }), ' ', h('b', { text: `${t('towards')} ${l.headsign}` })),
          h('small', { text: `${l.from.name} → ${l.to.name}` }),
          h('small', { text: `${t('ride', { n: l.stops.length - 1, t: fmtDur(l.duration) })} · ${t('wait', { n: Math.round(l.wait / 60) })}` }),
          h('details', {}, h('summary', { text: t('stopsCount', { n: l.stops.length }) }),
            h('ol', { class: 'mini-stops' }, l.stops.map((s) => h('li', {}, h('a', { href: `#/stop/${s.id}`, text: s.name })))))));
    }));
  }

  function drawItinerary(it, trip) {
    const b = L.latLngBounds([[trip.f.lat, trip.f.lng], [trip.t.lat, trip.t.lng]]);
    for (const l of it.legs) {
      if (l.type === 'walk') {
        L.polyline([[l.from.lat, l.from.lng], [l.to.lat, l.to.lng]], { color: '#4b5563', weight: 4, dashArray: '1 8', lineCap: 'round' }).addTo(focusLayer);
      } else {
        const coords = l.stops.map((s) => [s.lat, s.lng]);
        const color = (state.lines.get(l.line.id) || l.line).color;
        L.polyline(coords, { color: '#fff', weight: 9, opacity: 0.8 }).addTo(focusLayer);
        L.polyline(coords, { color, weight: 6 }).addTo(focusLayer);
        l.stops.forEach((s, i) => {
          const end = i === 0 || i === l.stops.length - 1;
          L.circleMarker([s.lat, s.lng], { radius: end ? 6 : 3.5, color, weight: 2, fillColor: '#fff', fillOpacity: 1 }).bindTooltip(s.name).addTo(focusLayer);
        });
        coords.forEach((c) => b.extend(c));
      }
    }
    fit(b);
  }

  function savedTrips() {
    return h('section', { class: 'section' }, h('h2', { text: t('savedTrips') }),
      h('ul', { class: 'list' }, state.favs.trips.map((tr) => h('li', {}, h('a', { class: 'row', href: `#${planHref({ f: tr.f, t: tr.t })}` },
        h('span', { class: 'r-icon trip-icon' }), h('span', { class: 'r-main', text: tr.label }))))));
  }

  function viewFavs(view) {
    const { stops, lines, trips } = state.favs;
    if (!stops.length && !lines.length && !trips.length) {
      view.append(h('p', { class: 'muted', text: t('noFavs') }));
      return;
    }
    if (stops.length) {
      const list = stops.map((id) => state.stops.get(id)).filter(Boolean).map((s) => ({ s, d: state.userPos ? distance(state.userPos, s) : undefined }));
      view.append(h('section', { class: 'section' }, h('h2', { text: t('stops') }), stopList(list)));
      for (const { s } of list) highlightStop(s, '#f59e0b');
    }
    if (lines.length) {
      view.append(h('section', { class: 'section' }, h('h2', { text: t('lines') }),
        h('ul', { class: 'list' }, lines.map((id) => state.lines.get(id)).filter(Boolean).map((l) => h('li', {},
          h('a', { href: `#/line/${l.id}`, class: 'row' }, lineChip(l, { class: 'chip lg' }), h('span', { class: 'r-main', text: `${l.from} ⇄ ${l.to}` })))))));
    }
    if (trips.length) view.append(savedTrips());
  }

  // ---------- chrome: language, theme, offline, install, mobile sheet ----------
  function applyLang() {
    document.documentElement.lang = state.lang;
    document.documentElement.dir = state.lang === 'ar' ? 'rtl' : 'ltr';
    document.title = t('appName');
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => { el.placeholder = t(el.dataset.i18nPlaceholder); });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => { el.title = t(el.dataset.i18nTitle); el.setAttribute('aria-label', el.title); });
    $('#langSelect').value = state.lang;
  }
  function applyTheme() {
    document.documentElement.dataset.theme = state.theme;
    document.querySelector('meta[name=theme-color]').content = state.theme === 'dark' ? '#111827' : '#0d6efd';
  }
  function initChrome() {
    $('#langSelect').addEventListener('change', (e) => { state.lang = e.target.value; LS.set('lang', state.lang); applyLang(); render(); });
    $('#themeBtn').addEventListener('click', () => { state.theme = state.theme === 'dark' ? 'light' : 'dark'; LS.set('theme', state.theme); applyTheme(); });
    const online = () => { $('#offlineBanner').hidden = navigator.onLine; };
    addEventListener('online', online); addEventListener('offline', online); online();

    let deferred;
    addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferred = e; $('#installBtn').hidden = false; });
    $('#installBtn').addEventListener('click', async () => { if (!deferred) return; deferred.prompt(); await deferred.userChoice; deferred = null; $('#installBtn').hidden = true; });

    const panel = $('#panel');
    $('#panelHandle').addEventListener('click', () => panel.classList.toggle('collapsed'));
    $('#searchInput').addEventListener('focus', () => panel.classList.remove('collapsed'));

    if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }

  // ---------- boot ----------
  async function boot() {
    applyTheme();
    applyLang();
    try {
      const [meta, net] = await Promise.all([api('/api/meta'), api('/api/network')]);
      state.meta = meta;
      for (const s of net.stops) state.stops.set(s.id, s);
      for (const l of net.lines) state.lines.set(l.id, l);
    } catch (e) {
      $('#view').replaceChildren(h('p', { class: 'error', text: t('serverError') }));
      return;
    }
    // Drop saved items that no longer exist in the data.
    state.favs.stops = state.favs.stops.filter((id) => state.stops.has(id));
    state.favs.lines = state.favs.lines.filter((id) => state.lines.has(id));
    initMap();
    initSearch();
    initChrome();
    addEventListener('hashchange', render);
    render();
  }

  boot();
})();

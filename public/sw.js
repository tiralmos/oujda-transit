'use strict';
/* Service worker: app shell and network data work offline; map tiles are cached as you browse. */
const SHELL = 'ot-shell-v1';
const DATA = 'ot-data-v1';
const TILES = 'ot-tiles-v1';
const MAX_TILES = 1500;

const SHELL_FILES = [
  '/', '/index.html', '/styles.css', '/app.js', '/i18n.js', '/icon.svg', '/manifest.webmanifest',
  '/vendor/leaflet/leaflet.js', '/vendor/leaflet/leaflet.css',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  const keep = [SHELL, DATA, TILES];
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

async function trimTiles() {
  const cache = await caches.open(TILES);
  const keys = await cache.keys();
  for (let i = 0; i < keys.length - MAX_TILES; i++) await cache.delete(keys[i]);
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreSearch: false });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (/tile\.openstreetmap\.org$/.test(url.hostname)) {
    e.respondWith(caches.open(TILES).then(async (cache) => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok || res.type === 'opaque') { cache.put(req, res.clone()); trimTiles(); }
      return res;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (url.pathname === '/api/network' || url.pathname === '/api/meta') {
    e.respondWith(networkFirst(req, DATA));
    return;
  }
  if (url.pathname.startsWith('/api/') || url.pathname === '/healthz') return; // live only

  // App shell: network first so updates show up, cache as fallback; SPA routes get index.html.
  e.respondWith(networkFirst(req, SHELL).catch(() => caches.match('/index.html')));
});

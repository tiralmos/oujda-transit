// Offline support: every same-origin request goes to the network first and
// falls back to the last cached copy, so the app never shows stale data while
// online but still opens without a connection. Map tiles are not cached here.
//
// Network requests ask the server to revalidate ("no-cache"), so a browser
// cache that a proxy such as Cloudflare told to keep files for hours can't
// serve an old version.

// Replaced with a content hash when the Docker image is built (tools/stamp_assets.py).
const VERSION = 'dev';
const CACHE = `oujda-transit-${VERSION}`;
const SHELL = [
  './',
  'index.html',
  'config.js',
  'css/app.css',
  'js/app.js',
  'js/geo.js',
  'js/geocode.js',
  'js/i18n.js',
  'js/planner.js',
  'js/store.js',
  'js/text.js',
  'js/theme-init.js',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/leaflet.js',
  'data/network.json',
  'icons/icon.svg',
  'manifest.webmanifest',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((c) => c.addAll(SHELL.map((url) => new Request(url, { cache: 'no-cache' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.includes('/api/')) return;
  event.respondWith(
    fetch(req.url, { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || Promise.reject(new Error('offline')))),
  );
});

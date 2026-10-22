// Offline support: every same-origin request goes to the network first and
// falls back to the last cached copy, so the app never shows stale data while
// online but still opens without a connection. Map tiles are not cached here.

const CACHE = 'oujda-transit-v1';
const SHELL = [
  './',
  'index.html',
  'config.js',
  'css/app.css',
  'js/app.js',
  'js/geo.js',
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
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
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
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
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

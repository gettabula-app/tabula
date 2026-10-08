// Driftboard service worker: makes the app and everything a board needs
// available offline after the first visit.
//  - App shell (same origin): network first for pages, cache first for hashed assets.
//  - Fontshare CSS and font files, Iconify data and previews: stale-while-revalidate.
//    Font files are cached on this device only; they are never re-served elsewhere.
const VERSION = 'driftboard-v2';
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;
const THIRD_PARTY = /^(https:\/\/(api|cdn)\.fontshare\.com|https:\/\/api\.(iconify\.design|simplesvg\.com|unisvg\.com))\//;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/favicon.svg', '/manifest.webmanifest'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/sync') || url.pathname.startsWith('/api/')) return;
    if (req.mode === 'navigate') {
      event.respondWith(
        fetch(req)
          .then((res) => {
            const copy = res.clone();
            caches.open(SHELL).then((c) => c.put('/', copy));
            return res;
          })
          .catch(() => caches.match('/')),
      );
      return;
    }
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(SHELL).then((c) => c.put(req, copy));
        }
        return res;
      })),
    );
    return;
  }

  if (THIRD_PARTY.test(req.url)) {
    event.respondWith(
      caches.open(RUNTIME).then(async (cache) => {
        const hit = await cache.match(req);
        const net = fetch(req).then((res) => {
          if (res.ok || res.type === 'opaque') cache.put(req, res.clone());
          return res;
        }).catch(() => hit || Response.error());
        return hit || net;
      }),
    );
  }
});

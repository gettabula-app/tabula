// Tabula service worker: makes the app and everything a board needs
// available offline after the first visit.
//  - App shell (same origin): network first for pages, cache first for hashed assets.
//  - Fontshare CSS and font files, Iconify data and previews: stale-while-revalidate.
//    Font files are cached on this device only; they are never re-served elsewhere.
//  - Our own icon sets (/icons/): the manifest and the licence list network first, every hashed file cache first
//    into ICONS, which outlives app versions (a new VERSION must not drop megabytes of downloaded icons).
const VERSION = 'tabula-v2';
const SHELL = `${VERSION}-shell`;
const RUNTIME = `${VERSION}-runtime`;
const ICONS = 'tabula-icons-v1';
const THIRD_PARTY = /^(https:\/\/(api|cdn)\.fontshare\.com|https:\/\/api\.(iconify\.design|simplesvg\.com|unisvg\.com))\//;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(['/', '/favicon.svg', '/manifest.webmanifest'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION) && k !== ICONS).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Only a 200 JSON (or the licence text) is stored: a 404 or an HTML page must never be kept as an icon file.
const isJson = (res) => res.status === 200 && /json|text\/plain/.test(res.headers.get('content-type') || '');

// The relay sends Vary: Accept-Encoding, which a stored request may not carry the same way, so every match ignores Vary.
async function iconsCacheFirst(req) {
  const cache = await caches.open(ICONS);
  const hit = await cache.match(req, { ignoreVary: true });
  if (hit) return hit;
  const res = await fetch(req);
  if (isJson(res)) await cache.put(req, res.clone());
  return res;
}

async function iconsNetworkFirst(req) {
  const cache = await caches.open(ICONS);
  try {
    const res = await fetch(req);
    if (isJson(res)) await cache.put(req, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(req, { ignoreVary: true });
    if (hit) return hit;
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    if (url.pathname.startsWith('/sync') || url.pathname.startsWith('/api/')) return;
    // The user guide is static pages outside the app: the navigate handler below would cache every navigation as the app shell '/'.
    if (url.pathname === '/docs' || url.pathname.startsWith('/docs/')) return;
    // The landing-page demo may share this origin, but has its own cache and must never be captured by the app worker.
    if (url.pathname.startsWith('/demo/')) return;
    if (url.pathname.startsWith('/icons/')) {
      const first = url.pathname === '/icons/manifest.json' || url.pathname === '/icons/LICENSES.txt';
      event.respondWith(first ? iconsNetworkFirst(req) : iconsCacheFirst(req));
      return;
    }
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

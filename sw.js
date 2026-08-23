/* VMG Personal Financial Manager — service worker
   Caches the app shell so it opens instantly and works fully offline.
   The HTML document itself is always fetched network-first (falling
   back to cache only when offline), so a redeployed index.html is
   picked up on the very next load — no stale-cache lag. Other static
   assets (manifest, icons) use cache-first since they rarely change.
   Google Drive / Google sign-in requests always go straight to the
   network (never cached) since they carry live sync data and auth
   tokens. Bump CACHE_NAME whenever the asset list itself changes. */
const CACHE_NAME = 'vmg-pfm-v2';
const ASSETS = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then((c) => c.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = e.request.url;
  if (e.request.method !== 'GET') return;
  // Never intercept Google sign-in / Drive API calls — always live network.
  if (url.startsWith('https://www.googleapis.com') || url.startsWith('https://accounts.google.com')) return;

  // The app document itself: network-first, so redeployed updates are
  // picked up immediately. Falls back to the cached copy only when
  // there's no network (true offline use).
  if (e.request.mode === 'navigate' || e.request.destination === 'document') {
    e.respondWith(
      fetch(e.request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
          }
          return resp;
        })
        .catch(() => caches.match(e.request).then((cached) => cached || caches.match('./index.html')))
    );
    return;
  }

  // Everything else (manifest, icons): cache-first, refresh in background.
  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request)
        .then((resp) => {
          if (resp && resp.status === 200) {
            const clone = resp.clone();
            caches.open(CACHE_NAME).then((c) => c.put(e.request, clone));
          }
          return resp;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
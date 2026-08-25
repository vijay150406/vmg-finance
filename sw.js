/* VMG Personal Financial Manager — service worker
   Caches the app shell so it opens instantly and works fully offline.
   Google Drive / Google sign-in requests are always passed straight
   through to the network (never cached) since they carry live sync
   data and auth tokens. Bump CACHE_NAME whenever you redeploy the
   app so returning devices pick up the new version. */
const CACHE_NAME = 'vmg-pfm-v22';
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
      // Stale-while-revalidate: show cached instantly if we have it, refresh in background.
      return cached || network;
    })
  );
});

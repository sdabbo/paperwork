// Paperwork's service worker. Its one job: receive files shared to the installed app from other apps
// (manifest "share_target"), park them in a cache and open the app, which uploads them (src/lib/shared.ts).
// It caches nothing else; every page needs the server for its data anyway.

const CACHE = 'paperwork-shared';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'POST' || url.origin !== self.location.origin || url.pathname !== '/share-target') return;
  event.respondWith(
    (async () => {
      try {
        const form = await event.request.formData();
        const cache = await caches.open(CACHE);
        let n = 0;
        for (const value of form.getAll('files')) {
          if (!(value instanceof File)) continue;
          await cache.put(
            new Request(`/shared/${Date.now()}-${n++}`),
            new Response(value, {
              headers: { 'content-type': value.type || 'application/octet-stream', 'x-file-name': encodeURIComponent(value.name || 'Shared file') },
            })
          );
        }
      } catch (err) {
        console.warn('Receiving shared files failed:', err);
      }
      return Response.redirect('/?shared=1', 303);
    })()
  );
});

// Service worker: keeps India's boundary files (data/india/) in the browser, so repeat visits load them without
// the network. The files the map needs at startup are cached when the worker installs (the page registers it
// after loading them, so this costs a revalidation, not a download); each state's sub-districts the first time
// they load.
// Everything else (the app's code, MapLibre, fonts) goes to the network as usual.
//
// VERSION names the cache. `npm run build:boundaries` (in maps/) rewrites it when it regenerates the files, so
// browsers drop the old copies and fetch the new ones once.
const VERSION = 'boundaries-2024-lgd';
const DATA = new URL('data/india/', self.registration.scope).href;
const STARTUP = ['country.geojson', 'states.geojson', 'districts.geojson', 'regions.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(VERSION);
      // no-cache: check with the server, so the copies the page just downloaded come back as a cheap "not
      // modified", and a new VERSION never stores files left in the HTTP cache from before the rebuild
      await cache.addAll(STARTUP.map((f) => new Request(DATA + f, { cache: 'no-cache' })));
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== VERSION) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || !request.url.startsWith(DATA)) return;
  event.respondWith(
    (async () => {
      const cache = await caches.open(VERSION);
      const hit = await cache.match(request, { ignoreSearch: true });
      if (hit) return hit;
      const res = await fetch(request);
      if (res.ok) await cache.put(request, res.clone());
      return res;
    })(),
  );
});

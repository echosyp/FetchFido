/**
 * Service worker -- makes the app usable with no connectivity.
 *
 * The success criterion for Phase 1 is tracking a node with the phone in
 * airplane mode, which requires the shell to be cached rather than fetched.
 *
 * Two strategies:
 *   - App shell: cache-first. It only changes when we deploy.
 *   - Map tiles: network-first, falling back to cache. Tiles are opaque
 *     cross-origin responses, so they cannot be inspected -- only replayed.
 *
 * Tiles are cached opportunistically as you pan. Pre-caching a chosen region
 * ahead of a trip is a later deliverable; until then the app must not imply
 * an area is available offline when it has not been visited.
 */

const SHELL = 'fetchfido-shell-v17';
const TILES = 'fetchfido-tiles-v1';

const SHELL_FILES = [
  './',
  './index.html',
  './manifest.webmanifest',
  './favicon.svg',
  './css/app.css',
  './vendor/leaflet.css',
  './vendor/leaflet.js',
  './js/app.js',
  './js/map.js',
  './js/store.js',
  './js/geo.js',
  './js/meshtastic.js',
  './js/protobuf.js',
  './js/framing.js',
  './js/heading.js',
  './js/sources/base.js',
  './js/sources/serial.js',
  './js/sources/ble.js',
  './js/sources/wifi.js',
  './js/sources/types.js',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== SHELL && k !== TILES).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  if (url.hostname === 'tile.openstreetmap.org') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(TILES).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || Response.error()))
    );
    return;
  }

  if (url.origin === self.location.origin) {
    // Stale-while-revalidate: serve the cache immediately so the app still
    // opens with no network, but always refetch in the background so the next
    // load is current. Pure cache-first meant a code change could not reach a
    // browser at all without manually unregistering the worker -- which cost
    // real debugging time and looked exactly like an application bug.
    event.respondWith(
      caches.open(SHELL).then((cache) =>
        cache.match(req).then((hit) => {
          const fresh = fetch(req)
            .then((res) => {
              if (res && res.ok) cache.put(req, res.clone());
              return res;
            })
            .catch(() => hit);
          return hit || fresh;
        })
      )
    );
  }
});

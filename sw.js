const CACHE_NAME = 'mantiq-cache-v2';

// List all the files your game needs to run
const urlsToCache = [
  './',
  './index.html',
  './index.js',
  './index.wasm',
  './index.data',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// 1. When the service worker installs, cache all the files
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => {
        console.log('Opened cache, saving game assets...');
        return cache.addAll(urlsToCache);
      })
  );
});

// 2. Intercept network requests and return the cached files if available
self.addEventListener('fetch', event => {
  event.respondWith(
    caches.match(event.request)
      .then(response => {
        // If the file is in the cache, return it! (Offline mode)
        if (response) {
          return response;
        }
        // Otherwise, try to fetch it from the internet
        return fetch(event.request);
      })
  );
});

const CACHE_NAME = 'tensms-v1';
const urlsToCache = [
  '/',
  '/index.html',
  '/manifest.json'
];

// Install App
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => {
        return cache.addAll(urlsToCache);
      })
  );
});

// Fetch (Network First Strategy - Taaki Balance purana na dikhe)
self.addEventListener('fetch', (event) => {
  event.respondWith(
    fetch(event.request).catch(() => {
      return caches.match(event.request);
    })
  );
});

// Cache-first service worker: after the first visit the app works fully
// offline. Bump CACHE_VERSION when any app file changes.
const CACHE_VERSION = 'film-mobile-v16';

const ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './pipeline.js',
    './tiff.js',
    './webgl-renderer.js',
    './browse.js',
    './vendor/UTIF.js',
    './manifest.webmanifest',
    './icons/icon-192.png',
    './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
    e.waitUntil(
        caches.open(CACHE_VERSION).then(cache => cache.addAll(ASSETS))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    e.respondWith(
        caches.match(e.request).then(cached => cached || fetch(e.request))
    );
});


// Cache-first service worker: after the first visit the app works fully
// offline. Bump CACHE_VERSION when any app file changes.
//
// Updates are ATOMIC: fetches only ever come from THIS version's cache,
// and a freshly installed version waits until the app is fully closed
// before taking over (no skipWaiting/claim). A page can therefore never
// end up with half old / half new files - which used to break the app
// mid-update when the old HTML met a newer script.
// Keep in step with APP_VERSION in app.js (shown on the start screen)
const CACHE_VERSION = 'film-mobile-v39';

const ASSETS = [
    './',
    './index.html',
    './style.css',
    './app.js',
    './pipeline.js',
    './tiff.js',
    './webgl-renderer.js',
    './autocrop.js',
    './batch.js',
    './browse.js',
    './vendor/UTIF.js',
    './manifest.webmanifest',
    './icons/icon-192.png',
    './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
    // cache: 'reload' bypasses the HTTP cache. GitHub Pages serves with
    // max-age=600, so a plain addAll could freeze a 10-minutes-stale
    // index.html together with fresh scripts into one version - a mix
    // that crashed the app until the next version shipped.
    e.waitUntil(caches.open(CACHE_VERSION).then(cache =>
        cache.addAll(ASSETS.map(u => new Request(u, { cache: 'reload' })))));
});

// Runs only once every page from the previous version is closed, so
// deleting the old caches can't yank files from under a live page
self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))
        )
    );
});

self.addEventListener('fetch', (e) => {
    e.respondWith(
        caches.open(CACHE_VERSION)
            .then(cache => cache.match(e.request))
            .then(cached => cached || fetch(e.request))
    );
});

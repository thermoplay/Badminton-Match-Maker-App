const CACHE_NAME = 'courtside-pro-v2'; // Change version to force update
const URLS_TO_CACHE = [
    '/',
    '/index.html',
    '/css/style.css',
    '/js/state-store.js',
    '/js/polish.js',
    '/js/ui-manager.js',
    '/js/app.js',
    '/js/logic.js',
    '/js/sync.js',
    '/js/player-view.js',
    '/js/passport.js',
    '/js/share-card.js',
    '/js/timer.js',
    '/js/achievements.js',
    '/icons/icon-192.png',
    '/icons/icon-512.png',
    '/manifest.json',
    'https://fonts.googleapis.com/css2?family=Barlow+Condensed:ital,wght@0,400;0,700;0,800;0,900;1,800;1,900&family=DM+Sans:wght@400;500;600;700&display=swap',
    'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
    'https://cdn.jsdelivr.net/npm/qrcode@1.5.1/build/qrcode.min.js'
];

// Install event: cache the app shell
self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('[SW] Opened cache');
                return cache.addAll(URLS_TO_CACHE);
            })
    );
});

// Activate event: clean up old caches
self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        console.log('[SW] Deleting old cache:', cacheName);
                        return caches.delete(cacheName);
                    }
                })
            );
        })
    );
    return self.clients.claim();
});

// Fetch event: serve from cache or network
self.addEventListener('fetch', event => {
    const url = new URL(event.request.url);

    // For API calls, use a network-first strategy.
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(event.request).catch(() => caches.match(event.request))
        );
        return;
    }

    // For all other requests (app shell, fonts, etc.), use a cache-first strategy.
    event.respondWith(
        caches.match(event.request)
            .then(response => {
                // Cache hit - return response
                if (response) {
                    return response;
                }
                // Not in cache - fetch from network
                return fetch(event.request);
            })
    );
});
const CACHE = 'intelio-pwa-30';
const FILES = ['/', '/index.html', '/app.css', '/app.js', '/bops.js', '/transcript.js', '/thinking-orbs.js', '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png', '/desktop/', '/desktop-boot.js', '/desktop-transport.js'];

function shellPath(pathname) {
  return pathname === '/' || pathname === '/index.html' || pathname === '/app.js' || pathname === '/app.css' || pathname === '/sw.js' || pathname === '/transcript.js' || pathname === '/desktop' || pathname === '/desktop/' || pathname === '/desktop-boot.js' || pathname === '/desktop-transport.js' || pathname.startsWith('/ui/');
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)));
    await self.clients.claim();
    const pages = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const page of pages) page.postMessage({ type: 'intelio-pwa-update' });
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api') || url.pathname.startsWith('/session')) return;
  if (event.request.method !== 'GET') return;
  if (shellPath(url.pathname)) {
    event.respondWith((async () => {
      const cache = await caches.open(CACHE);
      try {
        const fresh = await fetch(event.request);
        if (fresh && fresh.ok) cache.put(event.request, fresh.clone());
        return fresh;
      } catch (error) {
        const hit = await cache.match(event.request) || await caches.match(event.request);
        if (hit) return hit;
        throw error;
      }
    })());
    return;
  }
  event.respondWith(caches.match(event.request).then((hit) => hit || fetch(event.request)));
});

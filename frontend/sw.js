const CACHE = 'dispatch-v1';
const SHELL = [
  '/',
  '/manifest.webmanifest',
  '/api/airport',
  // при необходимости добавь сюда свои /static/*.css и /static/*.js
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;               // POST/PUT не кэшируем
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;     // внешние ресурсы мимо

  // API — network-first, кэш как fallback
  if (url.pathname.startsWith('/api/')) {
    e.respondWith(
      fetch(req).then(r => {
        const clone = r.clone();
        caches.open(CACHE).then(c => c.put(req, clone));
        return r;
      }).catch(() => caches.match(req).then(hit => hit || Response.error()))
    );
    return;
  }

  // Всё остальное — cache-first
  e.respondWith(
    caches.match(req).then(hit => hit || fetch(req).then(r => {
      if (r.ok) caches.open(CACHE).then(c => c.put(req, r.clone()));
      return r;
    }))
  );
});

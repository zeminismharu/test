// 홈 화면 앱용 서비스 워커: 화면 파일은 늘 새로 받고(안 되면 저장본), 사진은 저장본을 먼저 씁니다. API 는 건드리지 않음.
const CACHE = 'reference-v1';
const SHELL = ['/', '/style.css', '/app.js', '/common.js', '/favicon.svg', '/icon-192.png'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (url.pathname.startsWith('/img/')) {
    // 사진은 이름이 바뀌지 않으므로 저장본 먼저
    e.respondWith(caches.open(CACHE).then(async (c) => (await c.match(req)) || fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; })));
    return;
  }
  e.respondWith(fetch(req).then((r) => {
    if (r.ok) caches.open(CACHE).then((c) => c.put(req, r.clone()));
    return r;
  }).catch(async () => (await caches.match(req)) || (await caches.match('/'))));
});

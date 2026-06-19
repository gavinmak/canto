const SHELL_V = 'canto-static-fcb93bc5';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest',
  'static/app.css?v=fcb93bc5', 'static/tones.js?v=fcb93bc5', 'static/dict.js?v=fcb93bc5', 'static/study.js?v=fcb93bc5',
  'static/apple-touch-icon.png', 'static/icon-192.png', 'static/icon-512.png',
  'data/sources.json',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(SHELL_V)
    .then((c) => Promise.allSettled(SHELL.map((u) => c.add(u))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys
      .filter((k) => k.startsWith('canto-static-') && k !== SHELL_V)
      .map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const path = new URL(req.url).pathname;

  // Downloaded deck assets: audio/screenshots and the per-word define responses
  // study.js wrote into the caches. Cache-first — never re-hit the network.
  if (path.includes('/media/') || path.includes('/api/define')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req)));
    return;
  }

  // App shell: network-first, fall back to cache; offline navigations land on
  // the app itself.
  e.respondWith(
    fetch(req).then((res) => {
      if (res && res.ok) {
        const copy = res.clone();
        caches.open(SHELL_V).then((c) => c.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(() => caches.match(req).then((hit) =>
      hit || (req.mode === 'navigate' ? caches.match('index.html') : Response.error()))));
});

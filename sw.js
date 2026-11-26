// 앱 화면 파일을 폰에 저장해 인터넷 없이도 열리게 한다. (시세는 항상 업비트에서 새로 받음)
const CACHE = 'pricezone-v2.5.2';
const FILES = ['./', 'index.html', 'style.css', 'zones.js', 'sources.js', 'nq.js', 'nqui.js', 'scan.js', 'scanui.js', 'ai.js', 'app.js', 'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k.startsWith('pricezone-') && k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
// 같은 주소의 앱 파일만: 인터넷이 되면 새 버전(폰 캐시 건너뜀), 안 되면 저장된 화면
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== location.origin) return;
  e.respondWith(
    fetch(e.request, { cache: 'no-cache' })
      .then((r) => { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return r; })
      .catch(() => caches.match(e.request, { ignoreSearch: true }).then((r) => r || caches.match('index.html')))
  );
});

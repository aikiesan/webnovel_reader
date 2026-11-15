// Offline support. App files: network first (so updates show up right away),
// falling back to the cache when offline. Big vendor files and the voice
// engine's WASM: cache first. The voice model itself is cached by
// transformers.js in its own cache.
const CACHE = 'reader-v10';
const SHELL = ['./', 'index.html', 'style.css', 'app.js', 'tape.js', 'epub.js', 'tts-worker.js', 'grab.js', 'grab.min.js', 'vendor/jszip.min.js', 'vendor/kokoro.web.js', 'vendor/fonts/instrument-sans-latin.woff2', 'vendor/fonts/young-serif-latin.woff2', 'manifest.webmanifest', 'icon.svg', 'icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const sameOrigin = url.origin === location.origin;
  const ortWasm = url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('@huggingface/transformers');
  if (!sameOrigin && !ortWasm) return;
  const cacheFirst = ortWasm || url.pathname.includes('/vendor/');
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(e.request, { ignoreSearch: sameOrigin });
    const net = fetch(e.request).then((r) => { if (r.ok) c.put(e.request, r.clone()); return r; });
    if (cacheFirst && hit) return hit;
    try {
      return await Promise.race([net, new Promise((_, rej) => setTimeout(() => rej(new Error('slow')), hit ? 4000 : 60000))]);
    } catch { return hit || net; }
  }));
});

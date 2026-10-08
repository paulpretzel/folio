// Folio service worker: makes the app work offline and receives PDFs shared from other apps.
const VERSION = 'folio-v2';
const SHARE_CACHE = 'folio-share';       // PDFs waiting to be imported; never cleaned up by activate
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/ui.js',
  'js/settings.js',
  'js/pdf.js',
  'js/db.js',
  'js/identify.js',
  'js/library.js',
  'js/reader.js',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION && k !== SHARE_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// "Share → Folio" from Android's share sheet POSTs the PDFs here (see share_target in the manifest).
// Stash them and reload the app, which imports and identifies them like any other new book.
async function receiveShare(req) {
  const home = new URL('./', self.registration.scope);
  try {
    const form = await req.formData();
    const files = form.getAll('pdfs').filter((f) => f && typeof f !== 'string' && (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)));
    const cache = await caches.open(SHARE_CACHE);
    const stamp = Date.now();
    await Promise.all(files.map((f, i) => cache.put(
      new URL(`shared/${stamp}-${i}`, home).href,
      new Response(f, { headers: { 'Content-Type': 'application/pdf', 'X-Filename': encodeURIComponent(f.name || 'shared.pdf') } })
    )));
    return Response.redirect(new URL(`./?shared=${files.length}`, home).href, 303);
  } catch (e) {
    return Response.redirect(home.href, 303);
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (req.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(receiveShare(req));
    return;
  }
  if (req.method !== 'GET') return;
  event.respondWith((async () => {
    const cache = await caches.open(VERSION);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      // Cache fonts/cmaps (and anything else same-origin) on first use
      if (res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      if (req.mode === 'navigate') {
        const shell = await cache.match('index.html');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

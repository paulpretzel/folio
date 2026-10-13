// Folio service worker: makes the app work offline and receives books shared from other apps.
const VERSION = 'folio-v11';
const SHARE_CACHE = 'folio-share';       // PDFs waiting to be imported; never cleaned up by activate
const SHELL = [
  './',
  'index.html',
  'css/app.css',
  'js/app.js',
  'js/ui.js',
  'js/privacy.js',
  'js/settings.js',
  'js/pdf.js',
  'js/db.js',
  'js/identify.js',
  'js/library.js',
  'js/reader.js',
  'js/tour.js',
  'js/formats.js',
  'js/flow.js',
  'js/fonts.js',
  'js/store.js',
  'js/addbooks.js',
  'samples/welcome-to-folio.pdf',
  'manifest.webmanifest',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'vendor/pdfjs/pdf.min.mjs',
  'vendor/pdfjs/pdf.worker.min.mjs',
  // the text reader (EPUB, Kindle, FB2, comics) and the Word converter, so they open offline too
  'vendor/foliate/view.js',
  'vendor/foliate/epub.js',
  'vendor/foliate/epubcfi.js',
  'vendor/foliate/paginator.js',
  'vendor/foliate/fixed-layout.js',
  'vendor/foliate/mobi.js',
  'vendor/foliate/fb2.js',
  'vendor/foliate/comic-book.js',
  'vendor/foliate/progress.js',
  'vendor/foliate/overlayer.js',
  'vendor/foliate/text-walker.js',
  'vendor/foliate/search.js',
  'vendor/foliate/vendor/zip.js',
  'vendor/foliate/vendor/fflate.js',
  'vendor/mammoth/mammoth.browser.min.js',
  // Reading fonts (see js/fonts.js)
  'vendor/fonts/arimo/arimo-latin-400-normal.woff2',
  'vendor/fonts/arimo/arimo-latin-400-italic.woff2',
  'vendor/fonts/arimo/arimo-latin-700-normal.woff2',
  'vendor/fonts/arimo/arimo-latin-700-italic.woff2',
  'vendor/fonts/arimo/arimo-latin-ext-400-normal.woff2',
  'vendor/fonts/arimo/arimo-latin-ext-400-italic.woff2',
  'vendor/fonts/arimo/arimo-latin-ext-700-normal.woff2',
  'vendor/fonts/arimo/arimo-latin-ext-700-italic.woff2',
  'vendor/fonts/arimo/arimo-cyrillic-400-normal.woff2',
  'vendor/fonts/arimo/arimo-cyrillic-400-italic.woff2',
  'vendor/fonts/arimo/arimo-cyrillic-700-normal.woff2',
  'vendor/fonts/arimo/arimo-cyrillic-700-italic.woff2',
  'vendor/fonts/arimo/arimo-greek-400-normal.woff2',
  'vendor/fonts/arimo/arimo-greek-400-italic.woff2',
  'vendor/fonts/arimo/arimo-greek-700-normal.woff2',
  'vendor/fonts/arimo/arimo-greek-700-italic.woff2',
  'vendor/fonts/arimo/arimo-hebrew-400-normal.woff2',
  'vendor/fonts/arimo/arimo-hebrew-400-italic.woff2',
  'vendor/fonts/arimo/arimo-hebrew-700-normal.woff2',
  'vendor/fonts/arimo/arimo-hebrew-700-italic.woff2',
  'vendor/fonts/arimo/arimo-vietnamese-400-normal.woff2',
  'vendor/fonts/arimo/arimo-vietnamese-400-italic.woff2',
  'vendor/fonts/arimo/arimo-vietnamese-700-normal.woff2',
  'vendor/fonts/arimo/arimo-vietnamese-700-italic.woff2',
  'vendor/fonts/lexend/lexend-latin-400-normal.woff2',
  'vendor/fonts/lexend/lexend-latin-700-normal.woff2',
  'vendor/fonts/lexend/lexend-latin-ext-400-normal.woff2',
  'vendor/fonts/lexend/lexend-latin-ext-700-normal.woff2',
  'vendor/fonts/lexend/lexend-vietnamese-400-normal.woff2',
  'vendor/fonts/lexend/lexend-vietnamese-700-normal.woff2',
  'vendor/fonts/comic-neue/comic-neue-latin-400-normal.woff2',
  'vendor/fonts/comic-neue/comic-neue-latin-400-italic.woff2',
  'vendor/fonts/comic-neue/comic-neue-latin-700-normal.woff2',
  'vendor/fonts/comic-neue/comic-neue-latin-700-italic.woff2',
  'vendor/fonts/atkinson-hyperlegible/atkinson-hyperlegible-latin-400-normal.woff2',
  'vendor/fonts/atkinson-hyperlegible/atkinson-hyperlegible-latin-400-italic.woff2',
  'vendor/fonts/atkinson-hyperlegible/atkinson-hyperlegible-latin-700-normal.woff2',
  'vendor/fonts/atkinson-hyperlegible/atkinson-hyperlegible-latin-700-italic.woff2',
  'vendor/fonts/atkinson-hyperlegible/atkinson-hyperlegible-latin-ext-400-normal.woff2',
  'vendor/fonts/atkinson-hyperlegible/atkinson-hyperlegible-latin-ext-400-italic.woff2',
  'vendor/fonts/atkinson-hyperlegible/atkinson-hyperlegible-latin-ext-700-normal.woff2',
  'vendor/fonts/atkinson-hyperlegible/atkinson-hyperlegible-latin-ext-700-italic.woff2',
  'vendor/fonts/opendyslexic/opendyslexic-latin-400-normal.woff2',
  'vendor/fonts/opendyslexic/opendyslexic-latin-400-italic.woff2',
  'vendor/fonts/opendyslexic/opendyslexic-latin-700-normal.woff2',
  'vendor/fonts/opendyslexic/opendyslexic-latin-700-italic.woff2',
  'vendor/fonts/dejavu-sans/dejavu-sans-400-normal.woff2',
  'vendor/fonts/dejavu-sans/dejavu-sans-400-italic.woff2',
  'vendor/fonts/dejavu-sans/dejavu-sans-700-normal.woff2',
  'vendor/fonts/dejavu-sans/dejavu-sans-700-italic.woff2',
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

// "Share → Folio" from Android's share sheet POSTs the books here (see share_target in the manifest).
// Stash them and reload the app, which imports and identifies them like any other new book.
async function receiveShare(req) {
  const home = new URL('./', self.registration.scope);
  try {
    const form = await req.formData();
    const files = form.getAll('pdfs').filter((f) => f && typeof f !== 'string');
    const cache = await caches.open(SHARE_CACHE);
    const stamp = Date.now();
    await Promise.all(files.map((f, i) => cache.put(
      new URL(`shared/${stamp}-${i}`, home).href,
      new Response(f, { headers: { 'Content-Type': f.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(f.name || 'shared') } })
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
  // The free classics library: the catalog is always fetched fresh (the app keeps its own copy for
  // offline), and books go straight into the library's storage, so neither is cached here. Covers are.
  if (url.pathname.includes('/library/') && !url.pathname.endsWith('.svg')) return;
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

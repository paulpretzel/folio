/* Folio — boot. The real work lives in library.js (books, albums, import) and reader.js (paging). */
import { applyTheme, settings } from './settings.js';
import { initLibrary, loadLibrary, importFiles, getBooks } from './library.js';
import { initReader, openBook } from './reader.js';
import { ls } from './ui.js';

initReader({ onClose: () => loadLibrary() });
initLibrary({ openBook });

/* PDFs sent to Folio from another app (Android share sheet → Folio) are stashed
   by the service worker; pick them up here and run them through the normal
   import + identify + file-into-an-album flow. */
async function takeSharedFiles() {
  if (!new URLSearchParams(location.search).has('shared')) return false;
  history.replaceState(null, '', location.pathname);
  try {
    const cache = await caches.open('folio-share');
    const files = [];
    for (const req of await cache.keys()) {
      const res = await cache.match(req);
      if (res) {
        const name = decodeURIComponent(res.headers.get('X-Filename') || 'shared.pdf');
        files.push(new File([await res.blob()], name, { type: 'application/pdf' }));
      }
      await cache.delete(req);
    }
    if (files.length) { await importFiles(files); return true; }
  } catch (e) { console.warn('Couldn’t read shared files', e); }
  return false;
}

async function init() {
  applyTheme();
  await loadLibrary();
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
  const shared = await takeSharedFiles();
  const last = ls.get('openBook');
  if (!shared && last && settings.resume && getBooks().some((b) => b.id === last)) openBook(last);
}
init();

/* Free classics: public-domain books from Folio's own library, one tap to add.
 *
 * The library is a folder on the same web host as Folio (built by tools/make-library.py):
 * library/catalog.json, library/books/*.epub and library/covers/*.svg. Folio only fetches the
 * catalog when this screen opens and a book when someone taps Get, sends nothing about the
 * reader, and lists each download in Settings → Privacy.
 *
 * For the Play app, which runs from its own local address, set LIBRARY to the full web address
 * and add that host to connect-src in index.html's Content-Security-Policy.
 */
import { $, esc, icon, ls, toast, openModal, closeTop } from './ui.js';
import { getBooks, addClassic } from './library.js';
import { logDownload } from './privacy.js';

const LIBRARY = new URL('library/', location.href);
const storeEl = $('#store');
const shelvesEl = $('#store-shelves');
const searchEl = $('#store-search');
const bookEl = $('#store-book');

let catalog = ls.get('classics', null);         // last catalog seen, so the shelves show offline too
let hooks = {};
export function initStore(h) { hooks = h; }

const idOf = (b) => 'b' + b.sha256.slice(0, 32);  // the same id the library gives the file
const owned = (b) => getBooks().find((x) => x.id === idOf(b));
const coverUrl = (b) => new URL(`covers/${b.cover}`, LIBRARY).href;
const length = (b) => b.minutes < 60 ? `${Math.max(1, b.minutes)} min` : b.minutes < 90 ? 'about 1 hour' : `about ${Math.round(b.minutes / 60)} hours`;
const size = (b) => b.bytes < 1e6 ? `${Math.max(1, Math.round(b.bytes / 1024))} KB` : `${(b.bytes / 1e6).toFixed(1)} MB`;

export async function openStore() {
  searchEl.value = '';
  render();
  openModal(storeEl);
  try {
    const res = await fetch(new URL('catalog.json', LIBRARY), { cache: 'no-cache' });
    if (!res.ok) throw new Error(res.status === 404 ? 'none' : 'http');
    const fresh = await res.json();
    if (!Array.isArray(fresh.books)) throw new Error('bad');
    catalog = fresh;
    ls.set('classics', catalog);
  } catch (e) {
    if (!catalog) return showMessage(e.message === 'none'
      ? 'The free library isn’t available yet. Check back soon.'
      : 'You’re offline. Connect to the internet to see the free classics.');
  }
  render();
}

function showMessage(text) {
  shelvesEl.innerHTML = `<p class="muted store-msg">${esc(text)}</p>`;
}

function card(b) {
  const have = owned(b);
  return `<button class="store-item" data-id="${esc(b.id)}">
    <div class="cover"><img src="${esc(coverUrl(b))}" alt="" loading="lazy"></div>
    <span class="store-title">${esc(b.title)}</span>
    <span class="store-author">${have ? `${icon('check')}In your library` : esc(b.author)}</span>
  </button>`;
}

function render() {
  if (!catalog) return showMessage('Loading the free classics…');
  const q = searchEl.value.trim().toLowerCase();
  if (q) {
    const hits = catalog.books.filter((b) => `${b.title} ${b.author} ${b.blurb}`.toLowerCase().includes(q));
    shelvesEl.innerHTML = hits.length
      ? `<div class="store-grid">${hits.map(card).join('')}</div>`
      : `<p class="muted store-msg">No free classics match “${esc(searchEl.value.trim())}”.</p>`;
  } else {
    shelvesEl.innerHTML = catalog.shelves.map((s) => {
      const list = catalog.books.filter((b) => b.shelves.includes(s.id));
      return list.length ? `<section class="store-shelf"><h4>${esc(s.title)}</h4><div class="store-row">${list.map(card).join('')}</div></section>` : '';
    }).join('');
  }
  for (const img of shelvesEl.querySelectorAll('.cover img')) {
    img.onerror = () => { img.outerHTML = `<div class="fallback">${esc(img.closest('.store-item').querySelector('.store-title').textContent)}</div>`; };
  }
}

searchEl.addEventListener('input', render);
shelvesEl.addEventListener('click', (e) => {
  const b = catalog?.books.find((x) => x.id === e.target.closest('.store-item')?.dataset.id);
  if (b) showBook(b);
});

function showBook(b) {
  $('#store-book-cover').innerHTML = `<img src="${esc(coverUrl(b))}" alt="">`;
  $('#store-book-title').textContent = b.title;
  $('#store-book-author').textContent = b.year ? `${b.author} · ${b.year}` : b.author;
  $('#store-book-blurb').textContent = b.blurb || '';
  $('#store-book-meta').textContent = `${length(b)} to read · ${size(b)}`;
  const btn = $('#store-get');
  const label = btn.querySelector('span');
  const set = () => {
    const have = owned(b);
    label.textContent = have ? 'Read' : 'Get';
    btn.querySelector('svg use').setAttribute('href', have ? '#i-book' : '#i-download');
  };
  set();
  btn.disabled = false;
  btn.onclick = async () => {
    const have = owned(b);
    if (have) return readNow(have.id);
    btn.disabled = true;
    try {
      const book = await download(b, (p) => { label.textContent = p < 1 ? `${Math.round(p * 100)}%` : 'Adding…'; });
      if (!book) throw new Error('add');
      render();
      if (!bookEl.hidden) set();
      toast(`Added to Classics`, { action: 'Read now', onAction: () => readNow(book.id) });
    } catch (e) {
      console.warn(e);
      label.textContent = 'Get';
      toast(e.message === 'check' ? 'That download was damaged. Please try again.' : navigator.onLine === false ? 'You’re offline. Connect to download books.' : 'Couldn’t download that book. Please try again.');
    } finally { btn.disabled = false; }
  };
  openModal(bookEl);
}

async function readNow(id) {
  while (!bookEl.hidden || !storeEl.hidden) await closeTop();
  hooks.openBook?.(id);
}

/** Download a book with progress, check it against the catalog, and add it to the library. */
async function download(b, progress) {
  const url = new URL(`books/${b.file}`, LIBRARY);
  const res = await fetch(url);
  if (!res.ok) throw new Error('http');
  const total = +res.headers.get('Content-Length') || b.bytes;
  const parts = [];
  let got = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value); got += value.length;
    progress(Math.min(0.99, got / total));
  }
  const blob = new Blob(parts, { type: 'application/epub+zip' });
  if (crypto.subtle) {
    const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))].map((x) => x.toString(16).padStart(2, '0')).join('');
    if (hash !== b.sha256) throw new Error('check');
  }
  logDownload(url.href, b.title);
  progress(1);
  return addClassic(new File([blob], b.file, { type: 'application/epub+zip' }), b);
}

$('#store-btn').onclick = openStore;
$('#empty-store-btn').onclick = openStore;

import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import { db } from './db.js';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
const PDF_OPTS = {
  cMapUrl: new URL('../vendor/pdfjs/cmaps/', import.meta.url).href,
  cMapPacked: true,
  standardFontDataUrl: new URL('../vendor/pdfjs/standard_fonts/', import.meta.url).href,
  isEvalSupported: false,
};

/* ================================================================
   Helpers
   ================================================================ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const icon = (name) => `<svg><use href="#i-${name}"/></svg>`;
const isNarrow = () => innerWidth < 900;

const ls = {
  get(k, d = null) { try { const v = localStorage.getItem('folio:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('folio:' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('folio:' + k); } catch {} },
};

function relTime(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
function fmtDuration(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return '0m';
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m`;
}
function pct(book) {
  if (!book.pageCount) return 0;
  if (book.lastPage >= book.pageCount) return 100;
  return Math.floor(((book.lastPage - 1) + (book.lastFrac || 0)) / book.pageCount * 100);
}

/* ---------- toast & busy ---------- */
const toastEl = $('#toast');
let toastTimer;
function toast(msg, { action, onAction, ms = 2400 } = {}) {
  clearTimeout(toastTimer);
  toastEl.replaceChildren(document.createTextNode(msg));
  if (action) {
    const b = document.createElement('button');
    b.className = 'toast-action';
    b.textContent = action;
    b.onclick = () => { toastEl.classList.remove('show'); onAction?.(); };
    toastEl.append(b);
    ms = 5000;
  }
  toastEl.classList.add('show');
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}
function busy(on, text = 'Working…') {
  $('#busy').hidden = !on;
  $('#busy-text').textContent = text;
}

/* ---------- overlay stack wired to the history (Android back button) ---------- */
const overlays = [];
const popWaiters = [];
function pushOverlay(name, close) {
  overlays.push({ name, close });
  history.pushState({ folio: overlays.length }, '');
}
function closeTop() {
  return new Promise((resolve) => {
    if (!overlays.length) return resolve();
    popWaiters.push(resolve);
    history.back();
  });
}
addEventListener('popstate', () => {
  const o = overlays.pop();
  o?.close();
  popWaiters.shift()?.();
});
const topOverlay = () => overlays[overlays.length - 1]?.name;

function openModal(el, onClose) {
  el.hidden = false;
  pushOverlay(el.id, () => { el.hidden = true; onClose?.(); });
}
for (const m of $$('.modal')) {
  m.addEventListener('click', (e) => {
    if (e.target === m || e.target.closest('[data-close]')) closeTop();
  });
}

/* ---------- dialogs ---------- */
function promptDialog({ title, value = '', placeholder = '', multiline = false, quote = null, okText = 'Save', inputType = 'text', message = null, noInput = false, danger = false }) {
  return new Promise((resolve) => {
    const dlg = $('#dialog');
    $('#dialog-title').textContent = title;
    const q = $('#dialog-quote');
    q.hidden = !quote; q.textContent = quote || '';
    const msg = $('#dialog-msg');
    msg.hidden = !message; msg.textContent = message || '';
    const input = $('#dialog-input'), ta = $('#dialog-textarea');
    input.hidden = noInput || multiline;
    ta.hidden = noInput || !multiline;
    const field = multiline ? ta : input;
    field.value = value;
    field.placeholder = placeholder;
    input.type = inputType;
    input.inputMode = inputType === 'number' ? 'numeric' : 'text';
    const ok = $('#dialog-ok');
    ok.textContent = okText;
    ok.style.background = danger ? '#d1453b' : '';
    ok.style.color = danger ? '#fff' : '';
    let result = null;
    const submit = () => { result = noInput ? true : field.value; closeTop(); };
    ok.onclick = submit;
    $('#dialog-cancel').onclick = () => closeTop();
    input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } };
    openModal(dlg, () => resolve(result));
    if (!noInput) { field.focus(); if (!multiline) field.select(); }
  });
}
const confirmDialog = (opts) => promptDialog({ ...opts, noInput: true });

function actionSheet(title, actions) {
  $('#action-title').textContent = title;
  $('#action-title').hidden = !title;
  const list = $('#action-list');
  list.replaceChildren(...actions.map((a) => {
    const b = document.createElement('button');
    b.innerHTML = `${icon(a.icon)}<span>${esc(a.label)}</span>`;
    if (a.danger) b.className = 'danger';
    b.onclick = async () => { await closeTop(); a.run(); };
    return b;
  }));
  openModal($('#action-sheet'));
}

/* ---------- file share/download ---------- */
async function shareOrDownload(filename, text, mime) {
  const file = new File([text], filename, { type: mime });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file], title: filename }); return; }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

/* ================================================================
   Settings & theme
   ================================================================ */
const DEFAULTS = { theme: 'auto', invert: true, tapTurn: false, keepAwake: false, autoHide: true, resume: true, lastColor: 'yellow' };
const settings = { ...DEFAULTS, ...ls.get('settings', {}) };
const saveSettings = () => ls.set('settings', settings);
const darkMq = matchMedia('(prefers-color-scheme: dark)');

function applyTheme() {
  const t = settings.theme === 'auto' ? (darkMq.matches ? 'dark' : 'light') : settings.theme;
  const root = document.documentElement;
  root.dataset.theme = t;
  root.classList.toggle('invert-pages', !!settings.invert);
  for (const seg of [$('#theme-seg'), $('#lib-theme-seg')]) {
    for (const b of seg.children) b.classList.toggle('active', b.dataset.theme === settings.theme);
  }
  const bg = getComputedStyle(root).getPropertyValue(R?.open ? '--viewer-bg' : '--bg').trim();
  $('#theme-color').setAttribute('content', bg || '#f6f3ee');
}
darkMq.addEventListener?.('change', applyTheme);

/* ================================================================
   Library
   ================================================================ */
let books = [];
const libraryEl = $('#library');
const gridEl = $('#book-grid');

async function loadLibrary() {
  books = await db.all('books');
  books.sort((a, b) => (b.lastOpened || b.addedAt) - (a.lastOpened || a.addedAt));
  renderLibrary();
}

function coverHtml(b) {
  return b.cover
    ? `<img src="${b.cover}" alt="" loading="lazy">`
    : `<div class="fallback">${esc(b.title)}</div>`;
}

function renderLibrary() {
  const filter = $('#lib-filter').value.trim().toLowerCase();
  $('#empty').hidden = books.length > 0;
  $('#lib-toolbar').hidden = books.length < 6;
  const total = books.reduce((s, b) => s + (b.readSeconds || 0), 0);
  $('#lib-sub').textContent = books.length
    ? `${books.length} book${books.length === 1 ? '' : 's'}${total >= 60 ? ` · ${fmtDuration(total)} read` : ''}`
    : '';

  // Continue reading
  const recent = books.find((b) => b.lastOpened);
  const cont = $('#continue');
  if (recent && !filter) {
    const p = pct(recent);
    cont.hidden = false;
    cont.dataset.id = recent.id;
    cont.innerHTML = `
      <div class="cover">${coverHtml(recent)}</div>
      <div class="grow" style="min-width:0">
        <div class="eyebrow">Continue reading</div>
        <h2>${esc(recent.title)}</h2>
        <div class="meta">${recent.author ? esc(recent.author) + ' · ' : ''}Page ${recent.lastPage} of ${recent.pageCount} · ${relTime(recent.lastOpened)}</div>
        <div class="progress"><i style="width:${p}%"></i></div>
      </div>`;
  } else cont.hidden = true;

  const list = filter
    ? books.filter((b) => (b.title + ' ' + (b.author || '') + ' ' + (b.fileName || '')).toLowerCase().includes(filter))
    : books;
  gridEl.innerHTML = list.map((b) => {
    const p = pct(b);
    const status = p >= 100 ? 'Finished' : b.lastOpened ? `${p}%` : `${b.pageCount} pages`;
    return `
    <div class="book" data-id="${esc(b.id)}">
      <div class="cover">${coverHtml(b)}</div>
      ${!b.lastOpened ? '<span class="badge-new">NEW</span>' : ''}
      <button class="more" aria-label="Book options">${icon('more')}</button>
      <h3>${esc(b.title)}</h3>
      ${b.lastOpened ? `<div class="progress"><i style="width:${p}%"></i></div>` : ''}
      <div class="meta"><span>${status}</span><span>${b.lastOpened ? relTime(b.lastOpened) : ''}</span></div>
    </div>`;
  }).join('') || (filter ? `<p class="muted">No books match “${esc(filter)}”.</p>` : '');
}

gridEl.addEventListener('click', (e) => {
  const card = e.target.closest('.book');
  if (!card) return;
  const book = books.find((b) => b.id === card.dataset.id);
  if (e.target.closest('.more')) bookMenu(book);
  else openBook(book.id);
});
$('#continue').addEventListener('click', (e) => openBook(e.currentTarget.dataset.id));
$('#lib-filter').addEventListener('input', renderLibrary);

function bookMenu(book) {
  actionSheet(book.title, [
    { label: 'Rename', icon: 'pencil', run: async () => {
      const v = await promptDialog({ title: 'Rename book', value: book.title });
      if (v && v.trim()) { book.title = v.trim(); await db.put('books', book); renderLibrary(); }
    } },
    { label: 'Export highlights & notes', icon: 'share', run: async () => {
      const hls = await db.byBook('highlights', book.id);
      if (!hls.length) return toast('No highlights in this book yet');
      await shareOrDownload(safeName(book.title) + ' — highlights.md', highlightsMarkdown(book, hls, []), 'text/markdown');
    } },
    { label: 'Remove from library', icon: 'trash', danger: true, run: async () => {
      const ok = await confirmDialog({ title: 'Remove this book?', message: `“${book.title}” and its highlights, notes and bookmarks will be deleted from this device.`, okText: 'Remove', danger: true });
      if (!ok) return;
      await db.deleteBook(book.id);
      if (ls.get('openBook') === book.id) ls.del('openBook');
      await loadLibrary();
      toast('Book removed');
    } },
  ]);
}

const safeName = (s) => s.replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'book';

/* ---------- importing ---------- */
const fileInput = $('#file-input');
$('#add-book-btn').onclick = () => fileInput.click();
$('#empty-add-btn').onclick = () => fileInput.click();
fileInput.onchange = () => { importFiles(fileInput.files); fileInput.value = ''; };

function cleanTitle(t) {
  if (!t) return '';
  t = String(t).trim();
  if (t.length < 2 || /^(untitled|microsoft word|document\d*$|title$)/i.test(t) || /\.(docx?|pdf|indd|tex)$/i.test(t)) return '';
  return t;
}

async function makeCover(pdf) {
  try {
    const page = await pdf.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const vp = page.getViewport({ scale: 360 / vp1.width });
    const c = document.createElement('canvas');
    c.width = Math.round(vp.width); c.height = Math.round(vp.height);
    await page.render({ canvasContext: c.getContext('2d', { alpha: false }), viewport: vp }).promise;
    const url = c.toDataURL('image/jpeg', 0.8);
    c.width = c.height = 0;
    return url;
  } catch { return null; }
}

async function importFiles(fileList) {
  const files = [...fileList].filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!files.length) return toast('Please choose a PDF file');
  navigator.storage?.persist?.().catch(() => {});
  let added = 0, dup = 0, failed = 0, lastId = null, lastErr = '';
  for (const f of files) {
    busy(true, files.length > 1 ? `Adding ${added + dup + failed + 1} of ${files.length}…` : 'Adding book…');
    let pdf;
    try {
      const buf = await f.arrayBuffer();
      pdf = await pdfjsLib.getDocument({ ...PDF_OPTS, data: new Uint8Array(buf.slice(0)) }).promise;
      const id = pdf.fingerprints[0];
      if (await db.get('books', id)) { dup++; lastId = id; continue; }
      const meta = await pdf.getMetadata().catch(() => null);
      const title = cleanTitle(meta?.info?.Title) || f.name.replace(/\.pdf$/i, '').replace(/[_]+/g, ' ');
      const author = (meta?.info?.Author || '').trim();
      const cover = await makeCover(pdf);
      await db.put('files', buf, id);
      const book = {
        id, title, author, fileName: f.name, size: f.size, pageCount: pdf.numPages,
        addedAt: Date.now(), lastOpened: 0, lastPage: 1, lastFrac: 0, zoom: 1, readSeconds: 0, cover,
      };
      // Apply reading position from a restored backup, if any
      const pending = ls.get('pendingProgress', {});
      if (pending[id]) {
        Object.assign(book, { lastPage: pending[id].lastPage || 1, lastFrac: pending[id].lastFrac || 0, zoom: pending[id].zoom || 1, readSeconds: pending[id].readSeconds || 0, lastOpened: pending[id].lastOpened || 0 });
        delete pending[id]; ls.set('pendingProgress', pending);
      }
      await db.put('books', book);
      added++; lastId = id;
    } catch (e) {
      console.error(e);
      failed++;
      lastErr = e?.name === 'PasswordException' ? 'Password-protected PDFs aren’t supported' : e?.name === 'QuotaExceededError' ? 'Not enough storage space on this device' : 'Couldn’t read that PDF';
    } finally {
      pdf?.destroy();
    }
  }
  busy(false);
  await loadLibrary();
  const parts = [];
  if (added) parts.push(`Added ${added} book${added > 1 ? 's' : ''}`);
  if (dup) parts.push(`${dup} already in your library`);
  if (failed) parts.push(failed === 1 ? lastErr : `${failed} failed`);
  if (added === 1 && files.length === 1) toast(parts.join(' · '), { action: 'Read now', onAction: () => openBook(lastId) });
  else toast(parts.join(' · '));
}

// Drag & drop (desktop / iPad split-view)
let dragDepth = 0, dropHint = null;
addEventListener('dragenter', (e) => {
  if (!libraryEl.hidden && e.dataTransfer?.types?.includes('Files')) {
    dragDepth++;
    if (!dropHint) { dropHint = document.createElement('div'); dropHint.className = 'drop-hint'; dropHint.textContent = 'Drop PDFs to add them'; document.body.append(dropHint); }
  }
});
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; dropHint?.remove(); dropHint = null; } });
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('drop', (e) => {
  e.preventDefault(); dragDepth = 0; dropHint?.remove(); dropHint = null;
  if (!libraryEl.hidden && e.dataTransfer?.files?.length) importFiles(e.dataTransfer.files);
});

/* ---------- library settings, backup & restore ---------- */
$('#lib-settings-btn').onclick = async () => {
  $('#opt-resume').checked = settings.resume;
  openModal($('#lib-settings'));
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    if (est) $('#storage-info').textContent = `Using ${(est.usage / 1048576).toFixed(1)} MB on this device${persisted ? ' · protected from automatic cleanup' : ''}.`;
  } catch {}
};
$('#opt-resume').onchange = (e) => { settings.resume = e.target.checked; saveSettings(); };

$('#backup-btn').onclick = async () => {
  const [bks, hls, bms] = await Promise.all([db.all('books'), db.all('highlights'), db.all('bookmarks')]);
  const data = {
    app: 'folio', version: 1, exportedAt: new Date().toISOString(),
    books: bks.map(({ id, title, author, fileName, pageCount, lastPage, lastFrac, zoom, readSeconds, lastOpened }) => ({ id, title, author, fileName, pageCount, lastPage, lastFrac, zoom, readSeconds, lastOpened })),
    highlights: hls, bookmarks: bms,
  };
  const d = new Date();
  const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await shareOrDownload(`folio-backup-${stamp}.json`, JSON.stringify(data), 'application/json');
};
$('#restore-btn').onclick = () => $('#restore-input').click();
$('#restore-input').onchange = async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data.app !== 'folio') throw new Error('Not a Folio backup');
    const existingBms = await db.all('bookmarks');
    const bmKeys = new Set(existingBms.map((b) => b.bookId + ':' + b.page));
    const newBms = (data.bookmarks || []).filter((b) => !bmKeys.has(b.bookId + ':' + b.page));
    await db.putMany('highlights', data.highlights || []);
    await db.putMany('bookmarks', newBms);
    const pending = ls.get('pendingProgress', {});
    let matched = 0;
    for (const b of data.books || []) {
      const ex = await db.get('books', b.id);
      if (ex) {
        matched++;
        if ((b.lastOpened || 0) > (ex.lastOpened || 0)) Object.assign(ex, { lastPage: b.lastPage, lastFrac: b.lastFrac, zoom: b.zoom, lastOpened: b.lastOpened });
        ex.readSeconds = Math.max(ex.readSeconds || 0, b.readSeconds || 0);
        await db.put('books', ex);
      } else pending[b.id] = b;
    }
    ls.set('pendingProgress', pending);
    await loadLibrary();
    const waiting = (data.books || []).length - matched;
    toast(`Restored ${(data.highlights || []).length} highlights and ${newBms.length} bookmarks` + (waiting ? ` · ${waiting} book${waiting > 1 ? 's' : ''} will pick them up when added` : ''), { ms: 4500 });
  } catch (err) {
    console.error(err);
    toast('That file isn’t a Folio backup');
  }
};

/* ================================================================
   Reader
   ================================================================ */
const readerEl = $('#reader');
const viewer = $('#viewer');
const pagesEl = $('#pages');
const topbar = $('#topbar');
const bottombar = $('#bottombar');
const selToolbar = $('#sel-toolbar');
const hlPopover = $('#hl-popover');
const settingsSheet = $('#settings-sheet');
const panel = $('#panel');
const scrubber = $('#scrubber');
const GAP = 14;
const COLORS = ['yellow', 'green', 'blue', 'pink'];

let genCounter = 0;
function freshState() {
  return {
    open: false, gen: ++genCounter, book: null, pdf: null, pages: [],
    scale: 1, fit: 1, zoom: 1, topPad: 60, contentW: 0, current: 1,
    highlights: [], hlByPage: new Map(), bookmarks: new Map(), outline: [], chapters: [], textCache: new Map(),
    visible: new Set(), active: 0, io: null, renderScheduled: false,
    chromeHidden: false, lastST: 0, programmatic: false, backJump: null, backLanding: 0,
    saveTimer: 0, readTimer: 0, lastActivity: Date.now(), wake: null,
    selRange: null, popHl: null, searchToken: 0, hlFilter: 'all', pinching: false, tab: 'toc',
  };
}
let R = freshState();

async function openBook(id) {
  const book = await db.get('books', id);
  if (!book) return toast('That book is no longer in your library');
  const buf = await db.get('files', id);
  if (!buf) return toast('The PDF file for this book is missing');

  R = freshState();
  toastEl.classList.remove('show');
  R.book = book;
  R.zoom = book.zoom || 1;
  R.open = true;
  const gen = R.gen;

  libraryEl.hidden = true;
  readerEl.hidden = false;
  readerEl.classList.remove('chrome-hidden');
  $('#book-title').textContent = book.title;
  $('#chapter-title').textContent = '';
  $('#loading').hidden = false;
  $('#backjump').hidden = true;
  pagesEl.replaceChildren();
  applyTheme();
  pushOverlay('reader', closeReaderNow);
  ls.set('openBook', id);

  try {
    R.pdf = await pdfjsLib.getDocument({ ...PDF_OPTS, data: new Uint8Array(buf) }).promise;
  } catch (e) {
    console.error(e);
    $('#loading').hidden = true;
    toast('Couldn’t open this PDF');
    closeTop();
    return;
  }
  if (gen !== R.gen) return;
  const first = await R.pdf.getPage(1);
  const vp1 = first.getViewport({ scale: 1 });
  const N = R.pdf.numPages;
  const frag = document.createDocumentFragment();
  for (let i = 0; i < N; i++) {
    const p = { num: i + 1, w: vp1.width, h: vp1.height, sized: i === 0, top: 0, left: 0, wpx: 0, hpx: 0,
      el: null, hlLayer: null, markLayer: null, canvas: null, textDiv: null, renderedScale: 0, rendering: false, task: null, waiters: [] };
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.page = p.num;
    el.innerHTML = `<span class="pnum">${p.num}</span><div class="hl-layer"></div><div class="mark-layer"></div>`;
    p.el = el; p.hlLayer = el.children[1]; p.markLayer = el.children[2];
    R.pages.push(p);
    frag.append(el);
  }
  pagesEl.append(frag);

  const [hls, bms] = await Promise.all([db.byBook('highlights', id), db.byBook('bookmarks', id)]);
  if (gen !== R.gen) return;
  R.highlights = hls;
  indexHighlights();
  for (const b of bms) R.bookmarks.set(b.page, b);
  for (const p of R.pages) { renderHighlights(p); renderMarks(p); }

  scrubber.max = N;
  layout();
  const lastPage = clamp(book.lastPage || 1, 1, N);
  applyAnchor({ i: lastPage - 1, f: book.lastFrac || 0, yInView: R.topPad });
  viewer.scrollLeft = (R.contentW - viewer.clientWidth) / 2;
  R.lastST = viewer.scrollTop;
  setupObserver();
  updateCurrent(true);
  $('#loading').hidden = true;
  viewer.focus({ preventScroll: true });

  book.lastOpened = Date.now();
  db.put('books', book);
  if (lastPage > 1 || (book.lastFrac || 0) > 0.05) toast(`Picked up where you left off · page ${R.current}`);

  R.readTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && Date.now() - R.lastActivity < 120000 && R.book) {
      R.book.readSeconds = (R.book.readSeconds || 0) + 15;
      saveSoon();
    }
  }, 15000);
  requestWake();
  loadOutline(gen);
  loadPageSizes(gen);
}

function closeReaderNow() {
  savePosition();
  clearInterval(R.readTimer);
  clearTimeout(R.saveTimer);
  R.io?.disconnect();
  for (const p of R.pages) { p.task?.cancel(); if (p.canvas) { p.canvas.width = p.canvas.height = 0; } }
  pagesEl.replaceChildren();
  R.pdf?.destroy();
  releaseWake();
  R = { ...freshState(), open: false };
  hideSelToolbar(); hidePopover(); settingsSheet.hidden = true;
  panel.classList.remove('open'); $('#scrim').hidden = true;
  readerEl.hidden = true;
  libraryEl.hidden = false;
  ls.del('openBook');
  applyTheme();
  loadLibrary();
}

$('#close-reader').onclick = () => closeTop();

/* ---------- layout & anchors ---------- */
function layout() {
  const vw = viewer.clientWidth;
  const pad = vw < 600 ? 6 : 20;
  R.fit = (vw - pad * 2) / R.pages[0].w;
  R.scale = R.fit * R.zoom;
  R.topPad = topbar.offsetHeight + 10;
  let y = R.topPad, maxW = 0;
  for (const p of R.pages) {
    p.wpx = p.w * R.scale;
    p.hpx = p.h * R.scale;
    p.top = y;
    y += p.hpx + GAP;
    if (p.wpx > maxW) maxW = p.wpx;
  }
  R.contentW = Math.max(vw, maxW + pad * 2);
  const contentH = y - GAP + bottombar.offsetHeight + 30;
  pagesEl.style.width = R.contentW + 'px';
  pagesEl.style.height = contentH + 'px';
  for (const p of R.pages) {
    p.left = (R.contentW - p.wpx) / 2;
    p.el.style.cssText = `left:${p.left}px;top:${p.top}px;width:${p.wpx}px;height:${p.hpx}px;--scale-factor:${R.scale}`;
  }
  $('#zoom-label').textContent = Math.round(R.zoom * 100) + '%';
}

function pageIndexAt(y) {
  const ps = R.pages;
  let lo = 0, hi = ps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ps[mid].top <= y) lo = mid; else hi = mid - 1;
  }
  return lo;
}
function getAnchor(yInView, xInView = null) {
  const y = viewer.scrollTop + yInView;
  const i = pageIndexAt(y);
  const p = R.pages[i];
  const a = { i, f: clamp((y - p.top) / p.hpx, 0, 0.9999), yInView };
  if (xInView != null) { a.fx = (viewer.scrollLeft + xInView - p.left) / p.wpx; a.xInView = xInView; }
  return a;
}
function applyAnchor(a) {
  const p = R.pages[a.i];
  R.programmatic = true;
  viewer.scrollTop = p.top + a.f * p.hpx - a.yInView;
  if (a.fx != null) viewer.scrollLeft = p.left + a.fx * p.wpx - a.xInView;
}
function relayout(mutate) {
  const a = getAnchor(R.topPad);
  mutate?.();
  layout();
  applyAnchor(a);
  scheduleRender();
}

async function loadPageSizes(gen) {
  const N = R.pages.length;
  for (let start = 1; start < N; start += 40) {
    const changes = [];
    for (let j = start; j < Math.min(N, start + 40); j++) {
      const p = R.pages[j];
      if (p.sized) continue;
      let vp;
      try { vp = (await R.pdf.getPage(j + 1)).getViewport({ scale: 1 }); } catch { return; }
      if (gen !== R.gen) return;
      p.sized = true;
      if (Math.abs(vp.width - p.w) > 0.5 || Math.abs(vp.height - p.h) > 0.5) changes.push([p, vp]);
    }
    if (changes.length) relayout(() => changes.forEach(([p, vp]) => { p.w = vp.width; p.h = vp.height; }));
    await new Promise((r) => setTimeout(r, 0));
  }
}

let resizeTimer;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => { if (R.open && R.pages.length) relayout(); hideSelToolbar(); hidePopover(); }, 150);
});

/* ---------- rendering ---------- */
function setupObserver() {
  R.io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const p = R.pages[+e.target.dataset.page - 1];
      if (!p) continue;
      if (e.isIntersecting) R.visible.add(p);
      else { R.visible.delete(p); releasePage(p); }
    }
    scheduleRender();
  }, { root: viewer, rootMargin: '120% 60% 120% 60%' });
  for (const p of R.pages) R.io.observe(p.el);
}

function scheduleRender() {
  if (R.renderScheduled) return;
  R.renderScheduled = true;
  requestAnimationFrame(() => { R.renderScheduled = false; pumpRender(); });
}
function pumpRender() {
  while (R.active < 2) {
    let best = null, bd = Infinity;
    for (const p of R.visible) {
      if (p.rendering || (p.renderedScale === R.scale && p.textDiv)) continue;
      const d = Math.abs(p.num - R.current);
      if (d < bd) { bd = d; best = p; }
    }
    if (!best) return;
    R.active++;
    const gen = R.gen;
    renderPage(best, gen)
      .catch((err) => { if (err?.name !== 'RenderingCancelledException') console.warn(err); })
      .finally(() => { if (gen === R.gen) { R.active--; pumpRender(); } });
  }
}

async function renderPage(p, gen) {
  p.rendering = true;
  try {
    const page = await R.pdf.getPage(p.num);
    if (gen !== R.gen) return;
    if (!p.sized) {
      const base = page.getViewport({ scale: 1 });
      p.sized = true;
      if (Math.abs(base.width - p.w) > 0.5 || Math.abs(base.height - p.h) > 0.5) {
        relayout(() => { p.w = base.width; p.h = base.height; });
      }
    }
    const scale = R.scale;
    if (p.renderedScale !== scale) {
      const vp = page.getViewport({ scale });
      let out = Math.min(window.devicePixelRatio || 1, 3);
      const MAX_PX = 10e6;
      if (vp.width * vp.height * out * out > MAX_PX) out = Math.sqrt(MAX_PX / (vp.width * vp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(vp.width * out);
      canvas.height = Math.floor(vp.height * out);
      const task = page.render({
        canvasContext: canvas.getContext('2d', { alpha: false }),
        viewport: vp,
        transform: out !== 1 ? [out, 0, 0, out, 0, 0] : null,
      });
      p.task = task;
      try { await task.promise; } finally { p.task = null; }
      if (gen !== R.gen || !R.visible.has(p)) { canvas.width = canvas.height = 0; return; }
      if (p.canvas) { p.canvas.width = p.canvas.height = 0; p.canvas.remove(); }
      p.el.prepend(canvas);
      p.canvas = canvas;
      p.renderedScale = scale;
      p.el.classList.add('rendered');
    }
    if (!p.textDiv) {
      // The text layer is sized with CSS variables, so it stays aligned across zoom changes.
      const vp = page.getViewport({ scale: R.scale });
      const div = document.createElement('div');
      div.className = 'textLayer';
      const tl = new pdfjsLib.TextLayer({
        textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
        container: div,
        viewport: vp,
      });
      await tl.render();
      if (gen !== R.gen || !R.visible.has(p)) return;
      const eoc = document.createElement('div');
      eoc.className = 'endOfContent';
      div.append(eoc);
      p.el.append(div);
      p.textDiv = div;
      p.waiters.splice(0).forEach((r) => r());
    }
  } finally {
    p.rendering = false;
  }
}

function releasePage(p) {
  p.task?.cancel();
  if (p.canvas) { p.canvas.width = p.canvas.height = 0; p.canvas.remove(); p.canvas = null; }
  p.renderedScale = 0;
  p.el.classList.remove('rendered');
  if (p.textDiv) {
    const sel = getSelection();
    if (sel && sel.rangeCount && !sel.isCollapsed && p.textDiv.contains(sel.anchorNode)) return;
    p.textDiv.remove();
    p.textDiv = null;
  }
}

function whenTextReady(p) {
  if (p.textDiv) return Promise.resolve(true);
  return new Promise((resolve) => {
    p.waiters.push(() => resolve(true));
    setTimeout(() => resolve(false), 6000);
    scheduleRender();
  });
}

/* ---------- scroll, current page, chrome ---------- */
viewer.addEventListener('scroll', () => {
  if (R.scrollTick) return;
  R.scrollTick = true;
  requestAnimationFrame(onScrollFrame);
}, { passive: true });

function onScrollFrame() {
  R.scrollTick = false;
  if (!R.open) return;
  const st = viewer.scrollTop;
  const dy = st - R.lastST;
  R.lastST = st;
  if (!R.programmatic) {
    R.lastActivity = Date.now();
    if (settings.autoHide && dy > 8 && st > 40 && !panel.classList.contains('open') && selToolbar.hidden && settingsSheet.hidden) setChrome(false);
    hidePopover();
  }
  if (st < 10) setChrome(true);
  updateCurrent();
  if (!R.programmatic && R.backJump && Math.abs(R.current - R.backLanding) > 2) {
    R.backJump = null;
    $('#backjump').hidden = true;
  }
  R.programmatic = false;
  saveSoon();
}

function setChrome(show) {
  R.chromeHidden = !show;
  readerEl.classList.toggle('chrome-hidden', !show);
  if (!show) settingsSheet.hidden = true;
}

function updateCurrent(force = false) {
  if (!R.pages.length) return;
  const n = pageIndexAt(viewer.scrollTop + viewer.clientHeight * 0.4) + 1;
  if (n !== R.current || force) {
    R.current = n;
    updatePageUI();
  }
}

function chapterAt(n) {
  let cur = null;
  for (const c of R.chapters) { if (c.page <= n) cur = c; else break; }
  return cur;
}

function updatePageUI() {
  const N = R.pages.length, n = R.current;
  $('#page-label').textContent = `Page ${n} of ${N}`;
  if (!R.scrubbing) {
    scrubber.value = n;
    scrubber.style.setProperty('--fill', (N > 1 ? (n - 1) / (N - 1) * 100 : 100) + '%');
  }
  const ch = chapterAt(n);
  $('#chapter-title').textContent = ch ? ch.title : '';
  let left = '';
  const top = R.chapters.filter((c) => c.depth === 0);
  const marks = top.length >= 3 ? top : R.chapters;
  const next = marks.find((c) => c.page > n);
  if (marks.length && next) {
    const k = next.page - n;
    left = k === 1 ? 'Last page in chapter' : `${k} pages left in chapter`;
  } else {
    const k = N - n;
    left = k === 0 ? 'Last page' : `${k} page${k === 1 ? '' : 's'} left`;
  }
  const percent = N > 1 ? Math.round((n - 1) / (N - 1) * 100) : 100;
  $('#progress-label').textContent = `${percent}% · ${left}`;
  $('#bookmark-btn').classList.toggle('on', R.bookmarks.has(n));
  $('#bookmark-btn').setAttribute('aria-label', R.bookmarks.has(n) ? 'Remove bookmark' : 'Bookmark this page');
  if (R.tab === 'toc' && panel.classList.contains('open')) markCurrentToc();
}

/* ---------- saving position ---------- */
function saveSoon() {
  clearTimeout(R.saveTimer);
  R.saveTimer = setTimeout(savePosition, 600);
}
function savePosition() {
  if (!R.book || !R.pages.length) return;
  const a = getAnchor(R.topPad);
  R.book.lastPage = a.i + 1;
  R.book.lastFrac = +a.f.toFixed(4);
  R.book.zoom = R.zoom;
  R.book.lastOpened = Date.now();
  return db.put('books', R.book).catch(() => {});
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') savePosition();
  else if (R.open) requestWake();
});
addEventListener('pagehide', savePosition);

/* ---------- navigation ---------- */
function goToPage(n, { record = true, f = 0 } = {}) {
  n = clamp(Math.round(n), 1, R.pages.length);
  if (record) setBackJump();
  applyAnchor({ i: n - 1, f, yInView: R.topPad });
  updateCurrent();
  if (record) R.backLanding = R.current;
}

function setBackJump() {
  R.backJump = getAnchor(R.topPad);
  const b = $('#backjump');
  b.querySelector('span').textContent = `Back to page ${R.current}`;
  b.hidden = false;
}
$('#backjump').onclick = () => {
  if (!R.backJump) return;
  const here = getAnchor(R.topPad);
  const herePage = R.current;
  applyAnchor(R.backJump);
  updateCurrent();
  R.backJump = here;
  R.backLanding = R.current;
  $('#backjump').querySelector('span').textContent = `Return to page ${herePage}`;
};

function pageStep(dir) {
  const vh = viewer.clientHeight;
  const p = R.pages[R.current - 1];
  if (p.hpx <= vh - R.topPad) {
    // Whole page fits: snap to next/previous page
    const topIdx = pageIndexAt(viewer.scrollTop + R.topPad + 2);
    const aligned = Math.abs(viewer.scrollTop + R.topPad - R.pages[topIdx].top) < 4;
    const target = dir > 0 ? topIdx + 2 : (aligned ? topIdx : topIdx + 1);
    goToPage(target, { record: false });
  } else {
    R.programmatic = true;
    viewer.scrollTop += dir * (vh - R.topPad - 40);
  }
}

addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!selToolbar.hidden) return hideSelToolbar();
    if (!hlPopover.hidden) return hidePopover();
    if (!settingsSheet.hidden) { settingsSheet.hidden = true; return; }
    if (overlays.length) closeTop();
    return;
  }
  if (!R.open || topOverlay() !== 'reader' || e.target.closest?.('input,textarea')) return;
  if (['ArrowRight', 'PageDown', ' '].includes(e.key) || (e.key === 'ArrowDown' && e.altKey)) { e.preventDefault(); pageStep(e.shiftKey && e.key === ' ' ? -1 : 1); }
  else if (['ArrowLeft', 'PageUp'].includes(e.key)) { e.preventDefault(); pageStep(-1); }
  else if (e.key === 'Home') goToPage(1);
  else if (e.key === 'End') goToPage(R.pages.length);
  else if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); openPanel('search'); }
  else if ((e.metaKey || e.ctrlKey) && (e.key === '=' || e.key === '+')) { e.preventDefault(); setZoom(R.zoom * 1.2); }
  else if ((e.metaKey || e.ctrlKey) && e.key === '-') { e.preventDefault(); setZoom(R.zoom / 1.2); }
  else if (e.key === 'b' && !e.metaKey && !e.ctrlKey) toggleBookmark();
});

/* scrubber */
scrubber.addEventListener('input', () => {
  R.scrubbing = true;
  const n = +scrubber.value;
  const N = R.pages.length;
  scrubber.style.setProperty('--fill', (N > 1 ? (n - 1) / (N - 1) * 100 : 100) + '%');
  const ch = chapterAt(n);
  const prev = $('#scrub-preview');
  prev.hidden = false;
  prev.innerHTML = `<b>Page ${n}</b>${ch ? ' · ' + esc(ch.title) : ''}`;
});
scrubber.addEventListener('change', () => {
  R.scrubbing = false;
  $('#scrub-preview').hidden = true;
  goToPage(+scrubber.value);
});

$('#page-chip').onclick = async () => {
  const v = await promptDialog({ title: 'Go to page', value: String(R.current), inputType: 'number', okText: 'Go', placeholder: `1 – ${R.pages.length}` });
  if (v != null && v.trim() && !isNaN(+v)) goToPage(+v);
};

/* ---------- zoom (buttons, pinch, ctrl+wheel) ---------- */
function setZoom(z, anchor) {
  z = clamp(z, 0.5, 4);
  if (Math.abs(z - R.zoom) < 0.001) return;
  const ax = anchor?.x ?? viewer.clientWidth / 2;
  const ay = anchor?.y ?? viewer.clientHeight / 2;
  const a = getAnchor(ay, ax);
  R.zoom = z;
  layout();
  applyAnchor(a);
  scheduleRender();
  saveSoon();
}
$('#zoom-in').onclick = () => setZoom(R.zoom * 1.2);
$('#zoom-out').onclick = () => setZoom(R.zoom / 1.2);
$('#zoom-fit').onclick = () => { setZoom(1); viewer.scrollLeft = 0; };

let pinch = null;
const tdist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
viewer.addEventListener('touchstart', (e) => {
  if (e.touches.length === 2 && R.open) {
    const [a, b] = e.touches;
    const vr = viewer.getBoundingClientRect();
    const cx = (a.clientX + b.clientX) / 2 - vr.left;
    const cy = (a.clientY + b.clientY) / 2 - vr.top;
    pinch = { d0: tdist(a, b), cx, cy, k: 1 };
    pagesEl.style.transformOrigin = `${viewer.scrollLeft + cx}px ${viewer.scrollTop + cy}px`;
    R.pinching = true;
    hideSelToolbar(); hidePopover();
    if (e.cancelable) e.preventDefault();
  }
}, { passive: false });
viewer.addEventListener('touchmove', (e) => {
  if (pinch && e.touches.length === 2) {
    if (e.cancelable) e.preventDefault();
    const [a, b] = e.touches;
    pinch.k = clamp(tdist(a, b) / pinch.d0, 0.5 / R.zoom, 4 / R.zoom);
    pagesEl.style.transform = `scale(${pinch.k})`;
  }
}, { passive: false });
const endPinch = (e) => {
  if (!pinch || e.touches.length >= 2) return;
  const { k, cx, cy } = pinch;
  pinch = null;
  pagesEl.style.transform = '';
  if (Math.abs(k - 1) > 0.01) setZoom(R.zoom * k, { x: cx, y: cy });
  setTimeout(() => { R.pinching = false; }, 350);
};
viewer.addEventListener('touchend', endPinch);
viewer.addEventListener('touchcancel', endPinch);
document.addEventListener('gesturestart', (e) => e.preventDefault());
viewer.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const vr = viewer.getBoundingClientRect();
  setZoom(R.zoom * Math.exp(-e.deltaY * 0.01), { x: e.clientX - vr.left, y: e.clientY - vr.top });
}, { passive: false });

/* ---------- taps ---------- */
viewer.addEventListener('click', (e) => {
  if (R.pinching) return;
  const sel = getSelection();
  if (sel && !sel.isCollapsed) return;
  if (!hlPopover.hidden) { hidePopover(); return; }
  if (!settingsSheet.hidden) { settingsSheet.hidden = true; return; }
  const pageEl = e.target.closest('.page');
  if (pageEl) {
    const p = R.pages[+pageEl.dataset.page - 1];
    const r = pageEl.getBoundingClientRect();
    const hit = hitHighlight(p, e.clientX - r.left, e.clientY - r.top, r.width, r.height);
    if (hit) { showPopover(hit, e.clientX, e.clientY); return; }
  }
  if (settings.tapTurn) {
    const x = e.clientX / innerWidth;
    if (x < 0.22) return pageStep(-1);
    if (x > 0.78) return pageStep(1);
  }
  setChrome(R.chromeHidden);
});

/* ================================================================
   Highlights
   ================================================================ */
function indexHighlights() {
  R.hlByPage = new Map();
  for (const h of R.highlights) {
    if (!R.hlByPage.has(h.page)) R.hlByPage.set(h.page, []);
    R.hlByPage.get(h.page).push(h);
  }
}

function renderHighlights(p) {
  const list = R.hlByPage.get(p.num) || [];
  const html = [];
  for (const h of list) {
    for (const [x, y, w, hh] of h.rects) {
      html.push(`<div class="hl ${h.color}" data-id="${h.id}" data-group="${h.group || h.id}" style="left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${hh * 100}%"></div>`);
    }
  }
  p.hlLayer.innerHTML = html.join('');
  renderMarks(p);
}

function renderMarks(p) {
  const html = [];
  if (R.bookmarks.has(p.num)) html.push('<div class="ribbon"></div>');
  for (const h of R.hlByPage.get(p.num) || []) {
    if (!h.note) continue;
    const right = Math.max(...h.rects.map((r) => r[0] + r[2]));
    const left = right > 0.93 ? right - 0.03 : right + 0.008;
    html.push(`<div class="note-pin" style="left:${left * 100}%;top:${h.rects[0][1] * 100}%">${icon('note')}</div>`);
  }
  p.markLayer.innerHTML = html.join('');
}

function hitHighlight(p, x, y, w, h) {
  const list = R.hlByPage.get(p.num);
  if (!list) return null;
  const pad = 4;
  for (let i = list.length - 1; i >= 0; i--) {
    const hl = list[i];
    for (const [rx, ry, rw, rh] of hl.rects) {
      if (x >= rx * w - pad && x <= (rx + rw) * w + pad && y >= ry * h - pad && y <= (ry + rh) * h + pad) return hl;
    }
  }
  return null;
}

/* selection → rects (page fractions) */
function rangeOnPage(range, p) {
  const pr = p.el.getBoundingClientRect();
  const walker = document.createTreeWalker(p.textDiv, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  const raw = [];
  let text = '';
  let node;
  while ((node = walker.nextNode())) {
    if (!range.intersectsNode(node)) continue;
    if (node.nodeType === 1) {
      if (node.nodeName === 'BR') text += ' ';
      continue;
    }
    const start = node === range.startContainer ? range.startOffset : 0;
    const end = node === range.endContainer ? range.endOffset : node.length;
    if (end <= start) continue;
    const r = document.createRange();
    r.setStart(node, start);
    r.setEnd(node, end);
    text += node.data.slice(start, end);
    for (const c of r.getClientRects()) {
      if (c.width > 0.5 && c.height > 0.5 && c.height < pr.height * 0.5) {
        raw.push([c.left - pr.left, c.top - pr.top, c.width, c.height]);
      }
    }
  }
  // merge rects that sit on the same line
  raw.sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const merged = [];
  for (const r of raw) {
    const m = merged.find((o) => {
      const ov = Math.min(o[1] + o[3], r[1] + r[3]) - Math.max(o[1], r[1]);
      const minH = Math.min(o[3], r[3]);
      if (ov < minH * 0.5) return false;
      const gap = Math.max(r[0] - (o[0] + o[2]), o[0] - (r[0] + r[2]));
      return gap < minH * 0.8;
    });
    if (m) {
      const x1 = Math.min(m[0], r[0]), y1 = Math.min(m[1], r[1]);
      const x2 = Math.max(m[0] + m[2], r[0] + r[2]), y2 = Math.max(m[1] + m[3], r[1] + r[3]);
      m[0] = x1; m[1] = y1; m[2] = x2 - x1; m[3] = y2 - y1;
    } else merged.push([...r]);
  }
  const rd = (v) => Math.round(v * 1e5) / 1e5;
  const rects = merged.map(([x, y, w, h]) => {
    const fx = clamp(x / pr.width, 0, 1), fy = clamp(y / pr.height, 0, 1);
    return [rd(fx), rd(fy), rd(Math.min(w / pr.width, 1 - fx)), rd(Math.min(h / pr.height, 1 - fy))];
  });
  return { rects, text: text.replace(/\s+/g, ' ').trim() };
}

async function createHighlight(range, color) {
  const group = uid();
  const created = [];
  for (const p of R.pages) {
    if (!p.textDiv || !range.intersectsNode(p.textDiv)) continue;
    const { rects, text } = rangeOnPage(range, p);
    if (!rects.length) continue;
    created.push({ id: uid(), group, bookId: R.book.id, page: p.num, rects, text, color, note: '', createdAt: Date.now() });
  }
  if (!created.length) return [];
  await db.putMany('highlights', created);
  R.highlights.push(...created);
  indexHighlights();
  for (const h of created) renderHighlights(R.pages[h.page - 1]);
  settings.lastColor = color; saveSettings();
  refreshPanelIfOpen('highlights');
  return created;
}

const groupOf = (h) => R.highlights.filter((x) => (x.group || x.id) === (h.group || h.id));

async function updateGroup(h, patch) {
  const g = groupOf(h);
  for (const x of g) Object.assign(x, patch);
  await db.putMany('highlights', g);
  for (const page of new Set(g.map((x) => x.page))) renderHighlights(R.pages[page - 1]);
  refreshPanelIfOpen('highlights');
}

async function deleteGroup(h) {
  const g = groupOf(h);
  const ids = new Set(g.map((x) => x.id));
  for (const x of g) await db.del('highlights', x.id);
  R.highlights = R.highlights.filter((x) => !ids.has(x.id));
  indexHighlights();
  for (const page of new Set(g.map((x) => x.page))) renderHighlights(R.pages[page - 1]);
  refreshPanelIfOpen('highlights');
  toast('Highlight removed', { action: 'Undo', onAction: async () => {
    await db.putMany('highlights', g);
    R.highlights.push(...g);
    indexHighlights();
    for (const page of new Set(g.map((x) => x.page))) renderHighlights(R.pages[page - 1]);
    refreshPanelIfOpen('highlights');
  } });
}

async function editNote(h) {
  const g = groupOf(h);
  const holder = g.find((x) => x.note) || g[g.length - 1];
  const v = await promptDialog({
    title: holder.note ? 'Edit note' : 'Add note',
    quote: g.map((x) => x.text).join(' '),
    value: holder.note || '',
    multiline: true,
    placeholder: 'Your thoughts…',
  });
  if (v == null) return;
  holder.note = v.trim();
  await db.put('highlights', holder);
  renderHighlights(R.pages[holder.page - 1]);
  refreshPanelIfOpen('highlights');
  if (holder.note) toast('Note saved');
}

/* selection toolbar */
document.addEventListener('selectionchange', () => {
  clearTimeout(R.selTimer);
  R.selTimer = setTimeout(onSelection, 200);
});
function onSelection() {
  if (!R.open) return;
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) {
    if (!R.tbPointer) hideSelToolbar();
    return;
  }
  const range = sel.getRangeAt(0);
  if (!pagesEl.contains(range.commonAncestorContainer) || !sel.toString().trim()) return hideSelToolbar();
  R.selRange = range.cloneRange();
  hidePopover();
  showSelToolbar(range);
}
function showSelToolbar(range) {
  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  if (!rects.length) return;
  const first = rects[0], last = rects[rects.length - 1];
  for (const b of selToolbar.querySelectorAll('.swatch')) b.classList.toggle('current', b.dataset.color === settings.lastColor);
  selToolbar.hidden = false;
  const w = selToolbar.offsetWidth, h = selToolbar.offsetHeight;
  const minTop = R.chromeHidden ? 10 : topbar.offsetHeight + 8;
  let top = last.bottom + 16;
  if (top + h > innerHeight - 16) top = first.top - h - 56;
  top = clamp(top, minTop, innerHeight - h - 10);
  const cx = (Math.min(first.left, last.left) + Math.max(first.right, last.right)) / 2;
  selToolbar.style.top = top + 'px';
  selToolbar.style.left = clamp(cx - w / 2, 8, innerWidth - w - 8) + 'px';
}
function hideSelToolbar() { selToolbar.hidden = true; }

selToolbar.addEventListener('pointerdown', (e) => { e.preventDefault(); R.tbPointer = true; });
addEventListener('pointerup', () => setTimeout(() => { R.tbPointer = false; }, 400));
selToolbar.addEventListener('mousedown', (e) => e.preventDefault());
selToolbar.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b || !R.selRange) return;
  const color = b.dataset.color || settings.lastColor || 'yellow';
  const range = R.selRange;
  R.selRange = null;
  const created = await createHighlight(range, color);
  getSelection().removeAllRanges();
  hideSelToolbar();
  if (!created.length) return toast('Couldn’t highlight that selection');
  if (b.dataset.action === 'note') editNote(created[0]);
});

// Better drag-selection behaviour in the pdf.js text layer
pagesEl.addEventListener('pointerdown', (e) => {
  const tl = e.target.closest('.textLayer');
  if (tl) tl.classList.add('selecting');
});
addEventListener('pointerup', () => { for (const t of $$('.textLayer.selecting')) t.classList.remove('selecting'); });

/* highlight popover */
function showPopover(h, x, y) {
  R.popHl = h;
  hideSelToolbar();
  for (const d of $$('.hl.active')) d.classList.remove('active');
  for (const d of $$(`.hl[data-group="${h.group || h.id}"]`)) d.classList.add('active');
  for (const b of hlPopover.querySelectorAll('.swatch')) b.classList.toggle('current', b.dataset.color === h.color);
  const note = groupOf(h).map((x) => x.note).filter(Boolean).join('\n');
  const pn = hlPopover.querySelector('.pop-note');
  pn.hidden = !note;
  pn.textContent = note;
  hlPopover.querySelector('[data-action=note] span').textContent = note ? 'Edit note' : 'Note';
  hlPopover.hidden = false;
  const w = hlPopover.offsetWidth, hh = hlPopover.offsetHeight;
  let top = y + 18;
  if (top + hh > innerHeight - 12) top = y - hh - 18;
  hlPopover.style.top = clamp(top, 8, innerHeight - hh - 8) + 'px';
  hlPopover.style.left = clamp(x - w / 2, 8, innerWidth - w - 8) + 'px';
}
function hidePopover() {
  if (hlPopover.hidden) return;
  hlPopover.hidden = true;
  for (const d of $$('.hl.active')) d.classList.remove('active');
  R.popHl = null;
}
hlPopover.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  const h = R.popHl;
  if (!b || !h) return;
  if (b.dataset.color) {
    await updateGroup(h, { color: b.dataset.color });
    settings.lastColor = b.dataset.color; saveSettings();
    hidePopover();
  } else if (b.dataset.action === 'note') { hidePopover(); editNote(h); }
  else if (b.dataset.action === 'copy') {
    const text = groupOf(h).map((x) => x.text).join(' ');
    try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('Couldn’t copy'); }
    hidePopover();
  } else if (b.dataset.action === 'delete') { hidePopover(); deleteGroup(h); }
});

/* ================================================================
   Bookmarks
   ================================================================ */
async function toggleBookmark() {
  const n = R.current;
  const ex = R.bookmarks.get(n);
  if (ex) {
    await db.del('bookmarks', ex.id);
    R.bookmarks.delete(n);
    toast(`Bookmark removed from page ${n}`);
  } else {
    const bm = { id: uid(), bookId: R.book.id, page: n, title: chapterAt(n)?.title || '', createdAt: Date.now() };
    await db.put('bookmarks', bm);
    R.bookmarks.set(n, bm);
    toast(`Bookmarked page ${n}`);
  }
  renderMarks(R.pages[n - 1]);
  updatePageUI();
  refreshPanelIfOpen('bookmarks');
}
$('#bookmark-btn').onclick = toggleBookmark;

/* ================================================================
   Outline / TOC
   ================================================================ */
async function resolveDest(dest) {
  if (!dest) return null;
  const explicit = typeof dest === 'string' ? await R.pdf.getDestination(dest) : dest;
  if (!Array.isArray(explicit)) return null;
  const ref = explicit[0];
  if (ref && typeof ref === 'object') return (await R.pdf.getPageIndex(ref)) + 1;
  if (Number.isInteger(ref)) return ref + 1;
  return null;
}
async function loadOutline(gen) {
  let outline = null;
  try { outline = await R.pdf.getOutline(); } catch {}
  if (gen !== R.gen || !outline?.length) return;
  const flat = [];
  const walk = async (items, depth) => {
    for (const it of items) {
      let page = null;
      try { page = await resolveDest(it.dest); } catch {}
      flat.push({ title: (it.title || '').trim() || 'Untitled', depth, page });
      if (it.items?.length) await walk(it.items, depth + 1);
    }
  };
  await walk(outline, 0);
  if (gen !== R.gen) return;
  R.outline = flat;
  R.chapters = flat.filter((c) => c.page).map((c, i) => ({ ...c, i })).sort((a, b) => a.page - b.page || a.i - b.i);
  updatePageUI();
  refreshPanelIfOpen('toc');
}

/* ================================================================
   Side panel
   ================================================================ */
function openPanel(tab) {
  hideSelToolbar(); hidePopover(); settingsSheet.hidden = true;
  if (!panel.classList.contains('open')) {
    panel.classList.add('open');
    panel.setAttribute('aria-hidden', 'false');
    $('#scrim').hidden = false;
    pushOverlay('panel', () => {
      panel.classList.remove('open');
      panel.setAttribute('aria-hidden', 'true');
      $('#scrim').hidden = true;
    });
  }
  switchTab(tab);
}
function closePanelIfNarrow() {
  if (isNarrow() && panel.classList.contains('open') && topOverlay() === 'panel') closeTop();
}
$('#panel-btn').onclick = () => openPanel(R.tab === 'search' ? 'toc' : R.tab);
$('#search-btn').onclick = () => openPanel('search');
$('#panel-close').onclick = () => closeTop();
$('#scrim').onclick = () => closeTop();
for (const t of $$('.tabs button')) t.onclick = () => switchTab(t.dataset.tab);

function switchTab(tab) {
  R.tab = tab;
  for (const t of $$('.tabs button')) t.classList.toggle('active', t.dataset.tab === tab);
  for (const p of $$('.tab-pane')) p.classList.toggle('active', p.dataset.pane === tab);
  if (tab === 'toc') renderToc();
  if (tab === 'bookmarks') renderBookmarks();
  if (tab === 'highlights') renderHlList();
  if (tab === 'search') { const i = $('#search-input'); i.focus(); i.select(); }
}
function refreshPanelIfOpen(tab) {
  if (panel.classList.contains('open') && R.tab === tab) switchTab(tab);
}

function renderToc() {
  const ul = $('#toc-list');
  if (!R.outline.length) {
    ul.innerHTML = `<li class="empty-note">This PDF doesn’t include a table of contents.<br>Use bookmarks to mark chapters yourself.</li>`;
    return;
  }
  ul.innerHTML = R.outline.map((c, i) => `
    <li><button class="item toc-item d${Math.min(c.depth, 3)}" data-i="${i}" ${c.page ? '' : 'disabled'}>
      <span class="grow">${esc(c.title)}</span><span class="pg">${c.page ?? ''}</span>
    </button></li>`).join('');
  markCurrentToc(true);
}
function markCurrentToc(scroll = false) {
  const ch = chapterAt(R.current);
  let cur = null;
  for (const b of $$('#toc-list .toc-item')) {
    const c = R.outline[+b.dataset.i];
    const on = ch && c.title === ch.title && c.page === ch.page;
    b.classList.toggle('current', !!on);
    if (on) cur = b;
  }
  if (scroll && cur) cur.scrollIntoView({ block: 'center' });
}
$('#toc-list').addEventListener('click', (e) => {
  const b = e.target.closest('.toc-item');
  if (!b) return;
  const c = R.outline[+b.dataset.i];
  if (c?.page) { goToPage(c.page); closePanelIfNarrow(); }
});

function renderBookmarks() {
  const ul = $('#bm-list');
  const list = [...R.bookmarks.values()].sort((a, b) => a.page - b.page);
  if (!list.length) {
    ul.innerHTML = `<li class="empty-note">No bookmarks yet.<br>Tap the ribbon at the top to bookmark the page you’re on.</li>`;
    return;
  }
  ul.innerHTML = list.map((b) => `
    <li><button class="item bm-item" data-page="${b.page}">
      <span class="grow"><div class="title">${esc(b.title || chapterAt(b.page)?.title || 'Page ' + b.page)}</div>
      <div class="sub">Page ${b.page} · ${relTime(b.createdAt)}</div></span>
    </button><button class="icon-btn small del" data-del="${b.page}" aria-label="Delete bookmark">${icon('x')}</button></li>`).join('');
}
$('#bm-list').addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del]');
  if (del) {
    const page = +del.dataset.del;
    const bm = R.bookmarks.get(page);
    await db.del('bookmarks', bm.id);
    R.bookmarks.delete(page);
    renderMarks(R.pages[page - 1]);
    updatePageUI();
    renderBookmarks();
    return;
  }
  const b = e.target.closest('.bm-item');
  if (b) { goToPage(+b.dataset.page); closePanelIfNarrow(); }
});

function hlGroups() {
  const groups = new Map();
  for (const h of R.highlights) {
    const k = h.group || h.id;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(h);
  }
  return [...groups.values()].map((g) => {
    g.sort((a, b) => a.page - b.page);
    return { first: g[0], color: g[0].color, page: g[0].page, y: g[0].rects[0]?.[1] || 0,
      text: g.map((x) => x.text).join(' '), note: g.map((x) => x.note).filter(Boolean).join('\n'), createdAt: g[0].createdAt };
  }).sort((a, b) => a.page - b.page || a.y - b.y);
}

function renderHlList() {
  const f = R.hlFilter;
  for (const c of $$('#hl-filter .chip')) c.classList.toggle('active', c.dataset.color === f);
  const all = hlGroups();
  const list = all.filter((g) => f === 'all' || (f === 'notes' ? g.note : g.color === f));
  const ul = $('#hl-list');
  if (!all.length) {
    ul.innerHTML = `<li class="empty-note">No highlights yet.<br>Press and hold on text to select it, then pick a color.</li>`;
    return;
  }
  if (!list.length) { ul.innerHTML = `<li class="empty-note">Nothing matches this filter.</li>`; return; }
  ul.innerHTML = list.map((g) => `
    <li><button class="item hl-item ${g.color}" data-id="${g.first.id}">
      <span class="grow">
        <div class="quote-text">${esc(g.text)}</div>
        ${g.note ? `<div class="note-text">${esc(g.note)}</div>` : ''}
        <div class="sub">Page ${g.page}${chapterAt(g.page) ? ' · ' + esc(chapterAt(g.page).title) : ''}</div>
      </span>
    </button></li>`).join('');
}
$('#hl-filter').addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (!c) return;
  R.hlFilter = c.dataset.color;
  renderHlList();
});
$('#hl-list').addEventListener('click', (e) => {
  const b = e.target.closest('.hl-item');
  if (!b) return;
  const h = R.highlights.find((x) => x.id === b.dataset.id);
  if (h) jumpToHighlight(h);
});

function jumpToHighlight(h) {
  setBackJump();
  applyAnchor({ i: h.page - 1, f: h.rects[0]?.[1] || 0, yInView: viewer.clientHeight * 0.3 });
  updateCurrent();
  R.backLanding = R.current;
  closePanelIfNarrow();
  setTimeout(() => {
    for (const d of $$(`.hl[data-group="${h.group || h.id}"]`)) {
      d.classList.remove('flash'); void d.offsetWidth; d.classList.add('flash');
    }
  }, 120);
}

$('#export-hl').onclick = async () => {
  if (!R.highlights.length) return toast('No highlights to export yet');
  await shareOrDownload(safeName(R.book.title) + ' — highlights.md', highlightsMarkdown(R.book, R.highlights, R.chapters), 'text/markdown');
};

function highlightsMarkdown(book, highlights, chapters) {
  const chapterFor = (n) => { let c = null; for (const x of chapters) { if (x.page <= n) c = x; else break; } return c; };
  const groups = new Map();
  for (const h of highlights) {
    const k = h.group || h.id;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(h);
  }
  const items = [...groups.values()].map((g) => {
    g.sort((a, b) => a.page - b.page);
    return { page: g[0].page, y: g[0].rects[0]?.[1] || 0, color: g[0].color, text: g.map((x) => x.text).join(' '), note: g.map((x) => x.note).filter(Boolean).join('\n') };
  }).sort((a, b) => a.page - b.page || a.y - b.y);
  const lines = [`# ${book.title}`];
  if (book.author) lines.push(`*${book.author}*`);
  lines.push('', `${items.length} highlight${items.length === 1 ? '' : 's'} · exported from Folio on ${new Date().toLocaleDateString()}`, '');
  let lastCh = undefined;
  for (const it of items) {
    const ch = chapters.length ? chapterFor(it.page) : null;
    if (chapters.length && ch?.title !== lastCh) { lines.push(`## ${ch?.title || 'Front matter'}`, ''); lastCh = ch?.title; }
    lines.push(`> ${it.text}`, `>`, `> — page ${it.page} · ${it.color}`, '');
    if (it.note) lines.push(`**Note:** ${it.note.replace(/\n/g, '  \n')}`, '');
  }
  return lines.join('\n');
}

/* ================================================================
   Search
   ================================================================ */
async function pageText(n) {
  if (R.textCache.has(n)) return R.textCache.get(n);
  const page = await R.pdf.getPage(n);
  const tc = await page.getTextContent({ disableNormalization: true });
  const s = tc.items.map((it) => (it.str || '') + (it.hasEOL ? ' ' : '')).join('');
  R.textCache.set(n, s);
  return s;
}

$('#search-form').addEventListener('submit', (e) => {
  e.preventDefault();
  $('#search-input').blur();
  runSearch($('#search-input').value);
});
let searchDebounce;
$('#search-input').addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runSearch($('#search-input').value), 450);
});

async function runSearch(q) {
  const token = ++R.searchToken;
  q = q.trim();
  const ul = $('#search-list');
  const status = $('#search-status');
  ul.innerHTML = '';
  if (q.length < 2) { status.textContent = q ? 'Type at least 2 characters' : ''; return; }
  const ql = q.toLowerCase();
  const N = R.pages.length;
  let count = 0;
  const gen = R.gen;
  for (let n = 1; n <= N && count < 500; n++) {
    let t;
    try { t = await pageText(n); } catch { continue; }
    if (token !== R.searchToken || gen !== R.gen) return;
    const tl = t.toLowerCase();
    let idx = tl.indexOf(ql), k = 0;
    const items = [];
    while (idx !== -1 && count < 500) {
      const before = t.slice(Math.max(0, idx - 45), idx);
      const after = t.slice(idx + q.length, idx + q.length + 70);
      items.push(`<li><button class="item search-item" data-page="${n}" data-k="${k}">
        <span class="grow snip">${idx > 45 ? '…' : ''}${esc(before)}<mark>${esc(t.slice(idx, idx + q.length))}</mark>${esc(after)}…</span>
        <span class="pg">${n}</span></button></li>`);
      count++; k++;
      idx = tl.indexOf(ql, idx + ql.length);
    }
    if (items.length) ul.insertAdjacentHTML('beforeend', items.join(''));
    if (n % 8 === 0 || n === N) status.textContent = `Searching… page ${n} of ${N} · ${count} found`;
  }
  status.textContent = count ? `${count}${count >= 500 ? '+' : ''} result${count === 1 ? '' : 's'} for “${q}”` : `No results for “${q}”`;
}

$('#search-list').addEventListener('click', async (e) => {
  const b = e.target.closest('.search-item');
  if (!b) return;
  const n = +b.dataset.page, k = +b.dataset.k;
  const q = $('#search-input').value.trim();
  goToPage(n);
  closePanelIfNarrow();
  const p = R.pages[n - 1];
  if (await whenTextReady(p)) flashSearchHit(p, q, k);
});

function flashSearchHit(p, q, k) {
  if (!p.textDiv) return;
  const segs = [];
  let s = '';
  const walker = document.createTreeWalker(p.textDiv, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  let node;
  while ((node = walker.nextNode())) {
    if (node.nodeType === 1) { if (node.nodeName === 'BR') s += ' '; continue; }
    segs.push({ node, start: s.length });
    s += node.data;
  }
  const sl = s.toLowerCase(), ql = q.toLowerCase();
  let idx = -1;
  for (let i = 0; i <= k; i++) { idx = sl.indexOf(ql, idx + (i ? ql.length : 0)); if (idx === -1) return; }
  const locate = (g, isEnd) => {
    for (let i = segs.length - 1; i >= 0; i--) {
      const sg = segs[i];
      if (isEnd ? sg.start < g : sg.start <= g) return { node: sg.node, off: Math.min(g - sg.start, sg.node.length) };
    }
    return null;
  };
  const a = locate(idx, false), b = locate(idx + ql.length, true);
  if (!a || !b) return;
  const range = document.createRange();
  try { range.setStart(a.node, a.off); range.setEnd(b.node, b.off); } catch { return; }
  const pr = p.el.getBoundingClientRect();
  const rects = [...range.getClientRects()].filter((r) => r.width > 0.5);
  if (!rects.length) return;
  // Make sure the hit is on screen
  const r0 = rects[0];
  const vr = viewer.getBoundingClientRect();
  if (r0.top < vr.top + R.topPad || r0.bottom > vr.bottom - 80) {
    R.programmatic = true;
    viewer.scrollTop += r0.top - vr.top - viewer.clientHeight * 0.35;
  }
  for (const r of rects) {
    const d = document.createElement('div');
    d.className = 'search-hit';
    d.style.cssText = `left:${(r.left - pr.left) / pr.width * 100}%;top:${(r.top - pr.top) / pr.height * 100}%;width:${r.width / pr.width * 100}%;height:${r.height / pr.height * 100}%`;
    p.hlLayer.append(d);
    setTimeout(() => d.remove(), 2700);
  }
}

/* ================================================================
   Reader display settings
   ================================================================ */
$('#settings-btn').onclick = () => {
  const open = settingsSheet.hidden;
  hideSelToolbar(); hidePopover();
  settingsSheet.hidden = !open;
  if (open) {
    $('#opt-invert').checked = settings.invert;
    $('#opt-tapturn').checked = settings.tapTurn;
    $('#opt-awake').checked = settings.keepAwake;
    $('#opt-autohide').checked = settings.autoHide;
  }
};
for (const seg of [$('#theme-seg'), $('#lib-theme-seg')]) {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    settings.theme = b.dataset.theme; saveSettings(); applyTheme();
  });
}
$('#opt-invert').onchange = (e) => { settings.invert = e.target.checked; saveSettings(); applyTheme(); };
$('#opt-tapturn').onchange = (e) => { settings.tapTurn = e.target.checked; saveSettings(); if (settings.tapTurn) toast('Tap the left or right edge of the screen to turn pages'); };
$('#opt-awake').onchange = (e) => { settings.keepAwake = e.target.checked; saveSettings(); settings.keepAwake ? requestWake() : releaseWake(); };
$('#opt-autohide').onchange = (e) => { settings.autoHide = e.target.checked; saveSettings(); };

async function requestWake() {
  try {
    if (settings.keepAwake && R.open && 'wakeLock' in navigator && !R.wake) {
      R.wake = await navigator.wakeLock.request('screen');
      R.wake.addEventListener('release', () => { R.wake = null; });
    }
  } catch {}
}
function releaseWake() { R.wake?.release().catch(() => {}); R.wake = null; }

/* ================================================================
   Boot
   ================================================================ */
async function init() {
  applyTheme();
  await loadLibrary();
  const last = ls.get('openBook');
  if (last && settings.resume && books.some((b) => b.id === last)) openBook(last);
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW registration failed', e));
  }
}
init();

// Expose a few things for debugging/tests
window.__folio = { get R() { return R; }, db, importFiles, openBook };

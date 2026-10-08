/* Library: books, albums, importing + identifying PDFs, backup & restore. */
import { db } from './db.js';
import { openPdf } from './pdf.js';
import { identify, titleFromFileName, KINDS } from './identify.js';
import {
  $, $$, esc, icon, uid, ls, relTime, fmtDuration, plural, toast, busy,
  pushOverlay, closeTop, openModal, promptDialog, confirmDialog, actionSheet, shareOrDownload,
} from './ui.js';
import { settings, saveSettings } from './settings.js';

let hooks = {};
export function initLibrary(h) { hooks = h; }

let books = [];
let albums = [];
let scope = 'all';                 // 'all' | 'unsorted' | <album id>
let selecting = false;
const selected = new Set();

const libraryEl = $('#library');
const gridEl = $('#book-grid');
const filterEl = $('#lib-filter');

/* ================================================================
   Data
   ================================================================ */
export async function loadLibrary() {
  [books, albums] = await Promise.all([db.all('books'), db.all('albums')]);
  albums.sort((a, b) => a.createdAt - b.createdAt);
  if (scope !== 'all' && scope !== 'unsorted' && !albums.some((a) => a.id === scope)) scope = 'all';
  renderLibrary();
}
export const getBooks = () => books;

const byRecent = (a, b) => (b.lastOpened || b.addedAt) - (a.lastOpened || a.addedAt);
const SORTS = {
  recent: { label: 'Recently read', fn: byRecent },
  title: { label: 'Title', fn: (a, b) => a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }) },
  author: { label: 'Author', fn: (a, b) => (a.author || '￿').localeCompare(b.author || '￿', undefined, { sensitivity: 'base' }) || byRecent(a, b) },
  added: { label: 'Date added', fn: (a, b) => b.addedAt - a.addedAt },
  progress: { label: 'Progress', fn: (a, b) => pct(b) - pct(a) || byRecent(a, b) },
};
const sortFn = () => (SORTS[settings.sort] || SORTS.recent).fn;

const albumOf = (b) => albums.find((a) => a.id === b.albumId);
const inAlbum = (id) => books.filter((b) => b.albumId === id && albums.some((a) => a.id === id));
const unsorted = () => books.filter((b) => !albumOf(b));
const findAlbumByName = (n) => albums.find((a) => a.name.toLowerCase() === n.trim().toLowerCase());

async function makeAlbum(name) {
  const a = { id: uid(), name: name.trim(), createdAt: Date.now() };
  await db.put('albums', a);
  albums.push(a);
  return a;
}

async function newAlbumPrompt(title = 'New album') {
  const v = await promptDialog({ title, placeholder: 'e.g. Work, Fiction, To read', okText: 'Create' });
  const name = v?.trim();
  if (!name) return null;
  const dup = findAlbumByName(name);
  if (dup) { toast(`You already have an album called “${dup.name}”`); return dup; }
  return makeAlbum(name);
}

async function moveBooks(ids, albumId) {
  const list = ids.map((id) => books.find((b) => b.id === id)).filter(Boolean);
  for (const b of list) { if (albumId) b.albumId = albumId; else delete b.albumId; }
  await db.putMany('books', list);
  const name = albums.find((a) => a.id === albumId)?.name;
  toast(name ? `Moved ${plural(list.length, 'book')} to “${name}”` : `${plural(list.length, 'book')} marked unsorted`);
  if (selecting) closeTop(); else renderLibrary();
}

function pct(book) {
  if (!book.pageCount) return 0;
  const seen = book.lastSeen || book.lastPage || 1;
  if (seen >= book.pageCount) return 100;
  return Math.floor((seen - 1) / Math.max(1, book.pageCount - 1) * 100);
}

/* ================================================================
   Rendering
   ================================================================ */
const coverHtml = (b) => b.cover
  ? `<img src="${b.cover}" alt="" loading="lazy" draggable="false">`
  : `<div class="fallback">${esc(b.title)}</div>`;

function scopedBooks() {
  if (scope === 'all') return books;
  if (scope === 'unsorted') return unsorted();
  return inAlbum(scope);
}

function collage(list) {
  const covers = [...list].sort(byRecent).filter((b) => b.cover).slice(0, 4);
  if (!covers.length) return `<div class="collage c0">${icon('folder')}</div>`;
  return `<div class="collage c${covers.length}">${covers.map((b) => `<img src="${b.cover}" alt="" draggable="false">`).join('')}</div>`;
}

export function renderLibrary() {
  const q = filterEl.value.trim().toLowerCase();
  const album = albums.find((a) => a.id === scope);
  const sub = scopedBooks();

  $('#lib-title').textContent = scope === 'all' ? 'Library' : scope === 'unsorted' ? 'Unsorted' : album?.name || 'Library';
  $('#album-back').hidden = scope === 'all';
  $('#album-menu-btn').hidden = !album;
  libraryEl.classList.toggle('in-album', scope !== 'all');
  libraryEl.classList.toggle('selecting', selecting);

  const total = books.reduce((s, b) => s + (b.readSeconds || 0), 0);
  $('#lib-sub').textContent = scope === 'all'
    ? (books.length ? `${plural(books.length, 'book')}${total >= 60 ? ` · ${fmtDuration(total)} read` : ''}` : '')
    : plural(sub.length, 'book');

  $('#empty').hidden = books.length > 0;
  $('#lib-toolbar').hidden = books.length < 6;
  $('#books-head').hidden = !books.length;

  // Continue reading
  const recent = books.filter((b) => b.lastOpened).sort(byRecent)[0];
  const cont = $('#continue');
  if (recent && scope === 'all' && !q && !selecting) {
    const p = pct(recent);
    cont.hidden = false;
    cont.dataset.id = recent.id;
    cont.innerHTML = `
      <div class="cover">${coverHtml(recent)}</div>
      <div class="grow">
        <div class="eyebrow">Continue reading</div>
        <h2>${esc(recent.title)}</h2>
        <div class="meta">${recent.author ? esc(recent.author) + ' · ' : ''}Page ${recent.lastPage} of ${recent.pageCount} · ${relTime(recent.lastOpened)}</div>
        <div class="progress"><i style="width:${p}%"></i></div>
      </div>
      <span class="resume btn primary">Resume</span>`;
  } else cont.hidden = true;

  // Albums row
  const showAlbums = scope === 'all' && !q && books.length > 0 && !selecting;
  $('#albums-section').hidden = !showAlbums;
  if (showAlbums) {
    const tiles = albums.map((a) => {
      const list = inAlbum(a.id);
      return `<button class="album" data-album="${a.id}">${collage(list)}<span class="album-name">${esc(a.name)}</span><span class="album-count">${plural(list.length, 'book')}</span></button>`;
    });
    const un = unsorted();
    if (albums.length && un.length) {
      tiles.push(`<button class="album" data-album="unsorted">${collage(un)}<span class="album-name">Unsorted</span><span class="album-count">${plural(un.length, 'book')}</span></button>`);
    }
    tiles.push(`<button class="album new" data-new-album><div class="collage cplus">${icon('folder-plus')}</div><span class="album-name">New album</span><span class="album-count">&nbsp;</span></button>`);
    $('#album-row').innerHTML = tiles.join('');
  }

  // Section header
  $('#books-title').textContent = q ? 'Results' : scope === 'all' ? (albums.length ? 'All books' : 'Books') : 'Books';
  $('#sort-label').textContent = (SORTS[settings.sort] || SORTS.recent).label;
  $('#select-btn span').textContent = selecting ? 'Done' : 'Select';
  $('#select-btn').hidden = !sub.length;

  // Grid
  const list = (q ? sub.filter((b) => (b.title + ' ' + (b.author || '') + ' ' + (b.fileName || '') + ' ' + (b.ident?.kindLabel || '') + ' ' + (albumOf(b)?.name || '')).toLowerCase().includes(q)) : [...sub]).sort(sortFn());
  gridEl.innerHTML = list.map((b) => {
    const p = pct(b);
    const status = !b.lastOpened ? plural(b.pageCount, 'page') : p >= 100 ? 'Finished' : `${p}%`;
    return `
    <div class="book${selected.has(b.id) ? ' picked' : ''}" data-id="${esc(b.id)}">
      <div class="cover">${coverHtml(b)}</div>
      ${!b.lastOpened && !selecting ? '<span class="badge-new">NEW</span>' : ''}
      ${selecting ? `<span class="check">${icon('check')}</span>` : `<button class="more" aria-label="Options for ${esc(b.title)}">${icon('more')}</button>`}
      <h3>${esc(b.title)}</h3>
      ${b.author ? `<div class="by">${esc(b.author)}</div>` : ''}
      ${b.lastOpened ? `<div class="progress"><i style="width:${p}%"></i></div>` : ''}
      <div class="meta"><span>${status}</span><span>${b.lastOpened ? relTime(b.lastOpened) : ''}</span></div>
    </div>`;
  }).join('') || (q ? `<p class="muted note-block">No books match “${esc(q)}”.</p>`
    : books.length ? `<p class="muted note-block">${scope === 'unsorted' ? 'Everything is sorted into an album.' : 'This album is empty. Use <b>Select</b> in the library, then <b>Move</b>, to add books here.'}</p>` : '');

  $('#select-bar').hidden = !selecting;
  $('#sel-count').textContent = selected.size ? `${selected.size} selected` : 'Select books';
  for (const b of $$('#select-bar [data-needs-pick]')) b.disabled = !selected.size;
}

/* ================================================================
   Interactions
   ================================================================ */
gridEl.addEventListener('click', (e) => {
  const card = e.target.closest('.book');
  if (!card) return;
  const book = books.find((b) => b.id === card.dataset.id);
  if (!book) return;
  if (selecting) {
    selected.has(book.id) ? selected.delete(book.id) : selected.add(book.id);
    card.classList.toggle('picked', selected.has(book.id));
    $('#sel-count').textContent = selected.size ? `${selected.size} selected` : 'Select books';
    for (const b of $$('#select-bar [data-needs-pick]')) b.disabled = !selected.size;
  } else if (e.target.closest('.more')) bookMenu(book);
  else hooks.openBook(book.id);
});
$('#continue').addEventListener('click', (e) => hooks.openBook(e.currentTarget.dataset.id));
$('#continue').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); hooks.openBook(e.currentTarget.dataset.id); } });
filterEl.addEventListener('input', renderLibrary);

$('#album-row').addEventListener('click', async (e) => {
  if (e.target.closest('[data-new-album]')) { const a = await newAlbumPrompt(); if (a) { renderLibrary(); openAlbum(a.id); } return; }
  const tile = e.target.closest('[data-album]');
  if (tile) openAlbum(tile.dataset.album);
});

function openAlbum(id) {
  scope = id;
  pushOverlay('album', () => { scope = 'all'; libraryEl.scrollTop = 0; renderLibrary(); });
  libraryEl.scrollTop = 0;
  renderLibrary();
}
$('#album-back').onclick = () => closeTop();

$('#album-menu-btn').onclick = () => {
  const album = albums.find((a) => a.id === scope);
  if (!album) return;
  actionSheet(album.name, [
    { label: 'Rename album', icon: 'pencil', run: async () => {
      const v = await promptDialog({ title: 'Rename album', value: album.name });
      const name = v?.trim();
      if (!name) return;
      const dup = findAlbumByName(name);
      if (dup && dup.id !== album.id) return toast(`You already have an album called “${dup.name}”`);
      album.name = name;
      await db.put('albums', album);
      renderLibrary();
    } },
    { label: 'Delete album', icon: 'trash', danger: true, run: async () => {
      const n = inAlbum(album.id).length;
      const ok = await confirmDialog({ title: 'Delete this album?', message: `“${album.name}” will be deleted. ${n ? `Its ${plural(n, 'book')} stay in your library as unsorted.` : ''}`, okText: 'Delete', danger: true });
      if (!ok) return;
      const list = inAlbum(album.id);
      for (const b of list) delete b.albumId;
      await db.putMany('books', list);
      await db.del('albums', album.id);
      albums = albums.filter((a) => a.id !== album.id);
      await closeTop();                               // leave the album view
      toast('Album deleted');
    } },
  ]);
};

$('#sort-btn').onclick = () => {
  actionSheet('Sort by', Object.entries(SORTS).map(([key, s]) => ({
    label: s.label, icon: 'sort', check: settings.sort === key,
    run: () => { settings.sort = key; saveSettings(); renderLibrary(); },
  })));
};

/* ---------- select mode ---------- */
$('#select-btn').onclick = () => {
  if (selecting) return void closeTop();
  selecting = true;
  selected.clear();
  pushOverlay('select', () => { selecting = false; selected.clear(); renderLibrary(); });
  renderLibrary();
};
$('#sel-move').onclick = () => { if (selected.size) albumPicker([...selected]); };
$('#sel-remove').onclick = async () => {
  const ids = [...selected];
  if (!ids.length) return;
  const ok = await confirmDialog({ title: `Remove ${plural(ids.length, 'book')}?`, message: 'They and their bookmarks will be deleted from this device.', okText: 'Remove', danger: true });
  if (!ok) return;
  for (const id of ids) { await db.deleteBook(id); if (ls.get('openBook') === id) ls.del('openBook'); }
  await closeTop();
  await loadLibrary();
  toast(`${plural(ids.length, 'book')} removed`);
};

function albumPicker(ids) {
  const homes = new Set(ids.map((id) => books.find((b) => b.id === id)?.albumId || ''));
  const common = homes.size === 1 ? [...homes][0] : null;
  actionSheet(ids.length > 1 ? `Move ${plural(ids.length, 'book')} to…` : 'Move to album', [
    ...albums.map((a) => ({ label: a.name, icon: 'folder', check: common === a.id, run: () => moveBooks(ids, a.id) })),
    { label: 'Unsorted', icon: 'book', check: common === '', run: () => moveBooks(ids, null) },
    { label: 'New album…', icon: 'folder-plus', run: async () => { const a = await newAlbumPrompt(); if (a) moveBooks(ids, a.id); } },
  ]);
}

function bookMenu(book) {
  actionSheet(book.title, [
    { label: 'Move to album', icon: 'folder', sub: albumOf(book)?.name, run: () => albumPicker([book.id]) },
    { label: 'Edit details', icon: 'pencil', run: () => openIntake([book], 'edit') },
    { label: 'Remove from library', icon: 'trash', danger: true, run: async () => {
      const ok = await confirmDialog({ title: 'Remove this book?', message: `“${book.title}” and its bookmarks will be deleted from this device.`, okText: 'Remove', danger: true });
      if (!ok) return;
      await db.deleteBook(book.id);
      if (ls.get('openBook') === book.id) ls.del('openBook');
      await loadLibrary();
      toast('Book removed');
    } },
  ]);
}

/* ================================================================
   Importing & identifying
   ================================================================ */
const fileInput = $('#file-input');
$('#add-book-btn').onclick = () => fileInput.click();
$('#empty-add-btn').onclick = () => fileInput.click();
fileInput.onchange = () => { importFiles(fileInput.files); fileInput.value = ''; };

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

export async function importFiles(fileList) {
  const files = [...fileList].filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!files.length) return toast('Please choose a PDF file');
  navigator.storage?.persist?.().catch(() => {});
  let added = 0, dup = 0, failed = 0, lastErr = '';
  const freshIds = [];
  const intoAlbum = albums.find((a) => a.id === scope)?.id;     // adding from inside an album files it there
  for (const f of files) {
    const step = (what) => busy(true, files.length > 1 ? `${what} ${added + dup + failed + 1} of ${files.length}…` : `${what}…`);
    step('Adding');
    let pdf;
    try {
      const buf = await f.arrayBuffer();
      pdf = await openPdf(new Uint8Array(buf.slice(0)));
      const id = pdf.fingerprints[0];
      if (await db.get('books', id)) { dup++; continue; }
      const meta = await pdf.getMetadata().catch(() => null);
      step('Identifying');
      const ident = await identify(pdf, { fileName: f.name, info: meta?.info || {} }).catch((e) => { console.warn(e); return null; });
      const cover = await makeCover(pdf);
      await db.put('files', buf, id);
      const book = {
        id, title: ident?.title || titleFromFileName(f.name), author: ident?.author || '',
        fileName: f.name, size: f.size, pageCount: pdf.numPages,
        addedAt: Date.now(), lastOpened: 0, lastPage: 1, lastSeen: 1, lastFrac: 0, readSeconds: 0, cover,
        ident: ident && { kind: ident.kind, kindLabel: ident.kindLabel, confidence: ident.confidence, albumName: ident.albumName, isbn: ident.isbn, year: ident.year, scanned: ident.scanned },
      };
      if (intoAlbum) book.albumId = intoAlbum;
      // Apply progress / title / album from a backup that was restored before this book was added
      const pending = ls.get('pendingProgress', {});
      const p = pending[id];
      if (p) {
        if (p.title) book.title = p.title;
        if (p.author != null) book.author = p.author;
        if (p.albumId) book.albumId = p.albumId;
        Object.assign(book, { lastPage: p.lastPage || 1, lastSeen: p.lastSeen || p.lastPage || 1, readSeconds: p.readSeconds || 0, lastOpened: p.lastOpened || 0 });
        delete pending[id]; ls.set('pendingProgress', pending);
      }
      await db.put('books', book);
      added++; freshIds.push(id);
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

  // If you've already made an album with the suggested name, file into it automatically when not asking.
  const fresh = freshIds.map((id) => books.find((b) => b.id === id)).filter(Boolean);
  if (!settings.review) {
    const auto = fresh.filter((b) => !b.albumId && b.ident?.albumName && findAlbumByName(b.ident.albumName));
    for (const b of auto) b.albumId = findAlbumByName(b.ident.albumName).id;
    await db.putMany('books', auto);
    if (auto.length) renderLibrary();
  }

  const parts = [];
  if (added) parts.push(`Added ${plural(added, 'book')}`);
  if (dup) parts.push(`${dup} already in your library`);
  if (failed) parts.push(failed === 1 ? lastErr : `${failed} failed`);
  if (fresh.length && settings.review) {
    if (dup || failed) toast(parts.join(' · '), { ms: 3500 });
    openIntake(fresh, 'new');
  } else if (fresh.length === 1) {
    toast(parts.join(' · '), { action: 'Read now', onAction: () => hooks.openBook(fresh[0].id) });
  } else toast(parts.join(' · '));
  return fresh;
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

/* ================================================================
   Review sheet: confirm what we found, file into albums
   ================================================================ */
const intakeEl = $('#intake');
let intakeRows = [];
let intakeMode = 'new';

function albumOptions(selectedValue, suggestion) {
  const opts = [`<option value="">Unsorted</option>`];
  for (const a of albums) opts.push(`<option value="album:${esc(a.id)}">${esc(a.name)}</option>`);
  if (suggestion && !findAlbumByName(suggestion)) opts.push(`<option value="new:${esc(suggestion)}">＋ ${esc(suggestion)} (new)</option>`);
  opts.push(`<option value="__new__">＋ New album…</option>`);
  const html = opts.join('');
  return html.replace(`value="${selectedValue}"`, `value="${selectedValue}" selected`);
}

function suggestionValue(b) {
  const name = b.ident?.albumName;
  if (!name) return '';
  const a = findAlbumByName(name);
  return a ? `album:${a.id}` : `new:${name}`;
}

function openIntake(list, mode) {
  intakeMode = mode;
  const isNew = mode === 'new';
  $('#intake-title').textContent = isNew ? (list.length === 1 ? 'New book' : `${list.length} new books`) : 'Edit details';
  $('#intake-intro').textContent = isNew ? 'We looked inside each PDF. Check the details and pick an album to keep things tidy.' : '';
  $('#intake-intro').hidden = !isNew;
  $('#intake-suggest').hidden = !isNew || !list.some((b) => b.ident?.albumName);
  $('#intake-done').textContent = isNew ? 'Done' : 'Save';
  intakeRows = list;
  $('#intake-list').innerHTML = list.map((b) => {
    const id = b.ident || {};
    const own = b.albumId ? `album:${b.albumId}` : '';
    const pre = isNew && !own ? (findAlbumByName(id.albumName || '') ? suggestionValue(b) : '') : own;
    const sug = suggestionValue(b);
    const tags = [
      id.kindLabel && `<span class="tag kind">${esc(id.kindLabel)}${id.confidence === 'low' ? '?' : ''}</span>`,
      id.scanned && `<span class="tag">Scanned</span>`,
      `<span class="tag">${plural(b.pageCount, 'page')}</span>`,
      id.isbn && `<span class="tag">ISBN ${esc(id.isbn)}</span>`,
      id.year && `<span class="tag">${id.year}</span>`,
    ].filter(Boolean).join('');
    return `
    <div class="intake-row" data-id="${esc(b.id)}">
      <div class="cover">${coverHtml(b)}</div>
      <div class="fields">
        <input class="text-input compact" data-f="title" value="${esc(b.title)}" aria-label="Title" autocomplete="off">
        <input class="text-input compact" data-f="author" value="${esc(b.author || '')}" placeholder="Author" aria-label="Author" autocomplete="off">
        <div class="tags">${tags}</div>
        <label class="album-select">${icon('folder')}<select data-f="album" aria-label="Album">${albumOptions(pre, id.albumName)}</select></label>
        ${isNew && sug && sug !== pre ? `<button class="suggest" data-suggest="${esc(sug)}">${icon('sparkle')}<span>Suggested: ${esc(id.albumName)}</span></button>` : ''}
      </div>
    </div>`;
  }).join('');
  openModal(intakeEl);
}

function setRowAlbum(row, value) {
  const sel = $('select[data-f=album]', row);
  if (![...sel.options].some((o) => o.value === value)) {
    const name = value.slice(4);
    sel.insertBefore(new Option(`＋ ${name} (new)`, value), sel.querySelector('[value="__new__"]'));
  }
  sel.value = value;
  $('.suggest', row)?.toggleAttribute('hidden', sel.value === $('.suggest', row)?.dataset.suggest);
}

$('#intake-list').addEventListener('click', (e) => {
  const s = e.target.closest('[data-suggest]');
  if (s) setRowAlbum(s.closest('.intake-row'), s.dataset.suggest);
});
$('#intake-list').addEventListener('change', async (e) => {
  const sel = e.target.closest('select[data-f=album]');
  if (!sel) return;
  const row = sel.closest('.intake-row');
  if (sel.value === '__new__') {
    const prev = sel.dataset.prev || '';
    sel.value = prev;
    const v = await promptDialog({ title: 'New album', placeholder: 'e.g. Work, Fiction, To read', okText: 'Create' });
    const name = v?.trim();
    if (!name) return;
    const dupe = findAlbumByName(name);
    setRowAlbum(row, dupe ? `album:${dupe.id}` : `new:${name}`);
  }
  sel.dataset.prev = sel.value;
  const sug = $('.suggest', row);
  if (sug) sug.hidden = sel.value === sug.dataset.suggest;
});
$('#intake-list').addEventListener('focusin', (e) => { const s = e.target.closest('select'); if (s) s.dataset.prev = s.value; });

$('#intake-suggest').onclick = () => {
  for (const row of $$('.intake-row', intakeEl)) {
    const b = intakeRows.find((x) => x.id === row.dataset.id);
    const v = b && suggestionValue(b);
    if (v) setRowAlbum(row, v);
  }
};

$('#intake-done').onclick = async () => {
  const created = new Map();
  const changed = [];
  for (const row of $$('.intake-row', intakeEl)) {
    const b = intakeRows.find((x) => x.id === row.dataset.id);
    if (!b) continue;
    const title = $('[data-f=title]', row).value.trim();
    if (title) b.title = title;
    b.author = $('[data-f=author]', row).value.trim();
    const v = $('select[data-f=album]', row).value;
    if (v.startsWith('album:')) b.albumId = v.slice(6);
    else if (v.startsWith('new:')) {
      const name = v.slice(4);
      let a = findAlbumByName(name) || created.get(name.toLowerCase());
      if (!a) { a = await makeAlbum(name); created.set(name.toLowerCase(), a); }
      b.albumId = a.id;
    } else delete b.albumId;
    changed.push(b);
  }
  await db.putMany('books', changed);
  await closeTop();
  renderLibrary();
  const filed = changed.filter((b) => b.albumId).length;
  if (intakeMode === 'new') toast(filed ? `Filed ${plural(filed, 'book')} into albums` : 'Added to your library');
  else toast('Saved');
};
$('#intake-cancel').onclick = () => closeTop();

/* ================================================================
   Settings, backup & restore
   ================================================================ */
$('#lib-settings-btn').onclick = async () => {
  $('#opt-resume').checked = settings.resume;
  $('#opt-review').checked = settings.review;
  openModal($('#lib-settings'));
  try {
    const est = await navigator.storage?.estimate?.();
    const persisted = await navigator.storage?.persisted?.();
    if (est) $('#storage-info').textContent = `Using ${(est.usage / 1048576).toFixed(1)} MB on this device${persisted ? ' · protected from automatic cleanup' : ''}.`;
  } catch {}
};
$('#opt-resume').onchange = (e) => { settings.resume = e.target.checked; saveSettings(); };
$('#opt-review').onchange = (e) => { settings.review = e.target.checked; saveSettings(); };

$('#backup-btn').onclick = async () => {
  const [bks, bms, als] = await Promise.all([db.all('books'), db.all('bookmarks'), db.all('albums')]);
  const data = {
    app: 'folio', version: 2, exportedAt: new Date().toISOString(),
    albums: als,
    books: bks.map(({ id, title, author, fileName, pageCount, lastPage, lastSeen, readSeconds, lastOpened, albumId }) => ({ id, title, author, fileName, pageCount, lastPage, lastSeen, readSeconds, lastOpened, albumId })),
    bookmarks: bms,
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

    // Albums: reuse one with the same id or name, otherwise add it.
    const have = await db.all('albums');
    const idMap = new Map();
    const toAdd = [];
    for (const a of data.albums || []) {
      const same = have.find((x) => x.id === a.id) || have.find((x) => x.name.toLowerCase() === String(a.name).toLowerCase());
      if (same) idMap.set(a.id, same.id);
      else { toAdd.push(a); have.push(a); idMap.set(a.id, a.id); }
    }
    await db.putMany('albums', toAdd);

    const existingBms = await db.all('bookmarks');
    const bmKeys = new Set(existingBms.map((b) => b.bookId + ':' + b.page));
    const newBms = (data.bookmarks || []).filter((b) => !bmKeys.has(b.bookId + ':' + b.page));
    await db.putMany('bookmarks', newBms);

    const pending = ls.get('pendingProgress', {});
    let matched = 0;
    for (const b of data.books || []) {
      const albumId = b.albumId ? idMap.get(b.albumId) || null : null;
      const ex = await db.get('books', b.id);
      if (ex) {
        matched++;
        if ((b.lastOpened || 0) > (ex.lastOpened || 0)) Object.assign(ex, { lastPage: b.lastPage, lastSeen: b.lastSeen || b.lastPage, lastOpened: b.lastOpened });
        ex.readSeconds = Math.max(ex.readSeconds || 0, b.readSeconds || 0);
        if (albumId && !ex.albumId) ex.albumId = albumId;
        await db.put('books', ex);
      } else pending[b.id] = { ...b, albumId };
    }
    ls.set('pendingProgress', pending);
    await loadLibrary();
    const waiting = (data.books || []).length - matched;
    toast(`Restored ${plural(newBms.length, 'bookmark')} and ${plural(toAdd.length, 'album')}` + (waiting ? ` · ${plural(waiting, 'book')} will pick up their progress when added` : ''), { ms: 4500 });
  } catch (err) {
    console.error(err);
    toast('That file isn’t a Folio backup');
  }
};

export { KINDS };
window.__folio = { get books() { return books; }, get albums() { return albums; }, db, importFiles };

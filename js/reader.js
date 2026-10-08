/* Paged reader.
 *
 * Pages are turned sideways. Only the current slide and its two neighbours are
 * ever in the DOM, so a 2,000-page book costs the same as a 20-page one.
 *
 *   #stage  ─ clips everything, owns all gestures
 *    └ #track   ─ translated while you drag / animate a page turn
 *       └ .slide ×3 ─ placed at (index − current) × 100%
 *          └ .zoomer ─ pinch / double-tap zoom + pan lives here (current slide only)
 *             └ .page ×1–2 ─ one page, or a two-page spread on wide screens
 */
import { pdfjsLib, openPdf } from './pdf.js';
import { db } from './db.js';
import { $, $$, clamp, uid, esc, icon, relTime, toast, hideToast, pushOverlay, closeTop, topOverlay, promptDialog, reducedMotion, ls } from './ui.js';
import { settings, saveSettings, applyTheme } from './settings.js';

const MAX_ZOOM = 5;
const MAX_PX = 10e6;            // canvas pixel budget (iOS Safari caps canvases around 16M)
const TAP_ZOOM = 2.5;
const EASE = 'cubic-bezier(.22,.8,.26,1)';

const libraryEl = $('#library');
const readerEl = $('#reader');
const stage = $('#stage');
const track = $('#track');
const settingsSheet = $('#settings-sheet');
const panel = $('#panel');
const scrubber = $('#scrubber');

let hooks = {};
export function initReader(h) { hooks = h; }

let genCounter = 0;
function freshState() {
  return {
    open: false, gen: ++genCounter, book: null, pdf: null, N: 0,
    sizes: [], slides: [], slideOf: null, spread: false, cur: 0,
    mounted: new Map(), vw: 0, vh: 0, pad: { t: 0, r: 0, b: 0, l: 0 },
    zoom: 1, tx: 0, ty: 0, active: 0,
    bookmarks: new Map(), outline: [], chapters: [], textCache: new Map(),
    chromeHidden: false, backJump: null, backLanding: 0,
    saveTimer: 0, readTimer: 0, hiTimer: 0, tapTimer: 0, glideRaf: 0, lastActivity: Date.now(), wake: null,
    anim: null, lastTap: null, wheelAcc: 0, wheelAt: 0, wheelLock: 0,
    searchToken: 0, tab: 'toc', scrubbing: false,
  };
}
let R = freshState();
export const isReaderOpen = () => R.open;

/* ================================================================
   Open / close
   ================================================================ */
export async function openBook(id) {
  const book = await db.get('books', id);
  if (!book) return toast('That book is no longer in your library');
  const buf = await db.get('files', id);
  if (!buf) return toast('The PDF file for this book is missing');

  R = freshState();
  hideToast();
  R.book = book;
  R.open = true;
  const gen = R.gen;

  libraryEl.hidden = true;
  readerEl.hidden = false;
  readerEl.classList.remove('chrome-hidden');
  $('#book-title').textContent = book.title;
  $('#chapter-title').textContent = '';
  $('#loading').hidden = false;
  $('#backjump').hidden = true;
  track.replaceChildren();
  applyTheme();
  pushOverlay('reader', closeReaderNow);
  ls.set('openBook', id);

  try {
    R.pdf = await openPdf(new Uint8Array(buf));
  } catch (e) {
    console.error(e);
    $('#loading').hidden = true;
    toast('Couldn’t open this PDF');
    closeTop();
    return;
  }
  if (gen !== R.gen) return;
  R.N = R.pdf.numPages;
  await pageSize(1);
  const bms = await db.byBook('bookmarks', id);
  if (gen !== R.gen) return;
  for (const b of bms) R.bookmarks.set(b.page, b);

  measure();
  R.spread = computeSpread();
  buildSlides();
  const startPage = clamp(book.lastPage || 1, 1, R.N);
  R.cur = R.slideOf[startPage];
  scrubber.max = R.N;
  ensureWindow();
  await curSlide().ready;
  if (gen !== R.gen) return;
  updateUI(true);
  ensureText(curSlide());
  $('#loading').hidden = true;
  stage.focus({ preventScroll: true });

  book.lastOpened = Date.now();
  db.put('books', book);
  if (startPage > 1) toast(`Picked up where you left off · page ${startPage}`);

  R.readTimer = setInterval(() => {
    if (document.visibilityState === 'visible' && Date.now() - R.lastActivity < 120000 && R.book) {
      R.book.readSeconds = (R.book.readSeconds || 0) + 15;
      saveSoon();
    }
  }, 15000);
  requestWake();
  loadOutline(gen);
}

function closeReaderNow() {
  savePosition();
  clearInterval(R.readTimer);
  for (const t of ['saveTimer', 'hiTimer', 'tapTimer']) clearTimeout(R[t]);
  cancelAnimationFrame(R.glideRaf);
  R.anim?.a.cancel();
  for (const s of [...R.mounted.values()]) unmountSlide(s);
  track.replaceChildren();
  setTrack(0);
  R.pdf?.destroy();
  releaseWake();
  R = { ...freshState(), open: false };
  ptrs.clear(); gest = null;
  settingsSheet.hidden = true;
  panel.classList.remove('open');
  $('#scrim').hidden = true;
  readerEl.hidden = true;
  libraryEl.hidden = false;
  ls.del('openBook');
  applyTheme();
  hooks.onClose?.();
}
$('#close-reader').onclick = () => closeTop();

/* ================================================================
   Layout: slides, spreads, page sizes
   ================================================================ */
async function pageSize(n) {
  if (R.sizes[n]) return R.sizes[n];
  const page = await R.pdf.getPage(n);
  const vp = page.getViewport({ scale: 1 });
  return (R.sizes[n] = { w: vp.width, h: vp.height });
}

function measure() {
  R.vw = stage.clientWidth;
  R.vh = stage.clientHeight;
  const cs = getComputedStyle(stage);
  R.pad = { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 };
}

function computeSpread() {
  const mode = settings.layout;
  if (mode === 'single' || R.N < 2) return false;
  const s1 = R.sizes[1];
  if (s1 && s1.w > s1.h * 1.05) return false;          // landscape pages (slides, comics) stay single
  if (mode === 'double') return true;
  return R.N > 2 && R.vw / R.vh >= 1.3 && R.vw >= 760;
}

function buildSlides() {
  const N = R.N, out = [];
  if (!R.spread) for (let n = 1; n <= N; n++) out.push([n]);
  else {
    out.push([1]);                                       // the cover stands alone, like a closed book
    for (let n = 2; n <= N; n += 2) out.push(n + 1 <= N ? [n, n + 1] : [n]);
  }
  R.slides = out;
  R.slideOf = new Uint32Array(N + 2);
  out.forEach((pg, i) => pg.forEach((n) => { R.slideOf[n] = i; }));
}

const curSlide = () => R.mounted.get(R.cur);
const firstPage = () => R.slides[R.cur][0];

function makePage(n) {
  const el = document.createElement('div');
  el.className = 'page';
  el.dataset.page = n;
  el.innerHTML = '<div class="paper"></div><div class="hit-layer"></div><span class="pnum">' + n + '</span>';
  return {
    num: n, el, paper: el.children[0], hitLayer: el.children[1],
    canvas: null, hi: null, hiInfo: null, hiTask: null, text: null, textBuilding: false, waiters: [],
    scale: 0, x: 0, y: 0, wpx: 0, hpx: 0, renderedScale: 0, rendering: false, task: null, dead: false,
  };
}

function mountSlide(i) {
  if (i < 0 || i >= R.slides.length) return null;
  let s = R.mounted.get(i);
  if (s) return s;
  s = { idx: i, pages: R.slides[i].map(makePage), el: document.createElement('div'), zoomer: document.createElement('div'), box: null, laidOut: false, ready: null };
  s.el.className = 'slide';
  s.zoomer.className = 'zoomer';
  s.el.append(s.zoomer);
  for (const p of s.pages) { s.zoomer.append(p.el); markPage(p); }
  if (s.pages.length === 2) { s.pages[0].el.classList.add('left'); s.pages[1].el.classList.add('right'); }
  positionSlide(s);
  track.append(s.el);
  R.mounted.set(i, s);
  s.ready = layoutSlide(s);
  return s;
}
const positionSlide = (s) => {
  s.el.style.transform = `translate3d(${(s.idx - R.cur) * 100}%,0,0)`;
  s.el.classList.toggle('on', s.idx === R.cur);       // neighbours are only visible while a drag / turn is under way
};

function unmountSlide(s) {
  for (const p of s.pages) releasePage(p);
  s.el.remove();
  R.mounted.delete(s.idx);
}
function releasePage(p) {
  p.dead = true;
  p.task?.cancel();
  clearHi(p);
  if (p.canvas) p.canvas.width = p.canvas.height = 0;
  p.waiters.splice(0).forEach((r) => r());
}

/** Keep current ± 1 mounted and positioned. */
function ensureWindow() {
  for (const s of [...R.mounted.values()]) if (Math.abs(s.idx - R.cur) > 1) unmountSlide(s);
  for (const i of [R.cur, R.cur + 1, R.cur - 1]) mountSlide(i);
  for (const s of R.mounted.values()) positionSlide(s);
  pump();
}

async function layoutSlide(s) {
  const gen = R.gen;
  const sizes = await Promise.all(s.pages.map((p) => pageSize(p.num)));
  if (gen !== R.gen || R.mounted.get(s.idx) !== s) return;
  layoutSlideSync(s, sizes);
  pump();
}

function layoutSlideSync(s, sizes) {
  const { vw, vh, pad } = R;
  const availW = Math.max(40, vw - pad.l - pad.r), availH = Math.max(40, vh - pad.t - pad.b);
  const maxH = Math.max(...sizes.map((z) => z.h));
  let sumW = sizes.reduce((n, z) => n + z.w, 0);
  const sizeW = R.spread && sizes.length === 1 ? sizes[0].w * 2 : sumW;    // a lone cover keeps its spread size
  const scale = Math.min(availW / sizeW, availH / maxH);
  const drawW = sumW * scale;
  let x = pad.l + (availW - drawW) / 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  s.pages.forEach((p, i) => {
    const z = sizes[i];
    p.scale = scale;
    p.wpx = z.w * scale; p.hpx = z.h * scale;
    p.x = x; p.y = pad.t + (availH - p.hpx) / 2;
    x += p.wpx;
    p.el.style.cssText = `left:${p.x}px;top:${p.y}px;width:${p.wpx}px;height:${p.hpx}px;--scale-factor:${scale}`;
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x + p.wpx); y1 = Math.max(y1, p.y + p.hpx);
  });
  s.box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  s.laidOut = true;
}

function relayoutAll() {
  if (!R.open || !R.slides.length) return;
  const page = firstPage();
  measure();
  resetZoom();
  const spread = computeSpread();
  if (spread !== R.spread) {
    R.spread = spread;
    for (const s of [...R.mounted.values()]) unmountSlide(s);
    buildSlides();
    R.cur = R.slideOf[page];
  } else {
    for (const s of R.mounted.values()) if (s.laidOut) layoutSlideSync(s, s.pages.map((p) => R.sizes[p.num]));
  }
  ensureWindow();
  updateUI(true);
  ensureText(curSlide());
}
let resizeTimer;
addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(relayoutAll, 140); });

/* ================================================================
   Rendering
   ================================================================ */
function pump() {
  if (!R.open) return;
  while (R.active < 2) {
    let best = null, bd = Infinity;
    for (const s of R.mounted.values()) {
      if (!s.laidOut) continue;
      const d = Math.abs(s.idx - R.cur) * 2 + (s.idx < R.cur ? 1 : 0);     // current, then next, then previous
      for (const p of s.pages) {
        if (p.rendering || p.dead || p.renderedScale === p.scale) continue;
        if (d < bd) { bd = d; best = p; }
      }
    }
    if (!best) return;
    R.active++;
    const gen = R.gen;
    renderBase(best, gen)
      .catch((err) => { if (err?.name !== 'RenderingCancelledException') console.warn(err); })
      .finally(() => { if (gen === R.gen) { R.active--; pump(); } });
  }
}

async function renderBase(p, gen) {
  p.rendering = true;
  const scale = p.scale;
  try {
    const page = await R.pdf.getPage(p.num);
    if (gen !== R.gen || p.dead) return;
    const vp = page.getViewport({ scale });
    let out = Math.min(devicePixelRatio || 1, 3);
    if (vp.width * vp.height * out * out > MAX_PX) out = Math.sqrt(MAX_PX / (vp.width * vp.height));
    const canvas = document.createElement('canvas');
    canvas.className = 'base';
    canvas.width = Math.floor(vp.width * out);
    canvas.height = Math.floor(vp.height * out);
    const task = page.render({
      canvasContext: canvas.getContext('2d', { alpha: false }),
      viewport: vp,
      transform: out !== 1 ? [out, 0, 0, out, 0, 0] : null,
    });
    p.task = task;
    try { await task.promise; } finally { p.task = null; }
    if (gen !== R.gen || p.dead || scale !== p.scale) { canvas.width = canvas.height = 0; return; }
    if (p.canvas) { p.canvas.width = p.canvas.height = 0; p.canvas.remove(); }
    p.paper.prepend(canvas);
    p.canvas = canvas;
    p.renderedScale = scale;
    p.el.classList.add('rendered');
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') p.renderedScale = scale;   // don't retry a broken page forever
    throw err;
  } finally {
    p.rendering = false;
  }
}

async function buildText(p, gen = R.gen) {
  if (p.text || p.textBuilding || p.dead || !p.scale) return;
  p.textBuilding = true;
  try {
    const page = await R.pdf.getPage(p.num);
    if (gen !== R.gen || p.dead) return;
    const div = document.createElement('div');
    div.className = 'textLayer';
    const tl = new pdfjsLib.TextLayer({
      textContentSource: page.streamTextContent({ includeMarkedContent: true, disableNormalization: true }),
      container: div,
      viewport: page.getViewport({ scale: p.scale }),
    });
    await tl.render();
    if (gen !== R.gen || p.dead) return;
    const eoc = document.createElement('div');
    eoc.className = 'endOfContent';
    div.append(eoc);
    p.el.append(div);
    p.text = div;
    p.waiters.splice(0).forEach((r) => r(true));
  } catch (e) {
    console.warn(e);
  } finally {
    p.textBuilding = false;
  }
}
async function ensureText(s) {
  if (!s) return;
  await s.ready;
  if (R.mounted.get(s.idx) !== s) return;
  const gen = R.gen;
  for (const p of s.pages) buildText(p, gen);
}
function whenTextReady(p) {
  if (p.text) return Promise.resolve(true);
  return new Promise((resolve) => {
    p.waiters.push(resolve);
    setTimeout(() => resolve(false), 6000);
    buildText(p);
  });
}

/* Sharp rendering while zoomed: draw just the visible region of the page at full
   resolution on top of the normal canvas, instead of the whole page at 5×. */
function scheduleHi() {
  clearTimeout(R.hiTimer);
  R.hiTimer = setTimeout(renderHi, 180);
}
function clearHi(p) {
  p.hiTask?.cancel();
  p.hiTask = null;
  if (p.hi) { p.hi.width = p.hi.height = 0; p.hi.remove(); }
  p.hi = null; p.hiInfo = null;
}
async function renderHi() {
  const s = curSlide();
  if (!s?.laidOut) return;
  if (R.zoom < 1.12) { s.pages.forEach(clearHi); return; }
  const gen = R.gen, z = R.zoom;
  const vx0 = -R.tx / z, vy0 = -R.ty / z, vx1 = (R.vw - R.tx) / z, vy1 = (R.vh - R.ty) / z;
  for (const p of s.pages) {
    const ix0 = Math.max(vx0, p.x), iy0 = Math.max(vy0, p.y), ix1 = Math.min(vx1, p.x + p.wpx), iy1 = Math.min(vy1, p.y + p.hpx);
    if (ix1 - ix0 < 2 || iy1 - iy0 < 2) { clearHi(p); continue; }
    const h = p.hiInfo;
    if (h && h.z >= z * 0.97 && ix0 >= h.x0 - 0.5 && iy0 >= h.y0 - 0.5 && ix1 <= h.x1 + 0.5 && iy1 <= h.y1 + 0.5) continue;
    const mx = (vx1 - vx0) * 0.3, my = (vy1 - vy0) * 0.3;     // pre-render a margin so small pans stay sharp
    await drawHi(p, gen, z, Math.max(p.x, ix0 - mx), Math.max(p.y, iy0 - my), Math.min(p.x + p.wpx, ix1 + mx), Math.min(p.y + p.hpx, iy1 + my));
    if (gen !== R.gen) return;
  }
}
async function drawHi(p, gen, z, x0, y0, x1, y1) {
  const page = await R.pdf.getPage(p.num);
  if (gen !== R.gen || p.dead) return;
  const dpr = Math.min(devicePixelRatio || 1, 3);
  const lw = x1 - x0, lh = y1 - y0;
  let out = dpr * z;
  if (lw * lh * out * out > MAX_PX) out = Math.sqrt(MAX_PX / (lw * lh));
  const ox = Math.round((x0 - p.x) * out), oy = Math.round((y0 - p.y) * out);
  const w = Math.ceil(lw * out), h = Math.ceil(lh * out);
  const canvas = document.createElement('canvas');
  canvas.className = 'hi';
  canvas.width = w; canvas.height = h;
  p.hiTask?.cancel();
  const task = page.render({
    canvasContext: canvas.getContext('2d', { alpha: false }),
    viewport: page.getViewport({ scale: p.scale * out }),
    transform: [1, 0, 0, 1, -ox, -oy],
  });
  p.hiTask = task;
  try { await task.promise; }
  catch (e) { canvas.width = canvas.height = 0; if (e?.name === 'RenderingCancelledException') return; throw e; }
  finally { if (p.hiTask === task) p.hiTask = null; }
  if (gen !== R.gen || p.dead || R.zoom < 1.05) { canvas.width = canvas.height = 0; return; }
  canvas.style.cssText = `left:${ox / out}px;top:${oy / out}px;width:${w / out}px;height:${h / out}px`;
  p.paper.append(canvas);
  if (p.hi) { p.hi.width = p.hi.height = 0; p.hi.remove(); }
  p.hi = canvas;
  const sx = p.x + ox / out, sy = p.y + oy / out;
  p.hiInfo = { z, x0: sx, y0: sy, x1: sx + w / out, y1: sy + h / out };
}

/* ================================================================
   Zoom & pan (current slide only)
   ================================================================ */
function axisBounds(start, size, view, z) {
  const m = 8;
  if (size * z <= view - 2 * m) { const c = (start + size / 2) * (1 - z); return [c, c]; }   // fits: stays centred
  return [view - m - (start + size) * z, m - start * z];
}
function clampPan(tx, ty, z = R.zoom) {
  const b = curSlide()?.box;
  if (!b) return [0, 0];
  const [x0, x1] = axisBounds(b.x, b.w, R.vw, z), [y0, y1] = axisBounds(b.y, b.h, R.vh, z);
  return [clamp(tx, x0, x1), clamp(ty, y0, y1)];
}
function applyTransform(anim = false) {
  const s = curSlide();
  if (!s) return;
  s.zoomer.style.transition = anim && !reducedMotion.matches ? 'transform .26s cubic-bezier(.2,.8,.2,1)' : 'none';
  s.zoomer.style.transform = R.zoom === 1 && !R.tx && !R.ty ? '' : `translate3d(${R.tx}px,${R.ty}px,0) scale(${R.zoom})`;
  $('#zoom-label').textContent = Math.round(R.zoom * 100) + '%';
  stage.classList.toggle('zoomed', R.zoom > 1.02);
}
function zoomTo(z, fx = R.vw / 2, fy = R.vh / 2, anim = true) {
  z = clamp(z, 1, MAX_ZOOM);
  const k = z / R.zoom;
  R.zoom = z;
  [R.tx, R.ty] = clampPan(fx - (fx - R.tx) * k, fy - (fy - R.ty) * k, z);
  applyTransform(anim);
  if (z < 1.12) curSlide()?.pages.forEach(clearHi); else scheduleHi();
}
function resetZoom() {
  cancelAnimationFrame(R.glideRaf);
  R.zoom = 1; R.tx = R.ty = 0;
  for (const s of R.mounted.values()) {
    s.zoomer.style.transition = 'none';
    s.zoomer.style.transform = '';
    s.pages.forEach(clearHi);
  }
  stage.classList.remove('zoomed');
  $('#zoom-label').textContent = '100%';
}
$('#zoom-in').onclick = () => zoomTo(R.zoom * 1.3);
$('#zoom-out').onclick = () => zoomTo(R.zoom / 1.3);
$('#zoom-fit').onclick = () => zoomTo(1);

/* ================================================================
   Page turning
   ================================================================ */
const setTrack = (px) => {
  track.style.transform = px ? `translate3d(${px}px,0,0)` : '';
  track.classList.toggle('moving', !!px);
};
const trk = (px) => `translate3d(${px}px,0,0)`;

function runAnim(from, to, ms, commit) {
  return new Promise((resolve) => {
    if (reducedMotion.matches || ms <= 0) { setTrack(to); commit?.(); return resolve(); }
    track.classList.add('moving');
    const a = track.animate([{ transform: trk(from) }, { transform: trk(to) }], { duration: ms, easing: EASE, fill: 'forwards' });
    const entry = { a, finish() { setTrack(to); a.cancel(); commit?.(); resolve(); } };
    R.anim = entry;
    a.onfinish = () => { if (R.anim === entry) { R.anim = null; entry.finish(); } };
  });
}
function finishAnim() {
  const e = R.anim;
  if (!e) return;
  R.anim = null;
  e.finish();
}

/** Animate to a neighbouring slide (dir ±1) or spring back (dir 0). */
function settle(dir, from = 0) {
  const W = R.vw;
  const target = R.cur + dir;
  if (dir === 0 || target < 0 || target >= R.slides.length) return runAnim(from, 0, 220);   // no page there: spring back
  const to = -dir * W;
  return runAnim(from, to, clamp(Math.abs(to - from) / W * 360, 150, 360), () => commitTurn(target));
}

function turn(dir) {
  if (!R.open) return;
  finishAnim();
  if (R.zoom > 1.02) resetZoomAnimated();
  const t = R.cur + dir;
  if (t < 0 || t >= R.slides.length) return bump(dir);
  settle(dir, 0);
}
function bump(dir) {
  if (reducedMotion.matches) return;
  track.animate([{ transform: trk(0) }, { transform: trk(-dir * 22) }, { transform: trk(0) }], { duration: 260, easing: 'ease-out' });
}
function resetZoomAnimated() { zoomTo(1, undefined, undefined, false); }

function commitTurn(idx) {
  R.cur = idx;
  setTrack(0);
  resetZoom();
  clearHits();
  ensureWindow();
  afterNavigate();
  if (settings.autoHide && !R.chromeHidden) setChrome(false);
}

/** Jump to any page with a quick fade instead of sliding through everything between. */
function jumpToSlide(idx) {
  finishAnim();
  resetZoom();
  for (const s of [...R.mounted.values()]) if (Math.abs(s.idx - idx) > 1) unmountSlide(s);
  R.cur = idx;
  clearHits();
  ensureWindow();
  const s = curSlide();
  if (!reducedMotion.matches) { s.el.classList.remove('fade'); void s.el.offsetWidth; s.el.classList.add('fade'); }
  afterNavigate();
}
function afterNavigate() {
  R.lastActivity = Date.now();
  updateUI();
  ensureText(curSlide());
  saveSoon();
  if (R.backJump && Math.abs(firstPage() - R.backLanding) > 2) { R.backJump = null; $('#backjump').hidden = true; }
}

function goToPage(n, { record = true } = {}) {
  n = clamp(Math.round(n), 1, R.N);
  const idx = R.slideOf[n];
  if (record) { setBackJump(); R.backLanding = R.slides[idx][0]; }    // before jumping: afterNavigate() compares against it
  if (idx === R.cur) { if (R.zoom > 1.02) zoomTo(1); }
  else jumpToSlide(idx);
}

function setBackJump() {
  R.backJump = firstPage();
  const b = $('#backjump');
  b.querySelector('span').textContent = `Back to page ${R.backJump}`;
  b.hidden = false;
}
$('#backjump').onclick = () => {
  if (R.backJump == null) return;
  const here = firstPage();
  const idx = R.slideOf[R.backJump];
  R.backLanding = R.slides[idx][0];
  R.backJump = here;
  if (idx !== R.cur) jumpToSlide(idx);
  $('#backjump').querySelector('span').textContent = `Return to page ${here}`;
};

/* ---------- UI state ---------- */
function chapterAt(n) {
  let cur = null;
  for (const c of R.chapters) { if (c.page <= n) cur = c; else break; }
  return cur;
}

function updateUI(force = false) {
  const N = R.N, pages = R.slides[R.cur];
  const first = pages[0], last = pages[pages.length - 1];
  const range = pages.length > 1 ? `${first}–${last}` : `${first}`;
  $('#page-label').textContent = pages.length > 1 ? `Pages ${range} of ${N}` : `Page ${first} of ${N}`;
  $('#mini-status').textContent = `${range} / ${N}`;
  if (!R.scrubbing) {
    scrubber.value = first;
    scrubber.style.setProperty('--fill', (N > 1 ? (first - 1) / (N - 1) * 100 : 100) + '%');
  }
  $('#chapter-title').textContent = chapterAt(first)?.title || '';
  const top = R.chapters.filter((c) => c.depth === 0);
  const marks = top.length >= 3 ? top : R.chapters;
  const next = marks.find((c) => c.page > last);
  let left;
  if (marks.length && next) { const k = next.page - last; left = k === 1 ? 'Last page in chapter' : `${k} pages left in chapter`; }
  else { const k = N - last; left = k === 0 ? 'Last page' : `${k} page${k === 1 ? '' : 's'} left`; }
  $('#progress-label').textContent = `${N > 1 ? Math.round((last - 1) / (N - 1) * 100) : 100}% · ${left}`;
  const marked = pages.some((n) => R.bookmarks.has(n));
  $('#bookmark-btn').classList.toggle('on', marked);
  $('#bookmark-btn').setAttribute('aria-label', marked ? 'Remove bookmark' : 'Bookmark this page');
  $('#nav-prev').disabled = R.cur === 0;
  $('#nav-next').disabled = R.cur === R.slides.length - 1;
  if (R.tab === 'toc' && panel.classList.contains('open')) markCurrentToc();
  if (force) applyTransform();
}

function setChrome(show) {
  R.chromeHidden = !show;
  readerEl.classList.toggle('chrome-hidden', !show);
  if (!show) settingsSheet.hidden = true;
}

/* ---------- saving position ---------- */
function saveSoon() {
  clearTimeout(R.saveTimer);
  R.saveTimer = setTimeout(savePosition, 600);
}
function savePosition() {
  if (!R.book || !R.slides.length) return;
  const pages = R.slides[R.cur];
  R.book.lastPage = pages[0];
  R.book.lastSeen = pages[pages.length - 1];
  R.book.lastFrac = 0;
  R.book.lastOpened = Date.now();
  return db.put('books', R.book).catch(() => {});
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') savePosition();
  else if (R.open) requestWake();
});
addEventListener('pagehide', savePosition);

/* ================================================================
   Gestures: swipe to turn, pan, pinch, taps
   ================================================================ */
const ptrs = new Map();
let gest = null;

stage.addEventListener('pointerdown', (e) => {
  if (!R.open || (e.pointerType === 'mouse' && e.button !== 0)) return;
  finishAnim();
  cancelAnimationFrame(R.glideRaf);
  ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
  R.lastActivity = Date.now();
  if (ptrs.size === 2) return startPinch();
  if (ptrs.size > 2) return;
  const g = gest = {
    kind: 'pending', id: e.pointerId, x0: e.clientX, y0: e.clientY, t0: performance.now(), type: e.pointerType,
    target: e.target, tx0: R.tx, ty0: R.ty, samples: [{ x: e.clientX, y: e.clientY, t: performance.now() }],
    edgeL: false, edgeR: false, off: 0,
  };
  const b = curSlide()?.box;
  if (b && R.zoom > 1.02) {                              // did the drag start already at a page edge?
    const [x0, x1] = axisBounds(b.x, b.w, R.vw, R.zoom);
    g.edgeR = R.tx <= x0 + 2; g.edgeL = R.tx >= x1 - 2;
  }
});

stage.addEventListener('pointermove', (e) => {
  // Mouse users: nudging the pointer to the top or bottom edge brings the bars back.
  if (e.pointerType === 'mouse' && !e.buttons && R.chromeHidden && (e.clientY < 64 || e.clientY > innerHeight - 84)) setChrome(true);
  const pt = ptrs.get(e.pointerId);
  if (!pt) return;
  pt.x = e.clientX; pt.y = e.clientY;
  if (gest?.kind === 'pinch') return movePinch();
  const g = gest;
  if (!g || g.id !== e.pointerId) return;
  const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
  const now = performance.now();

  if (g.kind === 'pending') {
    if (Math.hypot(dx, dy) < 8) return;
    const sel = getSelection();
    if (sel && !sel.isCollapsed) { g.kind = 'ignore'; return; }
    if (g.type === 'mouse') {                            // mouse drags select text; they only pan on blank space when zoomed
      const onText = g.target.closest?.('.textLayer span');
      if (R.zoom <= 1.02 || onText) { g.kind = 'ignore'; return; }
    }
    g.kind = R.zoom > 1.02 ? 'pan' : Math.abs(dx) > Math.abs(dy) * 0.9 ? 'swipe' : 'ignore';
    if (g.kind === 'ignore') return;
    try { stage.setPointerCapture(e.pointerId); } catch {}
    stage.classList.add('dragging');
    clearTimeout(R.tapTimer); R.lastTap = null;
  }

  g.samples.push({ x: e.clientX, y: e.clientY, t: now });
  while (g.samples.length > 2 && now - g.samples[0].t > 120) g.samples.shift();

  if (g.kind === 'swipe') {
    let off = clamp(dx, -R.vw, R.vw);
    const t = R.cur + (off < 0 ? 1 : -1);
    if (t < 0 || t >= R.slides.length) off *= 0.28;      // nothing there: rubber-band
    g.off = off;
    setTrack(off);
  } else if (g.kind === 'pan') {
    const wantX = g.tx0 + dx;
    const [cx, cy] = clampPan(wantX, g.ty0 + dy);
    let over = 0;
    if (g.edgeL && wantX > cx) over = wantX - cx;        // pushing past the left edge → previous page
    else if (g.edgeR && wantX < cx) over = wantX - cx;   // pushing past the right edge → next page
    const t = R.cur + (over < 0 ? 1 : -1);
    if (over && (t < 0 || t >= R.slides.length)) over *= 0.28;
    R.tx = cx; R.ty = cy;
    g.off = over;
    applyTransform(false);
    setTrack(over);
  }
});

function endPointer(e, cancelled) {
  if (!ptrs.delete(e.pointerId)) return;
  try { stage.releasePointerCapture(e.pointerId); } catch {}
  const g = gest;
  if (g?.kind === 'pinch') {
    if (ptrs.size < 2) { endPinch(); gest = ptrs.size ? { kind: 'ignore', id: [...ptrs.keys()][0] } : null; }
    return;
  }
  if (!g || g.id !== e.pointerId) return;
  gest = null;
  stage.classList.remove('dragging');
  if (g.kind === 'swipe' || g.kind === 'pan') cancelled ? settle(0, g.off) : releaseDrag(g);
  else if (g.kind === 'pending' && !cancelled) onTap(g, e);
}
stage.addEventListener('pointerup', (e) => endPointer(e, false));
stage.addEventListener('pointercancel', (e) => endPointer(e, true));

function velocity(g) {
  const a = g.samples[0], b = g.samples[g.samples.length - 1];
  const dt = b.t - a.t;
  return dt > 8 ? { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt } : { vx: 0, vy: 0 };
}

function releaseDrag(g) {
  const W = R.vw, off = g.off, sgn = Math.sign(off);
  const { vx, vy } = velocity(g);
  const fast = Math.abs(vx) > 0.35;
  let go = false;
  if (sgn) {
    if (Math.abs(off) > W * 0.2) go = !(fast && Math.sign(vx) !== sgn);       // far enough, unless flicked back
    else if (fast && Math.sign(vx) === sgn && Math.abs(off) > 10) go = true;  // short but flicked
  }
  if (go) return void settle(sgn < 0 ? 1 : -1, off);
  settle(0, off);
  if (g.kind === 'pan') glide(vx, vy);
}

function glide(vx, vy) {
  if (Math.hypot(vx, vy) < 0.15) { scheduleHi(); return; }
  let last = performance.now();
  const step = (now) => {
    const dt = Math.min(now - last, 32); last = now;
    const f = Math.exp(-dt / 320);
    vx *= f; vy *= f;
    const [nx, ny] = clampPan(R.tx + vx * dt, R.ty + vy * dt);
    if (nx === R.tx) vx = 0;
    if (ny === R.ty) vy = 0;
    R.tx = nx; R.ty = ny;
    applyTransform(false);
    if (Math.hypot(vx, vy) > 0.03) R.glideRaf = requestAnimationFrame(step); else scheduleHi();
  };
  R.glideRaf = requestAnimationFrame(step);
}

/* ---------- pinch ---------- */
function startPinch() {
  const [a, b] = [...ptrs.values()];
  gest = { kind: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: R.zoom, tx0: R.tx, ty0: R.ty, cx0: (a.x + b.x) / 2, cy0: (a.y + b.y) / 2 };
  clearTimeout(R.tapTimer); R.lastTap = null;
  setTrack(0);
  stage.classList.add('dragging');
  for (const id of ptrs.keys()) { try { stage.setPointerCapture(id); } catch {} }
}
function movePinch() {
  const [a, b] = [...ptrs.values()];
  const g = gest;
  const z = clamp(g.z0 * Math.hypot(a.x - b.x, a.y - b.y) / g.d0, 0.75, MAX_ZOOM * 1.1);
  const k = z / g.z0, cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
  R.zoom = z;
  [R.tx, R.ty] = clampPan(cx - (g.cx0 - g.tx0) * k, cy - (g.cy0 - g.ty0) * k, z);
  applyTransform(false);
}
function endPinch() {
  stage.classList.remove('dragging');
  if (R.zoom < 1.05) return zoomTo(1);
  R.zoom = Math.min(R.zoom, MAX_ZOOM);
  [R.tx, R.ty] = clampPan(R.tx, R.ty);
  applyTransform(true);
  scheduleHi();
}
document.addEventListener('gesturestart', (e) => e.preventDefault());

/* ---------- taps ---------- */
function onTap(g, e) {
  if (performance.now() - g.t0 > 500) return;
  const sel = getSelection();
  if (sel && !sel.isCollapsed) return;
  if (!settingsSheet.hidden) { settingsSheet.hidden = true; return; }
  const x = e.clientX, y = e.clientY, zoomed = R.zoom > 1.02;
  const fx = x / innerWidth;
  if (!zoomed && settings.tapTurn && (fx < 0.22 || fx > 0.78)) {
    clearTimeout(R.tapTimer); R.lastTap = null;
    return turn(fx < 0.5 ? -1 : 1);
  }
  const now = performance.now();
  if (R.lastTap && now - R.lastTap.t < 320 && Math.hypot(x - R.lastTap.x, y - R.lastTap.y) < 36) {
    clearTimeout(R.tapTimer); R.lastTap = null;
    return zoomTo(zoomed ? 1 : TAP_ZOOM, x, y);
  }
  R.lastTap = { t: now, x, y };
  R.tapTimer = setTimeout(() => { R.lastTap = null; setChrome(R.chromeHidden); }, 260);
}

/* ---------- wheel / trackpad ---------- */
stage.addEventListener('wheel', (e) => {
  if (!R.open) return;
  e.preventDefault();
  R.lastActivity = Date.now();
  const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? R.vh : 1;
  const dx = e.deltaX * unit, dy = e.deltaY * unit;
  if (e.ctrlKey) return zoomTo(R.zoom * Math.exp(-dy * 0.01), e.clientX, e.clientY, false);
  if (R.zoom > 1.02) {
    [R.tx, R.ty] = clampPan(R.tx - dx, R.ty - dy);
    applyTransform(false);
    return scheduleHi();
  }
  const now = performance.now();
  const d = Math.abs(dx) > Math.abs(dy) ? dx : dy;
  if (now < R.wheelLock) { if (Math.abs(d) > 4) R.wheelLock = now + 100; return; }   // swallow trackpad inertia
  if (now - R.wheelAt > 220) R.wheelAcc = 0;
  R.wheelAt = now;
  R.wheelAcc += d;
  if (Math.abs(R.wheelAcc) >= 40) {
    turn(R.wheelAcc > 0 ? 1 : -1);
    R.wheelAcc = 0;
    R.wheelLock = now + 380;
  }
}, { passive: false });

/* ---------- keyboard ---------- */
function panKey(dx, dy) {
  const [nx, ny] = clampPan(R.tx + dx, R.ty + dy);
  const moved = nx !== R.tx || ny !== R.ty;
  R.tx = nx; R.ty = ny;
  applyTransform(true);
  scheduleHi();
  return moved;
}
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (!settingsSheet.hidden) { settingsSheet.hidden = true; return; }
    if (topOverlay() === 'reader' && R.zoom > 1.02) return zoomTo(1);
    if (topOverlay()) closeTop();
    return;
  }
  if (!R.open || topOverlay() !== 'reader' || e.target.closest?.('input,textarea,select')) return;
  const mod = e.metaKey || e.ctrlKey;
  const zoomed = R.zoom > 1.02;
  const step = (dx, dy, dir) => { e.preventDefault(); if (!zoomed || !panKey(dx, dy)) turn(dir); };
  switch (e.key) {
    case 'ArrowRight': return step(-R.vw * 0.4, 0, 1);
    case 'ArrowLeft': return step(R.vw * 0.4, 0, -1);
    case 'ArrowDown': return step(0, -R.vh * 0.4, 1);
    case 'ArrowUp': return step(0, R.vh * 0.4, -1);
    case 'PageDown': e.preventDefault(); return turn(1);
    case 'PageUp': e.preventDefault(); return turn(-1);
    case ' ': e.preventDefault(); return turn(e.shiftKey ? -1 : 1);
    case 'Home': return goToPage(1);
    case 'End': return goToPage(R.N);
    case '=': case '+': if (mod) { e.preventDefault(); zoomTo(R.zoom * 1.3); } return;
    case '-': if (mod) { e.preventDefault(); zoomTo(R.zoom / 1.3); } return;
    case '0': if (mod) { e.preventDefault(); zoomTo(1); } return;
    case 'f': if (mod) { e.preventDefault(); openPanel('search'); } return;
    case 'b': if (!mod) toggleBookmark(); return;
  }
});

$('#nav-prev').onclick = () => turn(-1);
$('#nav-next').onclick = () => turn(1);

/* ---------- scrubber & go-to-page ---------- */
scrubber.addEventListener('input', () => {
  R.scrubbing = true;
  const n = +scrubber.value, N = R.N;
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
  const v = await promptDialog({ title: 'Go to page', value: String(firstPage()), inputType: 'number', okText: 'Go', placeholder: `1 – ${R.N}` });
  if (v != null && v.trim() && !isNaN(+v)) goToPage(+v);
};

/* ================================================================
   Bookmarks
   ================================================================ */
function markPage(p) {
  const has = R.bookmarks.has(p.num);
  const r = p.el.querySelector(':scope > .ribbon');
  if (has && !r) { const d = document.createElement('div'); d.className = 'ribbon'; p.el.append(d); }
  else if (!has && r) r.remove();
}
function markAll() { for (const s of R.mounted.values()) s.pages.forEach(markPage); }

async function toggleBookmark() {
  const pages = R.slides[R.cur];
  const marked = pages.filter((n) => R.bookmarks.has(n));
  if (marked.length) {
    for (const n of marked) { await db.del('bookmarks', R.bookmarks.get(n).id); R.bookmarks.delete(n); }
    toast(marked.length > 1 ? 'Bookmarks removed' : `Bookmark removed from page ${marked[0]}`);
  } else {
    const n = pages[0];
    const bm = { id: uid(), bookId: R.book.id, page: n, title: chapterAt(n)?.title || '', createdAt: Date.now() };
    await db.put('bookmarks', bm);
    R.bookmarks.set(n, bm);
    toast(`Bookmarked page ${n}`);
  }
  markAll();
  updateUI();
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
  updateUI();
  refreshPanelIfOpen('toc');
}

/* ================================================================
   Side panel: contents, bookmarks, search
   ================================================================ */
function openPanel(tab) {
  settingsSheet.hidden = true;
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
const isNarrow = () => innerWidth < 900;
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
  for (const t of $$('.tabs button')) {
    const on = t.dataset.tab === tab;
    t.classList.toggle('active', on);
    t.setAttribute('aria-selected', on);
  }
  for (const p of $$('.tab-pane')) p.classList.toggle('active', p.dataset.pane === tab);
  if (tab === 'toc') renderToc();
  if (tab === 'bookmarks') renderBookmarks();
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
  const ch = chapterAt(firstPage());
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
    markAll();
    updateUI();
    renderBookmarks();
    return;
  }
  const b = e.target.closest('.bm-item');
  if (b) { goToPage(+b.dataset.page); closePanelIfNarrow(); }
});

/* ---------- search ---------- */
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
  const N = R.N;
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
  const p = curSlide()?.pages.find((x) => x.num === n);
  if (p && await whenTextReady(p)) flashSearchHit(p, q, k);
});

function clearHits() {
  for (const s of R.mounted.values()) for (const p of s.pages) p.hitLayer.replaceChildren();
}

// Highlight the k-th match of `q` on the page until the next page turn.
function flashSearchHit(p, q, k) {
  if (!p.text) return;
  const segs = [];
  let s = '';
  const walker = document.createTreeWalker(p.text, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
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
  p.hitLayer.replaceChildren();
  for (const r of range.getClientRects()) {
    if (r.width < 0.5) continue;
    const d = document.createElement('div');
    d.className = 'search-hit';
    d.style.cssText = `left:${(r.left - pr.left) / pr.width * 100}%;top:${(r.top - pr.top) / pr.height * 100}%;width:${r.width / pr.width * 100}%;height:${r.height / pr.height * 100}%`;
    p.hitLayer.append(d);
  }
}

/* ================================================================
   Display settings
   ================================================================ */
function syncSettingsSheet() {
  $('#opt-invert').checked = settings.invert;
  $('#opt-tapturn').checked = settings.tapTurn;
  $('#opt-awake').checked = settings.keepAwake;
  $('#opt-autohide').checked = settings.autoHide;
  for (const b of $('#layout-seg').children) b.classList.toggle('active', b.dataset.layout === settings.layout);
}
$('#settings-btn').onclick = () => {
  const open = settingsSheet.hidden;
  settingsSheet.hidden = !open;
  if (open) syncSettingsSheet();
};
for (const seg of [$('#theme-seg'), $('#lib-theme-seg')]) {
  seg.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    settings.theme = b.dataset.theme; saveSettings(); applyTheme();
  });
}
$('#layout-seg').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  settings.layout = b.dataset.layout; saveSettings();
  syncSettingsSheet();
  relayoutAll();
});
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

// Handy for debugging and automated tests.
window.__folio_reader = { get R() { return R; }, turn, goToPage, zoomTo };

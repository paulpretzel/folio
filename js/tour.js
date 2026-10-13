/* First-run tour. It opens "Welcome to Folio", a short guide book, and walks you through it
   page by page: each page explains one thing, and the tour points at the screen (an arrow on
   the real button, or an animated hint on the page) and waits until you've done it. Once you
   reach the end it takes you back to the library and shows where to add your own books. */
import { $, ls, toast, closeTop, reducedMotion } from './ui.js';
import { db } from './db.js';
import { getBooks, importFiles, loadLibrary } from './library.js';
import { visiblePages } from './reader.js';

const SAMPLE_URL = 'samples/welcome-to-folio.pdf';
const SAMPLE_NAME = 'welcome-to-folio.pdf';
const READ_MS = 4500;      // time to read a page that only explains something, before "turn the page" shows

let hooks = {};
export function initTour(h) { hooks = h; }

const readerEl = $('#reader');
const inReader = () => !readerEl.hidden;
const barsHidden = () => readerEl.classList.contains('chrome-hidden');
const panelOpen = () => $('#panel').classList.contains('open');
let sampleId = null;
const sampleCover = () => sampleId && $(`#book-grid .book[data-id="${CSS.escape(sampleId)}"] .cover`);
const tocEntry = (title) => () => [...document.querySelectorAll('#toc-list .toc-item')].find((b) => b.querySelector('.grow')?.textContent === title);

/* Steps, in the order of the guide's pages (tools/make-sample-book.py).
   page: the guide page it belongs to. Until it's on screen, the tour shows "turn the page"; a step
         with only a page is done as soon as you get there, after wait ms to read the page before
   target: what the arrow points at · gesture: a hint drawn on the page ('swipe' | 'double' | 'tap')
   until: the reader event that completes the step (test filters it) · next: tap anywhere to go on
   bars: the target is in the reader's top bar, which has to be showing first
   lost: what to show instead while the target is gone · when: skip the step unless this is true */
const STEPS = [
  { target: sampleCover, text: 'Tap to open the guide', until: 'open' },
  { page: 2, gesture: 'double', text: 'Double-tap to zoom in', until: 'zoom', test: (d) => d.zoomedIn ?? d.zoom > 1.02 },
  { page: 2, gesture: 'double', text: 'Double-tap to zoom out', until: 'zoom', test: (d) => !(d.zoomedIn ?? d.zoom > 1.02) },
  { page: 3, gesture: 'tap', text: 'Tap the middle of the page', until: 'bars' },
  { page: 4, target: '#bookmark-btn', text: 'Tap the ribbon', until: 'bookmark', bars: true },
  { page: 5, target: '#panel-btn', text: 'Tap the list button', until: 'panel', bars: true },
  { page: 5, target: tocEntry('Your library'), text: 'Tap Your library', until: 'turn', test: () => visiblePages().includes(6),
    lost: { target: '#panel-btn', text: 'Tap the list button', bars: true } },
  { when: panelOpen, target: '#panel-close', text: 'Close the list', until: 'panel-close' },     // wide screens keep it open
  { page: 7, wait: READ_MS },
  { page: 8, wait: READ_MS },
  { page: 9, wait: READ_MS },
  { page: 9, target: '#close-reader', text: 'Tap the back arrow', until: 'close', bars: true },
  { target: '#add-book-btn', text: 'Add your first book here', next: true },
  { target: '#lib-settings-btn', text: 'Back up your library in Settings', next: true },
];
const SHOW_BARS = { gesture: 'tap', text: 'Tap the middle to show the menus' };
const TURN = { gesture: 'swipe', text: 'Swipe left or tap the right edge' };

/* ---------- overlay ---------- */
const root = document.createElement('div');
root.className = 'tour';
root.hidden = true;
root.innerHTML = `
  <div class="tour-dim"></div>
  <div class="tour-ring"></div>
  <div class="tour-arrow" aria-hidden="true"><svg viewBox="0 0 28 44"><path d="M14 41V5M4 15 14 5l10 10"/></svg></div>
  <div class="tour-gesture" aria-hidden="true"><span class="tour-finger"></span></div>
  <div class="tour-edge" aria-hidden="true"><svg><use href="#i-next"/></svg></div>
  <div class="tour-tip" role="status" aria-live="polite">
    <p class="tour-text"></p>
    <div class="tour-row">
      <span class="tour-progress"><i></i></span>
      <button class="tour-skip" type="button">Skip</button>
      <button class="tour-next btn primary small" type="button">Next</button>
    </div>
  </div>
  <div class="tour-card" role="dialog" aria-labelledby="tour-card-title">
    <div class="empty-art"><svg><use href="#i-book"/></svg></div>
    <h3 id="tour-card-title">Welcome to Folio</h3>
    <p class="muted">Your PDFs, read like books.</p>
    <button class="btn primary big" id="tour-start" type="button">Show me around</button>
    <button class="btn ghost" id="tour-skip-all" type="button">Skip</button>
  </div>`;
document.body.append(root);
const el = (s) => root.querySelector(s);
const dim = el('.tour-dim'), ring = el('.tour-ring'), arrow = el('.tour-arrow'), gesture = el('.tour-gesture');
const edge = el('.tour-edge'), tip = el('.tour-tip'), card = el('.tour-card');

let i = -1;            // current step; -1 while the welcome card is up
let raf = 0;
let shownKey = '';
let waitTimer = 0;
let stepAt = 0;        // when the current step started
let pagesKey = '', pagesAt = 0;   // which guide pages are on screen, and since when

export function startTour() {
  ls.set('welcomed', true);
  i = -1;
  root.hidden = false;
  root.classList.add('intro');
  card.hidden = false;
  tip.hidden = true;
  $('#tour-start').focus();
  loop();
}

/** At launch: a fresh install with an empty shelf gets the tour unprompted. */
export function maybeStartTour() {
  if (!ls.get('welcomed') && !getBooks().length) startTour();
}

function end(done) {
  i = -1;
  root.hidden = true;
  document.body.classList.remove('touring');
  cancelAnimationFrame(raf);
  clearTimeout(waitTimer);
  shownKey = '';
  if (done) toast('You’re all set. Happy reading!', { ms: 3200 });
}

/** Adds the guide book if it's missing, swapping out an older edition of it. */
async function guideBook() {
  const have = getBooks().filter((b) => b.fileName === SAMPLE_NAME).sort((a, b) => b.addedAt - a.addedAt);
  try {
    const res = await fetch(SAMPLE_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const [fresh] = await importFiles([new File([await res.blob()], SAMPLE_NAME, { type: 'application/pdf' })], { quiet: true });
    if (!fresh) return have[0];                  // this edition is already in the library
    for (const b of have) await db.deleteBook(b.id);
    if (have.length) await loadLibrary();
    return fresh;
  } catch (e) {
    console.warn('Couldn’t load the guide book', e);
    return have[0];
  }
}

async function begin() {
  card.hidden = true;
  root.classList.remove('intro');
  const book = await guideBook();
  if (!book) { end(false); return toast('Couldn’t add the guide book'); }
  if (book.lastPage !== 1) {
    // Replaying the tour: start the guide from its cover again
    await db.put('books', { ...(await db.get('books', book.id)), lastPage: 1, lastSeen: 1 });
    await loadLibrary();
  }
  sampleId = book.id;
  scrollTo({ top: 0 });
  go(0);
}

function go(n) {
  clearTimeout(waitTimer);
  i = n;
  // Skip steps that don't apply right now (a button that isn't on screen, a panel that's already closed)
  while (STEPS[i] && ((STEPS[i].next && !visible(resolveTarget(STEPS[i]))) || (STEPS[i].when && !STEPS[i].when()))) i++;
  if (i >= STEPS.length) return end(true);
  shownKey = '';
  stepAt = performance.now();
  resolveTarget(STEPS[i])?.scrollIntoView?.({ block: 'center', behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}
const advance = () => go(i + 1);

function resolveTarget(step) {
  if (!step?.target) return null;
  return typeof step.target === 'function' ? step.target() : $(step.target);
}
function visible(t) {
  if (!t) return false;
  const r = t.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

/* What to show right now. Before the step's page is on screen: "turn the page" (or nothing while you
   read). A step whose target has gone shows its stand-in, and a top-bar step asks for the menus first. */
function current() {
  let step = STEPS[i];
  if (!step) return null;
  if (step.page && inReader()) {
    const pages = visiblePages();
    if (pages.length && !pages.includes(step.page)) {
      if (performance.now() - Math.max(stepAt, pagesAt) < (step.wait || 700)) return { quiet: true };
      return { ...TURN };
    }
  }
  if (step.lost && !visible(resolveTarget(step))) step = { ...step, ...step.lost };
  return step.bars && barsHidden() ? { ...step, ...SHOW_BARS, target: null } : step;
}

/* Keeps the steps in line with the page you're on: done when you reach a step's page, and
   skipped when you've already turned past it. */
function followPages() {
  const step = STEPS[i];
  if (!step?.page || !inReader()) return;
  const pages = visiblePages();
  if (!pages.length) return;
  const key = pages.join();
  if (key !== pagesKey) { pagesKey = key; pagesAt = performance.now(); }
  if (Math.min(...pages) > step.page || (!step.until && pages.includes(step.page))) advance();
}

/* ---------- drawing (every frame while the tour runs, so it follows scrolling, rotation and animations) ---------- */
function loop() {
  cancelAnimationFrame(raf);
  const frame = () => { place(); raf = requestAnimationFrame(frame); };
  frame();
}

function place() {
  if (i < 0) { dim.style.clipPath = ''; dim.hidden = false; ring.hidden = arrow.hidden = gesture.hidden = edge.hidden = true; return; }
  followPages();
  if (STEPS[i]?.when && !STEPS[i].when()) advance();
  const step = current();
  if (!step) return;
  if (step.quiet) { tip.hidden = ring.hidden = arrow.hidden = gesture.hidden = edge.hidden = true; shownKey = ''; return; }
  const key = `${i}|${step.text}`;
  if (key !== shownKey) {
    shownKey = key;
    el('.tour-text').textContent = step.text;
    el('.tour-next').hidden = !step.next;
    el('.tour-progress i').style.width = `${((i + 1) / STEPS.length) * 100}%`;
    gesture.className = `tour-gesture ${step.gesture || ''}`;
    tip.hidden = false;
    if (!reducedMotion.matches) { tip.classList.remove('pop'); void tip.offsetWidth; tip.classList.add('pop'); }
  }
  const vw = innerWidth, vh = innerHeight;
  const t = resolveTarget(step);
  const r = visible(t) ? t.getBoundingClientRect() : null;
  root.classList.toggle('in-reader', inReader());
  document.body.classList.toggle('touring', !inReader());

  // Dim the library around the target; in a book the page stays clear so you can use it
  dim.hidden = inReader();
  if (!dim.hidden) {
    if (r) {
      const p = 6, x0 = r.left - p, y0 = r.top - p, x1 = r.right + p, y1 = r.bottom + p;
      dim.style.clipPath = `polygon(evenodd, 0 0, ${vw}px 0, ${vw}px ${vh}px, 0 ${vh}px, 0 0, ${x0}px ${y0}px, ${x1}px ${y0}px, ${x1}px ${y1}px, ${x0}px ${y1}px, ${x0}px ${y0}px)`;
    } else dim.style.clipPath = '';
    dim.classList.toggle('catch', !!step.next);
  }

  ring.hidden = arrow.hidden = !r;
  let tipX = vw / 2, tipY, above = false;
  if (r) {
    const p = 6, round = r.width < 64 && r.height < 64;
    Object.assign(ring.style, { left: `${r.left - p}px`, top: `${r.top - p}px`, width: `${r.width + 2 * p}px`, height: `${r.height + 2 * p}px`, borderRadius: round ? '50%' : '20px' });
    ring.classList.toggle('catch', !!step.next);
    const cx = r.left + r.width / 2;
    above = r.top + r.height / 2 > vh * 0.55;
    const ay = above ? r.top - 58 : r.bottom + 12;
    arrow.style.transform = `translate(${cx - 14}px, ${ay}px) rotate(${above ? 180 : 0}deg)`;
    tipX = cx;
    tipY = above ? r.top - 62 : r.bottom + 60;
  }

  gesture.hidden = !step.gesture;
  edge.hidden = step.gesture !== 'swipe';
  const tw = tip.offsetWidth, th = tip.offsetHeight;
  if (step.gesture) {
    // The hint sits on the page; the tip goes low, clear of the middle you're asked to tap
    gesture.style.transform = `translate(${vw / 2}px, ${vh * 0.42}px)`;
    tipY = vh - th - 112;
  }

  const left = Math.min(Math.max(12, tipX - tw / 2), vw - tw - 12);
  const top = Math.min(Math.max(12, above ? tipY - th : tipY), vh - th - 12);
  tip.style.transform = `translate(${left}px, ${top}px)`;
}

/* ---------- input ---------- */
el('.tour-next').onclick = advance;
el('.tour-skip').onclick = () => end(false);
dim.addEventListener('click', () => { if (current()?.next) advance(); });
ring.addEventListener('click', () => { if (current()?.next) advance(); });
$('#tour-start').onclick = begin;
$('#tour-skip-all').onclick = () => end(false);
addEventListener('keydown', (e) => {
  if (root.hidden) return;
  if (e.key === 'Escape') { e.stopPropagation(); end(false); }
  else if ((e.key === 'Enter' || e.key === ' ') && current()?.next) { e.preventDefault(); advance(); }
}, true);

// Closing the guide at its last page carries on in the library; leaving it earlier ends the tour
document.addEventListener('folio:close', () => {
  if (root.hidden || i < 0) return;
  if (STEPS[i]?.until === 'close') { clearTimeout(waitTimer); waitTimer = setTimeout(() => { scrollTo({ top: 0 }); advance(); }, 300); }
  else if (STEPS[i]?.until !== 'open') end(false);
});

for (const type of new Set(STEPS.map((s) => s.until).filter(Boolean))) {
  if (type === 'close') continue;
  document.addEventListener(`folio:${type}`, (e) => {
    const step = STEPS[i];
    if (root.hidden || !step || step.until !== type) return;
    if (type === 'open' && e.detail.book?.id !== sampleId) return;
    if (step.test && !step.test(e.detail)) return;
    clearTimeout(waitTimer);
    // A short pause, so the hint doesn't change mid-gesture
    waitTimer = setTimeout(advance, type === 'open' ? 350 : 450);
  });
}

$('#tour-btn').onclick = async () => { await closeTop(); startTour(); };

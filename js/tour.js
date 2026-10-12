/* First-run tour: a few welcome cards on a fresh install, then hints inside the
   "Welcome to Folio" sample book that each go away once you've tried the gesture. */
import { $, ls, toast, openModal, closeTop, reducedMotion } from './ui.js';
import { getBooks, importFiles } from './library.js';

const SAMPLE_URL = 'samples/welcome-to-folio.pdf';
const SAMPLE_NAME = 'welcome-to-folio.pdf';

let hooks = {};
export function initTour(h) { hooks = h; }

/* ---------- welcome cards ---------- */
const CARDS = [
  { icon: 'book', title: 'Your PDFs, read like books',
    text: 'Turn pages sideways, keep your books in albums, and pick up exactly where you left off. Everything stays on this device and works offline.' },
  { icon: 'plus', title: 'Add your books',
    text: 'Tap Add book to pick PDFs from Files, Drive or Downloads. On Android you can also share a PDF straight to Folio.' },
  { icon: 'sparkle', title: 'Albums that sort themselves',
    text: 'Folio looks inside each new PDF, on this device only, and suggests an album such as Fiction or Textbooks. Check its guess and tap to file it.' },
  { icon: 'download', title: 'Keep a backup',
    text: 'Your books live only on this device, so uninstalling removes them. Settings → Back up saves your albums, bookmarks and reading positions to a small file.' },
  { icon: 'bookmark', title: 'Try it out',
    text: 'Practise in a short sample book. It shows you page turns, zoom and bookmarks, and you can delete it whenever you like.',
    next: 'Open the sample book', skip: 'Not now' },
];

const welcome = $('#welcome');
let card = 0;
let wantSample = false;

function renderCard() {
  const c = CARDS[card];
  $('#welcome-art use').setAttribute('href', `#i-${c.icon}`);
  $('#welcome-title').textContent = c.title;
  $('#welcome-text').textContent = c.text;
  $('#welcome-next').textContent = c.next || 'Next';
  $('#welcome-skip').textContent = c.skip || 'Skip';
  $('#welcome-dots').replaceChildren(...CARDS.map((_, i) => {
    const d = document.createElement('span');
    if (i === card) d.className = 'on';
    return d;
  }));
}

export function showWelcome() {
  card = 0;
  wantSample = false;
  renderCard();
  openModal(welcome, () => {
    ls.set('welcomed', true);
    if (wantSample) openSample();
  });
  $('#welcome-next').focus();
}

/** Called at launch: only a fresh install with an empty shelf gets the cards unprompted. */
export function maybeShowWelcome() {
  if (!ls.get('welcomed') && !getBooks().length) showWelcome();
}

$('#welcome-next').onclick = () => {
  if (card < CARDS.length - 1) { card++; renderCard(); return; }
  wantSample = true;
  closeTop();
};
$('#welcome-skip').onclick = () => closeTop();

$('#tour-btn').onclick = async () => { await closeTop(); showWelcome(); };

/* ---------- sample book ---------- */
async function openSample() {
  let book = getBooks().find((b) => b.fileName === SAMPLE_NAME);
  if (!book) {
    try {
      const res = await fetch(SAMPLE_URL);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const file = new File([await res.blob()], SAMPLE_NAME, { type: 'application/pdf' });
      [book] = await importFiles([file], { quiet: true });
    } catch (e) { console.warn('Couldn’t load the sample book', e); }
  }
  if (!book) return toast('Couldn’t open the sample book');
  ls.set('coachStep', 0);
  hooks.openBook(book.id);
}

/* ---------- hints inside the sample book ---------- */
const STEPS = [
  { on: 'turn', text: 'Swipe left, or tap the right edge, to turn the page.' },
  { on: 'zoom', text: 'Pinch or double-tap to zoom in. Double-tap again to zoom out.' },
  { on: 'bars', text: 'Tap the middle of the page to hide the menus, then tap again to bring them back.' },
  { on: 'bookmark', text: 'Tap the ribbon at the top right to bookmark this page.', target: '#bookmark-btn' },
  { on: 'panel', text: 'Tap the list button to see the contents, your bookmarks and search.', target: '#panel-btn' },
];

const coach = document.createElement('div');
coach.className = 'coach';
coach.hidden = true;
coach.setAttribute('role', 'status');
coach.setAttribute('aria-live', 'polite');
coach.innerHTML = '<span class="coach-count"></span><p class="coach-text"></p><button class="coach-skip" type="button">Skip tips</button>';
$('#reader').append(coach);

let active = false;
let advanceTimer = 0;
const step = () => ls.get('coachStep', STEPS.length);

function clearTarget() {
  for (const el of document.querySelectorAll('.coach-target')) el.classList.remove('coach-target');
}

const readerEl = $('#reader');
// Tips that point at a button in the top bar need the bar on screen first.
function setText() {
  const s = STEPS[step()];
  if (!s) return;
  coach.querySelector('.coach-text').textContent = s.target && readerEl.classList.contains('chrome-hidden')
    ? 'Tap the middle of the page to bring back the menus.' : s.text;
}
new MutationObserver(() => { if (active) setText(); }).observe(readerEl, { attributes: true, attributeFilter: ['class'] });

function showStep() {
  const i = step();
  clearTarget();
  if (!active || i >= STEPS.length) { coach.hidden = true; return; }
  const s = STEPS[i];
  coach.querySelector('.coach-count').textContent = `Tip ${i + 1} of ${STEPS.length}`;
  setText();
  coach.hidden = false;
  if (!reducedMotion.matches) { coach.classList.remove('pop'); void coach.offsetWidth; coach.classList.add('pop'); }
  if (s.target) $(s.target).classList.add('coach-target');
}

function finish(skipped) {
  ls.set('coachStep', STEPS.length);
  active = false;
  showStep();
  if (!skipped) toast('That’s the tour. Enjoy your books!', { ms: 3200 });
}
coach.querySelector('.coach-skip').onclick = () => finish(true);

document.addEventListener('folio:open', (e) => {
  active = e.detail.book?.fileName === SAMPLE_NAME && step() < STEPS.length;
  showStep();
});
document.addEventListener('folio:close', () => { active = false; clearTimeout(advanceTimer); showStep(); });

for (const type of new Set(STEPS.map((s) => s.on))) {
  document.addEventListener(`folio:${type}`, (e) => {
    if (!active || STEPS[step()]?.on !== type) return;
    if (type === 'bars' && !e.detail.shown) return;      // wait until the menus are back
    clearTimeout(advanceTimer);
    // A short pause so the hint doesn't vanish mid-gesture
    advanceTimer = setTimeout(() => {
      if (!active) return;
      const next = step() + 1;
      if (next >= STEPS.length) return finish(false);
      ls.set('coachStep', next);
      showStep();
    }, 500);
  });
}

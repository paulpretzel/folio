import { $, ls } from './ui.js';

const DEFAULTS = {
  v: 2,
  theme: 'auto',
  invert: true,       // dark pages in dark theme
  tapTurn: true,      // tap left/right edge to turn the page
  keepAwake: false,
  autoHide: true,     // hide the reader bars when you turn a page
  layout: 'auto',     // 'auto' | 'single' | 'double' (two-page spreads)
  resume: true,       // reopen the last book at launch
  review: true,       // show the "file your new books" sheet after adding
  sort: 'recent',
};

const stored = ls.get('settings', {}) || {};
if ((stored.v || 1) < 2) {
  // v1 was a scrolling reader where edge-tapping was off by default; paging wants it on.
  delete stored.tapTurn;
  delete stored.lastColor;
}
export const settings = { ...DEFAULTS, ...stored, v: 2 };
export const saveSettings = () => ls.set('settings', settings);

const darkMq = matchMedia('(prefers-color-scheme: dark)');

export function applyTheme() {
  const t = settings.theme === 'auto' ? (darkMq.matches ? 'dark' : 'light') : settings.theme;
  const root = document.documentElement;
  root.dataset.theme = t;
  root.classList.toggle('invert-pages', !!settings.invert);
  for (const seg of [$('#theme-seg'), $('#lib-theme-seg')]) {
    for (const b of seg.children) b.classList.toggle('active', b.dataset.theme === settings.theme);
  }
  const inReader = !$('#reader').hidden;
  const bg = getComputedStyle(root).getPropertyValue(inReader ? '--viewer-bg' : '--bg').trim();
  $('#theme-color').setAttribute('content', bg || '#f6f3ee');
}
darkMq.addEventListener?.('change', applyTheme);

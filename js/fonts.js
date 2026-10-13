/* Reading fonts for re-flowing books (EPUB, Kindle, Word, text…). PDF pages keep their own fonts.
 *
 * Android doesn't ship Arial, Helvetica, Verdana, Comic Sans or Dyslexie, and those are paid fonts,
 * so Folio bundles free, openly licensed fonts instead (vendor/fonts, licences alongside) and
 * names them honestly, with the well-known font each one resembles as a note.
 * The file list here must match the font files in sw.js's SHELL, so they work offline.
 */

const SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans", "Helvetica Neue", Arial, sans-serif';
const SERIF = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Noto Serif", serif';

// Which characters each file covers, so a browser only loads the files a book needs.
const RANGES = {
  latin: 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD',
  'latin-ext': 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF',
  cyrillic: 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116',
  greek: 'U+0370-0377,U+037A-037F,U+0384-038A,U+038C,U+038E-03A1,U+03A3-03FF',
  hebrew: 'U+0307-0308,U+0590-05FF,U+200C-2010,U+20AA,U+25CC,U+FB1D-FB4F',
  vietnamese: 'U+0102-0103,U+0110-0111,U+0128-0129,U+0168-0169,U+01A0-01A1,U+01AF-01B0,U+0300-0301,U+0303-0304,U+0308-0309,U+0323,U+0329,U+1EA0-1EF9,U+20AB',
};

/** The choices in the Tт menu, in order. `family` fonts are bundled; the others use the device's fonts. */
export const FONT_CHOICES = [
  { key: 'book', label: 'Book’s own', note: 'As designed', stack: null },
  { key: 'serif', label: 'Serif', note: 'Classic book type', stack: SERIF },
  { key: 'arimo', label: 'Arimo', note: 'Like Arial and Helvetica', family: 'Arimo', dir: 'arimo',
    subsets: ['latin', 'latin-ext', 'cyrillic', 'greek', 'hebrew', 'vietnamese'], italic: true },
  { key: 'dejavu', label: 'DejaVu Sans', note: 'Like Verdana', family: 'DejaVu Sans', dir: 'dejavu-sans',
    subsets: [null], italic: true },
  { key: 'comic', label: 'Comic Neue', note: 'Like Comic Sans', family: 'Comic Neue', dir: 'comic-neue',
    subsets: ['latin'], italic: true },
  { key: 'lexend', label: 'Lexend', note: 'Made for easy reading', family: 'Lexend', dir: 'lexend',
    subsets: ['latin', 'latin-ext', 'vietnamese'], italic: false },
  { key: 'atkinson', label: 'Atkinson Hyperlegible', note: 'Clear for low vision', family: 'Atkinson Hyperlegible',
    dir: 'atkinson-hyperlegible', subsets: ['latin', 'latin-ext'], italic: true },
  { key: 'opendyslexic', label: 'OpenDyslexic', note: 'Like Dyslexie', family: 'OpenDyslexic',
    dir: 'opendyslexic', subsets: ['latin'], italic: true },
];

const byKey = (key) => FONT_CHOICES.find((f) => f.key === key);

/** CSS font-family value for a choice, or null for "the book's own". */
export function fontStack(key) {
  const f = byKey(key);
  if (!f) return null;
  if (f.family) return `"${f.family}", ${SANS}`;      // letters the font lacks (Arabic, Thai…) fall back to the device
  return f.stack;
}

/** @font-face rules for one bundled font (or all of them), with absolute URLs so they also work inside a book's frame. */
export function fontFaceCss(key) {
  const list = key ? [byKey(key)].filter((f) => f?.family) : FONT_CHOICES.filter((f) => f.family);
  let css = '';
  for (const f of list) {
    for (const subset of f.subsets) {
      for (const weight of [400, 700]) {
        for (const style of f.italic ? ['normal', 'italic'] : ['normal']) {
          const file = subset ? `${f.dir}-${subset}-${weight}-${style}.woff2` : `${f.dir}-${weight}-${style}.woff2`;
          const url = new URL(`../vendor/fonts/${f.dir}/${file}`, import.meta.url).href;
          css += `@font-face { font-family: "${f.family}"; font-style: ${style}; font-weight: ${weight}; font-display: swap;`
            + ` src: url("${url}") format("woff2");${subset ? ` unicode-range: ${RANGES[subset]};` : ''} }\n`;
        }
      }
    }
  }
  return css;
}

let previewsLoaded = false;
/** Make the bundled fonts available to the app itself, so the font picker can show each name in its own font. */
export function loadFontPreviews() {
  if (previewsLoaded) return;
  previewsLoaded = true;
  const style = document.createElement('style');
  style.textContent = fontFaceCss();
  document.head.append(style);
}

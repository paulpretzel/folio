/* The text reader: EPUB, Kindle, FB2, Word, text and HTML books, whose text re-flows to fit the
 * screen and the reader's text size. Comics (CBZ) use the same engine, one image per page.
 *
 * This wraps foliate-js's <foliate-view> (vendor/foliate). The reader's bars, contents, bookmarks
 * and search live in reader.js and call into the controller returned by openFlow().
 *
 * Pages: a reflowing book has no fixed pages, so Folio counts 1,500-character "pages" (the same
 * unit as foliate's locations). They don't change with the text size, so "page 41" is the same
 * place on a phone and a tablet, and bookmarks and backups stay put.
 */
import '../vendor/foliate/view.js';
import { openEbookFile, pageCountOf } from './formats.js';
import { settings } from './settings.js';

export const FONTS = {
  book: null,                                            // whatever the book asks for
  serif: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Noto Serif", serif',
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif',
};

function readerCss(fixed) {
  const cs = getComputedStyle(document.documentElement);
  const bg = cs.getPropertyValue('--page-bg').trim(), fg = cs.getPropertyValue('--text').trim();
  const accent = cs.getPropertyValue('--accent').trim();
  const theme = document.documentElement.dataset.theme, dark = theme === 'dark';
  if (fixed) return `html, body { background: transparent !important; }`;
  const font = FONTS[settings.textFont] || null;
  const size = settings.textSize || 100;
  const spacing = settings.lineSpacing || 1.5;
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    html { color-scheme: ${dark ? 'dark' : 'light'}; }
    html, body { background: ${bg} !important; color: ${fg} !important; }
    html { font-size: ${size}% !important; }
    ${dark || theme === 'sepia' ? 'body * { color: inherit !important; background-color: transparent !important; }' : ''}
    a:link, a:visited { color: ${accent} !important; }
    ${font ? `body, body * { font-family: ${font} !important; }` : ''}
    p, li, blockquote, dd { line-height: ${spacing} !important; -webkit-hyphens: auto; hyphens: auto; widows: 2; orphans: 2; }
    img, svg, video { max-width: 100%; }
    ${dark ? 'img { filter: brightness(.88); }' : ''}
    pre { white-space: pre-wrap !important; }
    aside[epub|type~="footnote"], aside[epub|type~="endnote"], aside[epub|type~="note"], aside[epub|type~="rearnote"] { display: none; }
  `;
}

/**
 * Open a non-PDF book in `container`.
 * hooks: onRelocate(loc) on every page turn · onTap({x, y}) for taps that aren't on a link ·
 *        onKey(event) for key presses inside the book · onWheel(event)
 */
export async function openFlow({ data, format, fileName, container, start, hooks }) {
  const blob = new Blob([data]);
  const book = await openEbookFile(blob, format, fileName);
  const view = document.createElement('foliate-view');
  container.append(view);
  try { await view.open(book); } catch (e) { view.remove(); throw e; }
  const fixed = view.isFixedLayout;
  const r = view.renderer;
  if (!fixed) {
    r.setAttribute('flow', 'paginated');
    r.setAttribute('gap', '7%');
    r.setAttribute('margin', '52px');                     // clear of the top bar, and room for the page number below
    r.setAttribute('max-inline-size', '680px');
  }
  r.setAttribute('animated', '');

  const total = pageCountOf(book);
  let loc = null;

  view.addEventListener('load', ({ detail: { doc } }) => {
    const frame = doc.defaultView?.frameElement;
    doc.addEventListener('click', (e) => {
      if (e.defaultPrevented || e.target.closest?.('a[href]')) return;
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed) return;
      const box = frame?.getBoundingClientRect() || { left: 0, top: 0 };
      hooks.onTap?.({ x: box.left + e.clientX, y: box.top + e.clientY });
    });
    doc.addEventListener('keydown', (e) => hooks.onKey?.(e));
    doc.addEventListener('wheel', (e) => hooks.onWheel?.(e), { passive: false });
  });
  // Taps on the page margins land outside the book's own document.
  view.addEventListener('click', (e) => hooks.onTap?.({ x: e.clientX, y: e.clientY }));
  view.addEventListener('wheel', (e) => hooks.onWheel?.(e), { passive: false });
  view.addEventListener('external-link', (e) => {
    // Links out of the book open in the browser, never inside Folio.
    e.preventDefault();
    window.open(e.detail.a.href, '_blank', 'noopener');
  });

  view.addEventListener('relocate', ({ detail: d }) => {
    let page, next;
    if (fixed) { page = (d.section?.current ?? 0) + 1; next = page; }
    else { page = (d.location?.current ?? 0) + 1; next = (d.location?.next ?? page - 1) + 1; }
    loc = {
      page: Math.min(page, total), last: Math.min(Math.max(next, page), total), total,
      fraction: d.fraction ?? 0, cfi: d.cfi, range: d.range,
      chapter: fixed ? '' : d.tocItem?.label?.trim() || '', chapterHref: d.tocItem?.href || null,
      minutesLeftInChapter: fixed ? null : Math.round(d.time?.section ?? 0),
    };
    hooks.onRelocate?.(loc);
  });

  const ctl = {
    view, book, fixed, total,
    get loc() { return loc; },
    toc: fixed ? [] : flattenToc(book.toc || []),       // a comic's "contents" would just be its image file names
    applyStyles() {
      r.setStyles?.(readerCss(fixed));
      if (!fixed) {
        const cols = settings.layout === 'single' ? 1 : 2;   // 'auto' and 'double': two columns when the screen is wide
        r.setAttribute('max-column-count', String(cols));
        r.setAttribute('max-inline-size', settings.layout === 'double' ? '560px' : '680px');
      }
      container.style.background = fixed ? '' : getComputedStyle(document.documentElement).getPropertyValue('--page-bg');
    },
    next: () => view.next(),
    prev: () => view.prev(),
    goLeft: () => view.goLeft(),
    goRight: () => view.goRight(),
    goTo: (target) => view.goTo(target),
    goToPage(n) {
      n = Math.max(1, Math.min(total, Math.round(n)));
      if (fixed) return view.goTo(n - 1);
      return view.goToFraction((n - 0.5) / total);       // aim for the middle of that page, so the screen lands on it
    },
    /** Is the position `cfi` on the screen right now? */
    isVisible(cfi) {
      if (!loc?.range || !cfi) return false;
      try {
        const { index, anchor } = view.resolveNavigation(cfi);
        const shown = r.getContents()[0];
        if (!shown || shown.index !== index) return false;
        const target = anchor(shown.doc);                  // a Range from the book's frame (so not `instanceof Range` here)
        if (!target?.startContainer) return false;
        return loc.range.comparePoint(target.startContainer, target.startOffset) === 0;
      } catch { return false; }
    },
    async *search(query) {
      for await (const res of view.search({ query })) {
        if (res === 'done') return;
        if (res.subitems) for (const s of res.subitems) yield { cfi: s.cfi, excerpt: s.excerpt, chapter: res.label || '' };
        else if (res.progress != null) yield { progress: res.progress };
      }
    },
    clearSearch: () => view.clearSearch(),
    sectionLabelAt(fraction) {
      if (fixed) return '';
      const f = view.getSectionFractions();
      let i = f.findIndex((x) => x > fraction) - 1;
      if (i < 0) i = f.length - 1;
      const { tocItem } = view.getProgressOf(Math.max(0, i)) || {};
      return tocItem?.label?.trim() || '';
    },
    destroy() {
      try { view.close(); } catch {}
      try { book.destroy?.(); } catch {}
      view.remove();
    },
  };
  try {
    ctl.applyStyles();
    await view.init({ lastLocation: start || null });
  } catch (e) { ctl.destroy(); throw e; }
  return ctl;
}

function flattenToc(items, depth = 0, out = []) {
  for (const it of items) {
    out.push({ title: (it.label || '').trim() || 'Untitled', depth, href: it.href });
    if (it.subitems?.length) flattenToc(it.subitems, depth + 1, out);
  }
  return out;
}

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
import { fontStack, fontFaceCss } from './fonts.js';

function readerCss(fixed) {
  const cs = getComputedStyle(document.documentElement);
  const bg = cs.getPropertyValue('--page-bg').trim(), fg = cs.getPropertyValue('--text').trim();
  const accent = cs.getPropertyValue('--accent').trim();
  const theme = document.documentElement.dataset.theme, dark = theme === 'dark';
  if (fixed) return `html, body { background: transparent !important; }`;
  const font = fontStack(settings.textFont);
  const size = settings.textSize || 100;
  const spacing = settings.lineSpacing || 1.5;
  return `
    @namespace epub "http://www.idpf.org/2007/ops";
    ${font ? fontFaceCss(settings.textFont) : ''}
    html { color-scheme: ${dark ? 'dark' : 'light'}; -webkit-tap-highlight-color: transparent; }
    body { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; }
    html, body { background: ${bg} !important; color: ${fg} !important; }
    html { font-size: ${size}% !important; }
    ${dark || theme === 'sepia' ? 'body * { color: inherit !important; background-color: transparent !important; }' : ''}
    a:link, a:visited { color: ${accent} !important; }
    ${font ? `body, body *:not(pre, code, kbd, samp, tt, pre *) { font-family: ${font} !important; }` : ''}
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
 *        onKey(event) for key presses inside the book · onWheel(event) ·
 *        onPinch(scale) when two fingers pinch the page (the reader changes the text size)
 */
export async function openFlow({ data, format, fileName, container, start, dir, hooks }) {
  const blob = new Blob([data]);
  const book = await openEbookFile(blob, format, fileName);
  if (dir) book.dir = dir;                               // the reader chose a direction for this book
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
  // foliate re-lays out the page whenever its box resizes, even while a chapter's frame is between
  // documents (it then throws); skip those moments, the chapter lays itself out once it has loaded.
  const render = r.render.bind(r);
  r.render = () => { const doc = r.getContents()[0]?.doc; if (doc?.documentElement && doc.body) render(); };

  const total = pageCountOf(book);
  let loc = null;

  // Pinching a reflowing page makes its text bigger or smaller, and the pages re-flow: the book
  // keeps turning page by page. While the fingers move, the page is scaled as a preview.
  let pinch = null, pinchedAt = 0;
  const justPinched = () => performance.now() - pinchedAt < 400;
  const spread = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY) || 1;
  const touchStart = (e) => {
    if (fixed || e.touches.length !== 2) return;
    e.preventDefault();
    pinch = { d0: spread(e.touches), k: 1 };
  };
  const touchMove = (e) => {
    if (!pinch || e.touches.length < 2) return;
    e.preventDefault();
    pinch.k = Math.min(2.5, Math.max(0.4, spread(e.touches) / pinch.d0));
    view.style.transform = `scale(${pinch.k})`;
  };
  const touchEnd = (e) => {
    if (!pinch || e.touches.length >= 2) return;
    const { k } = pinch;
    pinch = null;
    pinchedAt = performance.now();                       // the fingers lifting isn't a tap
    view.style.transform = '';
    if (Math.abs(k - 1) > 0.08) hooks.onPinch?.(k);
  };
  const listenPinch = (el) => {
    el.addEventListener('touchstart', touchStart, { passive: false });
    el.addEventListener('touchmove', touchMove, { passive: false });
    el.addEventListener('touchend', touchEnd);
    el.addEventListener('touchcancel', touchEnd);
  };
  listenPinch(view);

  view.addEventListener('load', ({ detail: { doc } }) => {
    // foliate reads the direction from each chapter's document as it loads it, so set it there.
    if (dir) { doc.documentElement.dir = dir; if (doc.body) doc.body.dir = dir; }
    const frame = doc.defaultView?.frameElement;
    doc.addEventListener('click', (e) => {
      if (e.defaultPrevented || justPinched() || e.target.closest?.('a[href]')) return;
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed) return;
      const box = frame?.getBoundingClientRect() || { left: 0, top: 0 };
      hooks.onTap?.({ x: box.left + e.clientX, y: box.top + e.clientY });
    });
    listenPinch(doc);
    doc.addEventListener('keydown', (e) => hooks.onKey?.(e));
    doc.addEventListener('wheel', (e) => hooks.onWheel?.(e), { passive: false });
  });
  // Taps on the page margins land outside the book's own document.
  view.addEventListener('click', (e) => { if (!justPinched()) hooks.onTap?.({ x: e.clientX, y: e.clientY }); });
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

  const rtl = dir ? dir === 'rtl' : book.dir === 'rtl' || view.language?.direction === 'rtl';
  const ctl = {
    view, book, fixed, total, rtl,
    get loc() { return loc; },
    toc: fixed ? [] : flattenToc(book.toc || []),       // a comic's "contents" would just be its image file names
    applyStyles() {
      r.setStyles?.(readerCss(fixed));
      if (!fixed) {
        // auto: two pages side by side on a wide landscape screen · single: always one · double (Spread): always two
        const cols = settings.layout === 'single' ? 1 : 2;
        const both = settings.layout === 'double';
        r.setAttribute('max-column-count', String(cols));
        r.setAttribute('max-column-count-portrait', both ? '2' : '1');
        r.setAttribute('max-inline-size', both ? `${Math.max(120, Math.min(560, Math.floor(container.clientWidth / 2) - 1))}px` : '680px');
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
      resized.disconnect();
      r.render = () => {};                                // the paginator's resize observer outlives close()
      try { view.close(); } catch {}
      try { book.destroy?.(); } catch {}
      view.remove();
    },
  };
  // Spread's page width depends on the screen width, so set it again when the screen turns.
  let lastWidth = container.clientWidth;
  const resized = new ResizeObserver(() => {
    if (container.clientWidth === lastWidth) return;
    lastWidth = container.clientWidth;
    if (!fixed && settings.layout === 'double') ctl.applyStyles();
  });
  resized.observe(container);
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

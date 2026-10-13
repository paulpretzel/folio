/* Book formats: which files Folio can open, and turning each one into something a reader can show.
 *
 *   PDF                         → the page reader (reader.js + pdf.js)
 *   EPUB, MOBI/AZW3, FB2, CBZ   → foliate-js books (vendor/foliate), shown by the text reader (flow.js)
 *   Word (.docx), text, Markdown, HTML → converted here into the same kind of book
 *
 * Store-locked books (DRM) are recognised and explained, never unlocked.
 * Everything runs on the device.
 */

export const FORMAT_LABELS = {
  pdf: 'PDF', epub: 'EPUB', mobi: 'Kindle', fb2: 'FB2', cbz: 'Comic', docx: 'Word', txt: 'Text', md: 'Markdown', html: 'Web page',
};

/** Thrown for files Folio can't open. `title` and `message` are written for the reader. */
export class FormatError extends Error {
  constructor(title, message, { locked = false } = {}) {
    super(message);
    this.name = 'FormatError';
    this.title = title;
    this.locked = locked;
  }
}

const LOCKED = {
  kindle: ['This Kindle book is locked', 'Books bought from Amazon are locked to the Kindle app, so open this one there. Folio can open Kindle files that aren’t locked, such as ones you made yourself or downloaded DRM-free.'],
  adobe: ['This book is copy-protected', 'It uses Adobe DRM, which libraries and many ebook stores add. Open it in the app it came from, such as Libby, Kobo or Google Play Books.'],
  apple: ['This book is locked to Apple Books', 'Books bought from Apple only open in Apple Books.'],
  lcp: ['This book is copy-protected', 'It’s a library loan or store book protected with Readium LCP. Open it in the app it came from, such as your library’s reading app.'],
  acsm: ['This is a download ticket, not the book', 'An .acsm file only tells Adobe Digital Editions where to fetch a copy-protected book. Open it in Adobe Digital Editions or the store’s own app instead.'],
  other: ['This book is copy-protected', 'It’s locked to the store or library app it came from, so open it there.'],
};
const locked = (k) => new FormatError(...LOCKED[k], { locked: true });

const SAVE_AS = 'Open it in Word, Pages or Google Docs and save it as a .docx or PDF, then add that.';
const unsupported = (title, message = 'Folio opens PDF, EPUB, Kindle (MOBI and AZW3), Word (.docx), FB2, comic (CBZ), text, Markdown and HTML files.') =>
  new FormatError(title, message);

/* ================================================================
   Working out what a file is
   ================================================================ */
const ext = (name) => (/\.([a-z0-9]+)$/i.exec(name || '')?.[1] || '').toLowerCase();
const ascii = (bytes, from, to) => String.fromCharCode(...bytes.subarray(from, to));
const startsWith = (bytes, sig) => sig.every((b, i) => bytes[i] === b);

async function zipEntries(blob) {
  const { configure, ZipReader, BlobReader, TextWriter } = await import('../vendor/foliate/vendor/zip.js');
  configure({ useWebWorkers: false });
  const reader = new ZipReader(new BlobReader(blob));
  const entries = await reader.getEntries();
  const map = new Map(entries.map((e) => [e.filename, e]));
  return { names: new Set(map.keys()), text: (name) => map.get(name)?.getData(new TextWriter()) ?? null };
}

// Font obfuscation isn't DRM: these EPUBs open fine.
const FONT_OBFUSCATION = new Set(['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC']);

async function checkEpubLock(zip) {
  if (zip.names.has('META-INF/license.lcpl')) throw locked('lcp');
  if (zip.names.has('META-INF/sinf.xml')) throw locked('apple');
  if (zip.names.has('META-INF/rights.xml')) throw locked('adobe');
  const enc = await zip.text('META-INF/encryption.xml');
  if (!enc) return;
  const doc = new DOMParser().parseFromString(enc, 'application/xml');
  const algos = [...doc.getElementsByTagNameNS('*', 'EncryptionMethod')].map((m) => m.getAttribute('Algorithm'));
  if (algos.some((a) => !FONT_OBFUSCATION.has(a))) throw locked('other');
}

function checkMobiLock(bytes) {
  // PalmDB header, then the record list; the first record starts with the PalmDOC header,
  // whose "encryption" field is 0 for an unlocked book.
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 86) return;
  const rec0 = dv.getUint32(78);
  if (rec0 + 14 <= bytes.length && dv.getUint16(rec0 + 12) !== 0) throw locked('kindle');
}

/**
 * Work out a file's format from its first bytes (and its name, where bytes can't tell).
 * Returns 'pdf' | 'epub' | 'mobi' | 'fb2' | 'cbz' | 'docx' | 'txt' | 'md' | 'html',
 * or throws a FormatError that explains why the file can't be opened.
 */
export async function sniff(file) {
  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer());
  const e = ext(file.name);
  const text = new TextDecoder('utf-8', { fatal: false }).decode(head.subarray(0, 1024));

  if (text.includes('%PDF-')) return 'pdf';
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) {
    const zip = await zipEntries(file);
    if (zip.names.has('word/document.xml')) return 'docx';
    if (e === 'cbz') return 'cbz';
    if (e === 'fbz' || [...zip.names].some((n) => n.endsWith('.fb2'))) return 'fb2';
    const mime = (await zip.text('mimetype'))?.trim();
    if (mime === 'application/epub+zip' || zip.names.has('META-INF/container.xml')) {
      await checkEpubLock(zip);
      return 'epub';
    }
    if (zip.names.has('content.xml') && /opendocument/.test(mime || '')) throw unsupported('OpenDocument files can’t be opened', SAVE_AS);
    if ([...zip.names].some((n) => /\.(jpe?g|png|gif|webp|avif)$/i.test(n))) return 'cbz';
    if ([...zip.names].some((n) => n.endsWith('.kfx'))) throw unsupported('KFX Kindle files can’t be opened', 'This newer Kindle format only opens in the Kindle app.');
    throw unsupported('Folio can’t open this zip file');
  }
  if (head.length >= 68 && ascii(head, 60, 68) === 'BOOKMOBI') {
    checkMobiLock(new Uint8Array(await file.slice(0, Math.min(file.size, 1 << 20)).arrayBuffer()));
    return 'mobi';
  }
  if (head.length >= 68 && ascii(head, 60, 68) === 'TEXtREAd') throw unsupported('Old Palm ebooks can’t be opened');
  if (ascii(head, 0, 8) === '\xeaDRMION\xee') throw locked('kindle');
  if (ascii(head, 0, 4) === 'CONT' || e === 'kfx') throw unsupported('KFX Kindle files can’t be opened', 'This newer Kindle format only opens in the Kindle app.');
  if (startsWith(head, [0xd0, 0xcf, 0x11, 0xe0])) throw unsupported('Older Word files (.doc) can’t be opened', SAVE_AS);
  if (text.startsWith('{\\rtf')) throw unsupported('RTF files can’t be opened', SAVE_AS);
  if (/<fulfillmentToken|adept:/.test(text) || e === 'acsm') throw locked('acsm');
  if (/<FictionBook/.test(text)) return 'fb2';
  if (/<html|<!doctype html/i.test(text) || ['html', 'htm', 'xhtml'].includes(e)) return 'html';
  if (['md', 'markdown'].includes(e)) return 'md';
  if (looksLikeText(head)) return 'txt';
  if (['pdf', 'epub', 'mobi', 'azw', 'azw3', 'fb2', 'cbz', 'docx'].includes(e)) throw unsupported('This file looks damaged', 'Folio couldn’t read it. Try downloading it again.');
  throw unsupported('Folio can’t open this kind of file');
}

function looksLikeText(bytes) {
  if (!bytes.length) return false;
  let bad = 0;
  for (const b of bytes) if (b === 0 || (b < 9) || (b > 13 && b < 32 && b !== 27)) bad++;
  return bad / bytes.length < 0.01;
}

/* ================================================================
   Opening a book
   ================================================================ */
const FOLIATE_NAME = { epub: 'book.epub', mobi: 'book.mobi', fb2: 'book.fb2', cbz: 'book.cbz' };

/** A foliate-js book object for any non-PDF format. */
export async function openEbookFile(blob, format, fileName = '') {
  if (format === 'docx') return docxBook(blob, fileName);
  if (format === 'txt' || format === 'md' || format === 'html') return textBook(blob, format, fileName);
  const { makeBook } = await import('../vendor/foliate/view.js');
  let name = FOLIATE_NAME[format];
  if (format === 'fb2' && startsWith(new Uint8Array(await blob.slice(0, 4).arrayBuffer()), [0x50, 0x4b, 0x03, 0x04])) name = 'book.fbz';
  // foliate picks CBZ / FB2 handling from the file name, so give it a predictable one.
  return makeBook(new File([blob], name, { type: blob.type }));
}

const LOC_SIZE = 1500;          // characters per "page" in reflowing books; the same unit flow.js shows

/** Pages for the library: real pages for comics, otherwise 1,500-character pages (stable whatever the text size). */
export function pageCountOf(book) {
  if (book.rendition?.layout === 'pre-paginated') return book.sections.length;
  const total = book.sections.reduce((n, s) => n + (s.linear !== 'no' && s.size > 0 ? s.size : 0), 0);
  return Math.max(1, Math.ceil(total / LOC_SIZE));
}

const langMap = (x) => (!x ? '' : typeof x === 'string' ? x : Object.values(x)[0] || '');
const contributor = (c) => (Array.isArray(c) ? c.map(contributor).filter(Boolean).join(', ') : typeof c === 'string' ? c : langMap(c?.name));

/** Title, author and other details for the library, from the book's own metadata. */
export function ebookInfo(book) {
  const m = book.metadata || {};
  const ids = [m.identifier, ...(Array.isArray(m.altIdentifier) ? m.altIdentifier : [m.altIdentifier])].flat().filter(Boolean).map(String);
  const isbn = ids.map((s) => s.replace(/^urn:isbn:|^isbn:?/i, '').replace(/[\s-]/g, '')).find((s) => /^(97[89]\d{10}|\d{9}[\dX])$/.test(s)) || null;
  const year = +String(m.published || '').match(/\b(1[5-9]\d\d|20\d\d)\b/)?.[1] || null;
  const subjects = [m.subject].flat().filter(Boolean).map((s) => langMap(s?.name ?? s)).join(' ').toLowerCase();
  return { title: langMap(m.title).trim(), author: contributor(m.author).trim(), isbn, year, subjects, language: m.language };
}

/* ================================================================
   Word, text, Markdown and HTML → a foliate book
   ================================================================ */
let mammothLoad;
function loadMammoth() {
  return (mammothLoad ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = new URL('../vendor/mammoth/mammoth.browser.min.js', import.meta.url).href;
    s.onload = () => resolve(window.mammoth);
    s.onerror = () => { mammothLoad = null; reject(new Error('Couldn’t load the Word reader')); };
    document.head.append(s);
  }));
}

async function docxBook(blob, fileName) {
  const mammoth = await loadMammoth();
  const { value: html } = await mammoth.convertToHtml({ arrayBuffer: await blob.arrayBuffer() });
  let title = '', author = '';
  try {
    const core = await (await zipEntries(blob)).text('docProps/core.xml');
    if (core) {
      const d = new DOMParser().parseFromString(core, 'application/xml');
      title = d.getElementsByTagNameNS('*', 'title')[0]?.textContent?.trim() || '';
      author = d.getElementsByTagNameNS('*', 'creator')[0]?.textContent?.trim() || '';
    }
  } catch {}
  return htmlBook({ html, title, author, fileName });
}

async function textBook(blob, format, fileName) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let text = new TextDecoder('utf-8').decode(buf);
  if ((text.match(/�/g) || []).length > 8) text = new TextDecoder('windows-1252').decode(buf);
  if (format === 'html') {
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const styles = [...doc.querySelectorAll('style')].map((s) => s.textContent).join('\n');
    return htmlBook({ html: doc.body?.innerHTML || '', title: doc.title, author: doc.querySelector('meta[name=author]')?.content || '', styles, fileName });
  }
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  let title = '', author = '';
  if (format === 'txt') ({ text, title, author } = trimGutenberg(text));
  if (format === 'md') {
    // YAML front matter (title: …, author: …) as written by Obsidian, Jekyll, pandoc…
    const fm = /^---\n([\s\S]*?)\n(?:---|\.\.\.)\n/.exec(text);
    if (fm) {
      const field = (k) => new RegExp(`^${k}:\\s*["']?(.*?)["']?\\s*$`, 'mi').exec(fm[1])?.[1] || '';
      title = field('title'); author = field('author');
      text = text.slice(fm[0].length);
    }
  }
  return htmlBook({ html: format === 'md' ? markdownToHtml(text) : plainToHtml(text), title, author, fileName });
}

/** Project Gutenberg plain-text files carry a long licence header and footer; keep just the book. */
function trimGutenberg(text) {
  const start = /^\*\*\* ?START OF (THE|THIS) PROJECT GUTENBERG.*$/im.exec(text);
  const end = /^\*\*\* ?END OF (THE|THIS) PROJECT GUTENBERG.*$/im.exec(text);
  if (!start) return { text, title: '', author: '' };
  const header = text.slice(0, start.index);
  return {
    text: text.slice(start.index + start[0].length, end ? end.index : undefined),
    title: /^Title:\s*(.+)$/m.exec(header)?.[1]?.trim() || '',
    author: /^Author:\s*(.+)$/m.exec(header)?.[1]?.trim() || '',
  };
}

const escHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const HEADING = /^(chapter|book|part|volume|section|letter|act|canto|prologue|epilogue|preface|foreword|introduction|afterword|appendix|contents)\b[^.!?]{0,60}[.:]?$|^[IVXLC]+\.?$/i;

function plainToHtml(text) {
  let blocks = text.split(/\n[ \t]*\n+/);
  if (blocks.length < 3 && text.split('\n').length > 20) blocks = text.split('\n');   // one paragraph per line
  return blocks.map((b) => b.replace(/^\n+|\s+$/g, '')).filter((b) => b.trim()).map((b) => {
    const lines = b.split('\n').map((l) => l.trim());
    const one = lines.join(' ');
    if (lines.length <= 2 && one.length <= 70 && (HEADING.test(one) || (one === one.toUpperCase() && /[A-Z]/.test(one) && one.split(/\s+/).length <= 8))) {
      return `<h2>${escHtml(one)}</h2>`;
    }
    const avg = lines.reduce((n, l) => n + l.length, 0) / lines.length;
    // Short lines are verse or an address: keep the breaks. Long ones are hard-wrapped prose.
    return lines.length > 1 && avg < 45 ? `<p class="verse">${lines.map(escHtml).join('<br>')}</p>` : `<p>${escHtml(one)}</p>`;
  }).join('\n');
}

function inlineMd(s) {
  return escHtml(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a, b) => `<strong>${a || b}</strong>`)
    .replace(/\*([^*\s][^*]*)\*|\b_([^_]+)_\b/g, (_, a, b) => `<em>${a || b}</em>`)
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_, t, u) => `<a href="${u}">${t}</a>`);
}
function markdownToHtml(text) {
  const out = [];
  let para = [], list = null, quote = [], code = null;
  const flush = () => {
    if (para.length) out.push(`<p>${inlineMd(para.join(' '))}</p>`); para = [];
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inlineMd(i)}</li>`).join('')}</${list.tag}>`); list = null;
    if (quote.length) out.push(`<blockquote><p>${inlineMd(quote.join(' '))}</p></blockquote>`); quote = [];
  };
  for (const line of text.split('\n')) {
    if (code) { if (/^```/.test(line)) { out.push(`<pre><code>${escHtml(code.join('\n'))}</code></pre>`); code = null; } else code.push(line); continue; }
    let m;
    if (/^```/.test(line)) { flush(); code = []; }
    else if ((m = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line))) { flush(); out.push(`<h${m[1].length}>${inlineMd(m[2])}</h${m[1].length}>`); }
    else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { flush(); out.push('<hr>'); }
    else if ((m = /^\s*([-*+]|\d+[.)])\s+(.*)$/.exec(line))) {
      const tag = /\d/.test(m[1]) ? 'ol' : 'ul';
      if (para.length || quote.length || (list && list.tag !== tag)) flush();
      (list ||= { tag, items: [] }).items.push(m[2]);
    }
    else if ((m = /^>\s?(.*)$/.exec(line))) { if (para.length || list) flush(); quote.push(m[1]); }
    else if (!line.trim()) flush();
    else if (list && /^\s+/.test(line)) list.items[list.items.length - 1] += ' ' + line.trim();
    else { if (list || quote.length) flush(); para.push(line.trim()); }
  }
  if (code) out.push(`<pre><code>${escHtml(code.join('\n'))}</code></pre>`);
  flush();
  return out.join('\n');
}

const BASE_CSS = `
  body { margin: 0; }
  h1, h2, h3 { line-height: 1.25; margin: 1.4em 0 .6em; break-after: avoid; }
  h1 { font-size: 1.6em; } h2 { font-size: 1.3em; } h3 { font-size: 1.1em; }
  p { margin: 0 0 .8em; }
  p.verse { text-align: left !important; }
  img { max-width: 100%; height: auto; }
  table { border-collapse: collapse; } td, th { border: 1px solid rgb(128 128 128 / .4); padding: .2em .4em; }
  pre { white-space: pre-wrap; font-size: .9em; }
  blockquote { margin: 0 0 .8em 1.2em; font-style: italic; }
`;
const MAX_SECTION = 120_000;    // characters; long sections make page turns sluggish on phones

/** Build a foliate-js book from a chunk of HTML: split into sections at its main headings, with a contents list. */
export function htmlBook({ html, title = '', author = '', styles = '', fileName = '' }) {
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, 'text/html');
  for (const el of doc.querySelectorAll('script, iframe, object, embed, form, link, meta, base')) el.remove();
  for (const el of doc.querySelectorAll('*')) {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || (/^(href|src|xlink:href)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
    }
  }
  const body = doc.body;
  // Mostly Hebrew, Arabic or another right-to-left script? Then the book reads right to left.
  const sample = body.textContent.slice(0, 20000);
  const letters = (sample.match(/\p{L}/gu) || []).length;
  const rtl = letters > 40 && (sample.match(/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g) || []).length / letters > 0.3;

  // Split at the highest heading level that appears more than once (a chapter level).
  const level = ['h1', 'h2', 'h3'].find((h) => body.querySelectorAll(`:scope > ${h}`).length >= 2);
  const groups = [[]];
  for (const node of [...body.childNodes]) {
    const cur = groups[groups.length - 1];
    const size = cur.reduce((n, x) => n + (x.textContent?.length || 0), 0);
    const isBreak = (level && node.nodeName.toLowerCase() === level) || size > MAX_SECTION;
    if (isBreak && cur.some((x) => x.textContent?.trim() || x.nodeName === 'IMG')) groups.push([]);
    groups[groups.length - 1].push(node);
  }

  const idSection = new Map();
  const toc = [];
  let n = 0;
  const sections = groups.map((nodes, index) => {
    const holder = doc.createElement('div');
    holder.append(...nodes);
    for (const el of holder.querySelectorAll('[id]')) idSection.set(el.id, index);
    for (const h of holder.querySelectorAll('h1, h2, h3')) {
      const depth = +h.tagName[1] - 1;
      if (!level || depth > +level[1]) continue;            // the contents list only goes one level below chapters
      if (!h.id) h.id = `h${++n}`;
      idSection.set(h.id, index);
      const label = h.textContent.replace(/\s+/g, ' ').trim();
      if (label) toc.push({ label: label.slice(0, 120), href: `${index}#${h.id}`, depth });
    }
    const markup = `<!DOCTYPE html><html${rtl ? ' dir="rtl"' : ''}><head><meta charset="utf-8"><title></title><style>${BASE_CSS}${styles}</style></head><body>${holder.innerHTML}</body></html>`;
    let url = null;
    return {
      id: String(index),
      linear: 'yes',
      size: holder.textContent.length + holder.querySelectorAll('img').length * 600,
      load: () => (url ||= URL.createObjectURL(new Blob([markup], { type: 'text/html' }))),
      unload: () => { if (url) URL.revokeObjectURL(url); url = null; },
      createDocument: () => new DOMParser().parseFromString(markup, 'text/html'),
      resolveHref: (href) => (href.startsWith('#') && idSection.has(href.slice(1)) ? `${idSection.get(href.slice(1))}${href}` : href),
    };
  });

  // Nest the flat list (h1 → h2) the way foliate's contents expect.
  const nested = [];
  const top = Math.min(...toc.map((t) => t.depth));
  for (const t of toc) {
    const item = { label: t.label, href: t.href };
    if (t.depth > top && nested.length) (nested[nested.length - 1].subitems ||= []).push(item);
    else nested.push(item);
  }

  return {
    metadata: { title, author },
    sections,
    toc: nested,
    dir: rtl ? 'rtl' : 'ltr',
    rendition: {},
    isExternal: (href) => /^[a-z][a-z0-9+.-]*:/i.test(href),
    splitTOCHref: (href) => { const [s, f] = String(href ?? '').split('#'); return [s, f || null]; },
    getTOCFragment: (d, id) => d.getElementById(id),
    resolveHref: (href) => {
      const [s, f] = String(href).split('#');
      const index = s === '' && f ? idSection.get(f) ?? 0 : +s;
      return { index: Number.isFinite(index) ? index : 0, anchor: (d) => (f && d.getElementById(f)) || 0 };
    },
    getCover: () => null,
    destroy: () => sections.forEach((s) => s.unload()),
    fileName,
  };
}

/* ================================================================
   Helpers for the library
   ================================================================ */
/** A stable id for a non-PDF book: the SHA-256 of its bytes, so re-adding it is caught and backups find it. */
export async function fileId(buf) {
  if (crypto.subtle) {
    const h = new Uint8Array(await crypto.subtle.digest('SHA-256', buf));
    return 'b' + [...h.slice(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  let a = 0x811c9dc5, b = 0x1000193;                                         // plain-http fallback (no SubtleCrypto)
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i++) { a = Math.imul(a ^ bytes[i], 16777619); b = Math.imul(b ^ bytes[i], 2246822519); }
  return 'b' + (a >>> 0).toString(16) + (b >>> 0).toString(16) + bytes.length.toString(16);
}

/** A cover thumbnail (data URL) from a cover image blob, the same size as the PDF covers. */
export async function coverFromBlob(blob) {
  if (!blob) return null;
  let url;
  try {
    url = URL.createObjectURL(blob);
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = 360, h = Math.round(img.naturalHeight * (w / img.naturalWidth)) || 540;
    const c = document.createElement('canvas');
    c.width = w; c.height = Math.min(h, 720);
    const ctx = c.getContext('2d', { alpha: false });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.drawImage(img, 0, 0, w, h);
    const out = c.toDataURL('image/jpeg', 0.8);
    c.width = c.height = 0;
    return out;
  } catch { return null; }
  finally { if (url) URL.revokeObjectURL(url); }
}

/* Work out what a PDF is the first time it's added.
 *
 * Everything here runs on-device (no lookups, nothing leaves the phone). We read
 * the embedded metadata plus the text of the first few pages, then:
 *   - pick the best title (metadata → biggest text on the cover → cleaned file name)
 *   - find an author, a checksum-valid ISBN and a copyright year
 *   - decide whether the file is scanned (no text layer)
 *   - guess the kind of document so we can suggest an album
 * These are heuristics, so the UI always lets the person correct them.
 */

export const KINDS = {
  paper:    { label: 'Research paper',  album: 'Papers & Research' },
  textbook: { label: 'Textbook',        album: 'Textbooks' },
  manual:   { label: 'Manual or guide', album: 'Manuals & Guides' },
  cookbook: { label: 'Cookbook',        album: 'Cookbooks' },
  document: { label: 'Document',        album: 'Documents' },
  slides:   { label: 'Slides',          album: 'Slides' },
  comic:    { label: 'Comic or manga',  album: 'Comics' },
  fiction:  { label: 'Fiction',         album: 'Fiction' },
  book:     { label: 'Book',            album: 'Books' },
};
// Order matters only for breaking exact ties.
const SPECIFIC = ['paper', 'manual', 'textbook', 'cookbook', 'document', 'slides', 'comic', 'fiction'];

const SAMPLE_PAGES = 8;
const SMALL_WORDS = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'of', 'on', 'or', 'the', 'to', 'vs', 'with']);

/* ---------- title / author cleaning ---------- */
export function titleCase(s) {
  return s.toLowerCase().replace(/[a-z0-9][a-z0-9'’]*/g, (w, i) => (i > 0 && SMALL_WORDS.has(w) ? w : w[0].toUpperCase() + w.slice(1)));
}

export function cleanTitle(t) {
  if (!t) return '';
  t = String(t).replace(/^(microsoft (word|powerpoint|excel)|adobe (acrobat|indesign))\s*[-–—]\s*/i, '').replace(/\s+/g, ' ').trim();
  if (t.length < 2 || t.length > 200) return '';
  if (/^(untitled|microsoft word|document\d*|title|presentation\d*|slide\s*\d*|new document|scan\d*|image\d*|print)$/i.test(t)) return '';
  if (/\.(docx?|pdf|indd|tex|pptx?|xlsx?|rtf|txt|odt)$/i.test(t)) return '';
  if (/[\\/]/.test(t) || /^[0-9a-f-]{16,}$/i.test(t)) return '';
  return t;
}

export function titleFromFileName(name) {
  let t = String(name || '').replace(/\.pdf$/i, '');
  try { t = decodeURIComponent(t); } catch {}
  t = t
    .replace(/\((?:z-?library|libgen|1lib)[^)]*\)|\[(?:z-?lib|libgen)[^\]]*\]/gi, '')
    .replace(/\b(?:z-?lib(?:rary)?\.org|libgen(?:\.\w+)?|pdfdrive(?:\.com)?)\b/gi, '')
    .replace(/\s*\(\d+\)\s*$/, '')            // "(1)" suffix browsers add to repeat downloads
    .replace(/[_+]+/g, ' ')
    .replace(/\s+/g, ' ').trim();
  if (!/\s/.test(t) && t.includes('-')) t = t.replace(/-+/g, ' ');
  if (t && t === t.toLowerCase() && /\s/.test(t)) t = titleCase(t);
  return t || String(name || '').replace(/\.pdf$/i, '') || 'Untitled';
}

function cleanAuthor(a) {
  if (!a) return '';
  a = String(a).replace(/\s+/g, ' ').trim();
  if (a.length < 3 || a.length > 90 || a.includes('@')) return '';
  if (/^(admin(istrator)?|user|unknown|owner|author|anonymous|windows user|microsoft|adobe|root|default|pc|hp|dell|lenovo|apple)$/i.test(a)) return '';
  if (/\.(com|exe|org|net)$/i.test(a) || /^[\w-]+-pc$/i.test(a) || /^\w+\s+(pc|laptop|desktop)$/i.test(a)) return '';
  return a;
}

/* ---------- ISBN ---------- */
function isbnOk(d) {
  if (d.length === 10) {
    let s = 0;
    for (let i = 0; i < 10; i++) {
      const c = d[i] === 'X' ? 10 : +d[i];
      if (Number.isNaN(c) || (d[i] === 'X' && i !== 9)) return false;
      s += c * (10 - i);
    }
    return s % 11 === 0;
  }
  if (d.length === 13 && /^97[89]\d{10}$/.test(d)) {
    let s = 0;
    for (let i = 0; i < 12; i++) s += +d[i] * (i % 2 ? 3 : 1);
    return (10 - (s % 10)) % 10 === +d[12];
  }
  return false;
}
export function findIsbn(text) {
  const re = /ISBN(?:-1[03])?\s*[:#]?\s*((?:97[89][-\s]?)?(?:\d[-\s]?){8,9}[\dXx])/gi;
  let m;
  while ((m = re.exec(text))) {
    const d = m[1].replace(/[-\s]/g, '').toUpperCase();
    if (isbnOk(d)) return d;
  }
  return '';
}

/* ---------- text layout helpers ---------- */
// Group pdf.js text items into visual lines, top to bottom.
function linesOf(items) {
  const arr = [];
  for (const it of items) {
    if (!it.str || !it.str.trim()) continue;
    arr.push({ s: it.str, x: it.transform[4], y: it.transform[5], w: it.width || 0, h: Math.abs(it.transform[3]) || it.height || 0 });
  }
  arr.sort((a, b) => b.y - a.y || a.x - b.x);
  const lines = [];
  for (const it of arr) {
    const last = lines[lines.length - 1];
    if (last && Math.abs(last.y - it.y) <= Math.max(1.5, 0.45 * Math.min(last.h || it.h, it.h || last.h))) {
      last.parts.push(it);
      last.h = Math.max(last.h, it.h);
    } else lines.push({ y: it.y, h: it.h, parts: [it] });
  }
  for (const l of lines) {
    l.parts.sort((a, b) => a.x - b.x);
    let text = '', prev = null;
    for (const p of l.parts) {
      if (prev && p.x - (prev.x + prev.w) > 0.15 * (l.h || 10) && !text.endsWith(' ') && !p.s.startsWith(' ')) text += ' ';
      text += p.s;
      prev = p;
    }
    l.text = text.replace(/\s+/g, ' ').trim();
    delete l.parts;
  }
  return lines.filter((l) => l.text);
}

function weightedMedianHeight(lines) {
  const sorted = [...lines].sort((a, b) => a.h - b.h);
  const total = sorted.reduce((n, l) => n + l.text.length, 0);
  let acc = 0;
  for (const l of sorted) { acc += l.text.length; if (acc >= total / 2) return l.h; }
  return sorted[0]?.h || 0;
}

// The biggest run of text near the top of a cover/title page.
function coverTitle(lines) {
  if (lines.length < 1) return '';
  const maxH = Math.max(...lines.map((l) => l.h));
  const med = weightedMedianHeight(lines);
  if (lines.length > 3 && maxH < med * 1.25) return '';      // flat typography: no clear title
  const big = lines.filter((l) => l.h >= maxH * 0.82 && (l.text.match(/[A-Za-zÀ-ɏ]/g) || []).length >= 2);
  if (!big.length) return '';
  const block = [big[0]];
  for (let i = 1; i < big.length; i++) {
    if (block[block.length - 1].y - big[i].y < maxH * 1.9) block.push(big[i]); else break;
  }
  let t = block.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim().replace(/[.,;:\-–—\s]+$/, '');
  if (t.length < 3 || t.length > 160 || /^[\d\s.\-/]+$/.test(t)) return '';
  if (/^(contents|table of contents|copyright|abstract|preface|foreword|acknowledg|index|dedication)/i.test(t)) return '';
  if (t === t.toUpperCase() && /[A-Z]{3}/.test(t)) t = titleCase(t);
  return t;
}

/* ---------- main entry ---------- */
export async function identify(pdf, { fileName = '', info = {} } = {}) {
  const N = pdf.numPages;
  const sampleN = Math.min(N, SAMPLE_PAGES);
  const pages = [];
  for (let i = 1; i <= sampleN; i++) {
    try {
      const page = await pdf.getPage(i);
      const [tc, vp] = [await page.getTextContent(), page.getViewport({ scale: 1 })];
      pages.push({ lines: linesOf(tc.items), w: vp.width, h: vp.height });
    } catch { pages.push({ lines: [], w: 0, h: 0 }); }
  }
  const pageText = (p) => p.lines.map((l) => l.text).join('\n');
  const full = pages.map(pageText).join('\n\n').slice(0, 80000);
  const fullL = full.toLowerCase();
  const early = pages.slice(0, 2).map(pageText).join('\n').toLowerCase();
  const hint = [fileName, info.Title, info.Subject, info.Keywords].filter(Boolean).join(' ').toLowerCase();
  const all = fullL + '\n' + hint;
  const charsPerPage = pages.map((p) => (pageText(p).match(/[\p{L}\p{N}]/gu) || []).length);
  const avgChars = sampleN ? charsPerPage.reduce((a, b) => a + b, 0) / sampleN : 0;
  // A scan has (almost) no text on most pages. Title-only slides still have a few words each.
  const scanned = N > 0 && charsPerPage.filter((c) => c < 8).length / sampleN >= 0.75;
  const aspect = pages[0]?.h ? pages[0].w / pages[0].h : 0;

  /* title */
  const metaTitle = cleanTitle(info.Title);
  const fileTitle = titleFromFileName(fileName);
  let cover = '';
  for (const p of pages.slice(0, 2)) { cover = coverTitle(p.lines); if (cover) break; }
  let title, titleSource;
  if (metaTitle) { title = metaTitle; titleSource = 'metadata'; }
  else if (cover) {
    // A lone generic word ("INVOICE", "Report") says less than the file name does; any other cover title wins.
    const generic = /^(invoice|receipt|statement|contract|agreement|report|resume|cv|form|letter|memo|menu|certificate|ticket|notes|scan|document|application|proposal|summary|presentation)s?$/i.test(cover);
    if (generic && fileTitle.length > cover.length) { title = fileTitle; titleSource = 'filename'; }
    else { title = cover; titleSource = 'cover'; }
  } else { title = fileTitle; titleSource = 'filename'; }

  /* author */
  let author = cleanAuthor(info.Author);
  if (!author) {
    for (const p of pages.slice(0, 2)) {
      const m = p.lines.map((l) => l.text.match(/^by\s+([A-Z][^\d@]{2,60})$/)).find(Boolean);
      if (m) { author = cleanAuthor(m[1]); break; }
    }
  }

  const isbn = findIsbn(full);
  const ym = full.match(/(?:©|\(c\)|copyright)\s*(?:by\s+)?(?:[^\d\n]{0,40})?((?:19|20)\d{2})/i);
  const year = ym ? +ym[1] : 0;

  /* kind */
  const hits = (re) => (all.match(re) || []).length;
  const S = Object.fromEntries(Object.keys(KINDS).map((k) => [k, 0]));

  // research paper
  if (/\babstract\b/.test(early)) S.paper += 3;
  if (/\bkeywords?\b|\bindex terms\b/.test(early)) S.paper += 2;
  if (/\barxiv\b|\bdoi\b|doi\.org/.test(all)) S.paper += 2;
  if (hits(/\bet al\.?/g) >= 2) S.paper += 1.5;
  if (/\bjournal\b|\bproceedings\b|\bconference on\b|\bieee\b|\bacm\b|\bspringer\b|\belsevier\b|\bpreprint\b/.test(early)) S.paper += 2;
  if (/\bdepartment of\b|\buniversity\b|\binstitute\b/.test(early)) S.paper += 1;
  if (hits(/\[\d{1,3}\]/g) >= 5) S.paper += 1.5;
  if (/\breferences\b|\bbibliography\b/.test(fullL)) S.paper += 0.5;
  if (N >= 3 && N <= 60) S.paper += 1; else if (N > 120) S.paper -= 3;

  // textbook
  S.textbook += Math.min(hits(/review questions|learning objectives|key terms|chapter summary|problem sets?|study guide|end-of-chapter|practice problems|worked examples?|learning outcomes|check your understanding/g), 2) * 2;
  const ex = hits(/\bexercises?\b/g);
  S.textbook += ex >= 3 ? 2 : ex ? 1 : 0;
  if (/\b(?:\d+(?:st|nd|rd|th)|first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth) edition\b/.test(all)) S.textbook += 2;
  if (hits(/\bstudents?\b|\bcourse\b|\blecture\b|\bsyllabus\b|\binstructors?\b/g) >= 3) S.textbook += 1.5;
  if (hits(/\bchapter \d+|\bchapter [ivxl]+\b/g) >= 2) S.textbook += 1;
  if (N >= 120) S.textbook += 1;

  // manual / guide
  if (/user'?s? (?:guide|manual)|owner'?s? (?:manual|guide)|instruction manual|installation guide|quick start guide|reference manual|service manual|operating instructions|user handbook|getting started guide/.test(all)) S.manual += 4;
  if (/\btroubleshooting\b/.test(all)) S.manual += 2;
  if (/\bspecifications?\b/.test(all)) S.manual += 1.5;
  if (/\bwarranty\b/.test(all)) S.manual += 1.5;
  if (/\bsafety (?:instructions|information|precautions|warnings?)\b|\bwarning:|\bcaution:/.test(all)) S.manual += 1.5;
  if (hits(/\b(?:press|tap) the\b|\bclick (?:on )?the\b|\bselect the\b/g) >= 3) S.manual += 1;
  if (/\binstallation\b|\bset ?up\b/.test(all)) S.manual += 0.5;

  // cookbook
  if (/\bingredients?\b/.test(all)) S.cookbook += 2;
  if (/\btablespoons?\b|\bteaspoons?\b|\btbsp\b|\btsp\b/.test(all)) S.cookbook += 2;
  if (/\bpreheat\b/.test(all)) S.cookbook += 2;
  if (/\bservings?\b|\bserves \d/.test(all)) S.cookbook += 1.5;
  if (/\brecipes?\b/.test(all)) S.cookbook += 2;
  if (hits(/\bcups?\b|\bounces?\b|\boz\b/g) >= 5) S.cookbook += 1;

  // document (invoices, contracts, forms, travel…)
  const docWords = new Set(all.match(/\binvoice\b|\breceipt\b|\bbill to\b|\bamount due\b|\btotal due\b|\bsubtotal\b|\bstatement\b|\bpurchase order\b/g) || []);
  if (docWords.size) S.document += 3 + (docWords.size > 1 ? 1 : 0);
  if (/\bagreement\b|\bhereby\b|\bthe parties\b|\bterms and conditions\b|\bcontract\b/.test(all)) S.document += 3;
  if (/\btax\b|\bw-?2\b|\b1099\b|\b1040\b/.test(all)) S.document += 2;
  if (/\bresume\b|\bcurriculum vitae\b/.test(all)) S.document += 3;
  if (/\bitinerary\b|\bboarding pass\b|\bconfirmation (?:number|code)\b|\breservation\b/.test(all)) S.document += 3;
  if (/\bapplication form\b|\bplease (?:print|sign)\b/.test(all)) S.document += 1.5;
  if (N <= 12) S.document += 1.5; else if (N > 40) S.document -= 2;

  // slides
  if (aspect >= 1.25) {          // 4:3 and 16:9 decks, and Letter/A4 landscape
    S.slides += 3;
    if (avgChars < 900) S.slides += 1;
    if (N >= 6 && N <= 150) S.slides += 1;
    if (/\bagenda\b|\bthank you\b|\bquestions\?/.test(all)) S.slides += 1;
  }

  // comics
  if (/\bmanga\b|\bcomics?\b|\bgraphic novel\b/.test(all)) S.comic += 3;
  if (/\bvol(?:ume|\.)?\s*\d|\bissue\s*#?\s*\d/.test(hint)) S.comic += 1.5;
  if (!scanned && N >= 20 && avgChars < 120) S.comic += 2;

  // fiction
  const body = pages.slice(sampleN > 4 ? 2 : 0).map(pageText).join('\n');
  const quotes = (body.match(/[“”"]/g) || []).length;
  const qDensity = body.length > 1500 ? quotes / body.length * 1000 : 0;
  const digitDensity = body.length ? (body.match(/\d/g) || []).length / body.length : 1;
  if (/\ba novel\b|\bnovella\b|\bshort stories\b/.test(all)) S.fiction += 2.5;
  if (/\bfiction\b/.test(all)) S.fiction += 2;
  if (qDensity >= 12) S.fiction += 3; else if (qDensity >= 6) S.fiction += 2;
  if (body.length > 3000 && digitDensity < 0.01) S.fiction += 1;
  if (/\bprologue\b|\bepilogue\b/.test(all)) S.fiction += 1;
  if (S.textbook >= 4 || S.paper >= 4 || S.manual >= 4) S.fiction -= 2;

  // generic "book"
  if (isbn) S.book += 3;
  if (/\ball rights reserved\b/.test(all)) S.book += 1.5;
  if (/\bpublished by\b|\bpublisher\b|\bfirst (?:edition|published|printing)\b|\bprinted in\b|\blibrary of congress\b|\bcopyright\b/.test(all)) S.book += 1.5;
  if (/\btable of contents\b|\bcontents\b/.test(all)) S.book += 1;
  if (N >= 80) S.book += 2;
  if (N >= 200) S.book += 1;

  const ranked = SPECIFIC.map((k) => [k, S[k]]).sort((a, b) => b[1] - a[1]);
  let kind, score, margin;
  if (ranked[0][1] >= 3) { [kind, score] = ranked[0]; margin = score - ranked[1][1]; }
  else if (S.book >= 3) { kind = 'book'; score = S.book; margin = score - ranked[0][1]; }
  else { kind = N >= 60 ? 'book' : 'document'; score = 0; margin = 0; }
  const confidence = score >= 6 && margin >= 2 ? 'high' : score >= 3.5 ? 'medium' : 'low';
  const albumName = confidence !== 'low' || kind === 'book' ? KINDS[kind].album : null;

  return { title, titleSource, author, isbn, year, scanned, kind, kindLabel: KINDS[kind].label, confidence, albumName };
}

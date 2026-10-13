#!/usr/bin/env python3
"""Build Folio's free classics library from Project Gutenberg EPUBs.

    python3 tools/make-library.py                 # uses tools/library-books.csv, writes ./library
    python3 tools/make-library.py --from-dir ~/Downloads/gutenberg   # use EPUBs you downloaded yourself

What it does, for each book in the list:
  1. Checks the book is public domain worldwide: published in or before (this year - 96) for the US,
     and the author died in or before (this year - 71) for life+70 countries. Books that fail, or
     have no year, are skipped.
  2. Gets the EPUB3 file: from --from-dir if it's there (named pg1342-images-3.epub, 1342.epub, ...),
     otherwise downloads it once from gutenberg.org, one at a time with a pause between, and keeps it
     in tools/.gutenberg-cache so it is never downloaded twice.
  3. Removes Project Gutenberg's name, header and licence. The texts are public domain, but the
     name "Project Gutenberg" is a trademark that may only be used on books sold for profit if a
     20% royalty is paid; without the name and licence the text is free to use. Anything that
     still mentions Gutenberg afterwards is listed so you can look at it.
  4. Gives the book a plain, consistent cover (title and author) and a short credits page.
  5. Shrinks big illustrations to phone size, if Pillow is installed (python -m pip install pillow).
     Some illustrated editions are 20 to 50 MB otherwise.
  6. Writes library/books/<slug>.epub, library/covers/<slug>.svg and library/catalog.json.

Upload the whole library/ folder to the same web host as Folio, next to index.html. The app reads
library/catalog.json; nothing else is needed. Run it again whenever you change the list: books that
are already built are rebuilt from the cache, so it's quick.

Only the Python standard library is needed (Pillow is optional). Not legal advice: if in doubt about a book, leave it out.
"""
import argparse, csv, datetime, hashlib, html, json, os, posixpath, re, sys, time, urllib.request, zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
YEAR = datetime.date.today().year
US_LAST_PD_YEAR = YEAR - 96          # 2026 → books published 1930 or earlier
WORLD_LAST_DEATH = YEAR - 71         # 2026 → authors who died 1955 or earlier (life + 70)
DOWNLOAD_URL = 'https://www.gutenberg.org/cache/epub/{id}/pg{id}-images-3.epub'
PAUSE = 3                            # seconds between downloads; Gutenberg's site is for people, so go gently

CREDITS = '''<p>This is a free public-domain book from <b>Folio Classics</b>.</p>
<p>The text was transcribed and proofread by volunteers, from a public-domain edition. It is in the
public domain, so you may read, copy and share it freely.</p>
<p>This edition’s cover and this page were made for Folio. If you spot a typo, please let us know.</p>'''

MAX_PICTURE = 800                    # longest side, in pixels, of pictures inside a book
BIG_BOOK = 8_000_000                 # warn about books bigger than this

PALETTE = ['#7a2e2a', '#294a6b', '#2f5d50', '#5b3f74', '#8a5a1f', '#3d4b55', '#6b2f4f', '#2e5a6e']


def main():
    ap = argparse.ArgumentParser(description=__doc__.split('\n\n')[0])
    ap.add_argument('--books', default=os.path.join(HERE, 'library-books.csv'))
    ap.add_argument('--out', default='library')
    ap.add_argument('--cache', default=os.path.join(HERE, '.gutenberg-cache'))
    ap.add_argument('--from-dir', help='folder of EPUBs you downloaded yourself')
    ap.add_argument('--offline', action='store_true', help="don't download; use only the cache and --from-dir")
    a = ap.parse_args()

    rows = list(csv.DictReader(open(a.books, encoding='utf-8-sig')))
    os.makedirs(os.path.join(a.out, 'books'), exist_ok=True)
    os.makedirs(os.path.join(a.out, 'covers'), exist_ok=True)
    os.makedirs(a.cache, exist_ok=True)

    shelves, books, problems = [], [], []
    downloaded = False
    for row in rows:
        gid = (row.get('gutenberg_id') or '').strip()
        if not gid:
            continue
        label = f"#{gid} {row.get('title') or ''}".strip()
        why = rights_problem(row)
        if why:
            problems.append(f'{label}: skipped, {why}')
            continue
        try:
            src = find_local(gid, a.from_dir, a.cache)
            if not src:
                if a.offline:
                    problems.append(f'{label}: skipped, not downloaded yet (run without --offline)')
                    continue
                if downloaded:
                    time.sleep(PAUSE)
                src = download(gid, a.cache)
                downloaded = True
            data = open(src, 'rb').read()
            book, epub, cover, notes = build(data, row)
        except Exception as e:                       # one bad book shouldn't stop the rest
            problems.append(f'{label}: skipped, {e}')
            continue
        problems += [f"{book['title']}: {n}" for n in notes]
        with open(os.path.join(a.out, 'books', book['file']), 'wb') as f:
            f.write(epub)
        with open(os.path.join(a.out, 'covers', book['cover']), 'w', encoding='utf-8') as f:
            f.write(cover)
        for s in book['shelves']:
            if s not in shelves:
                shelves.append(s)
        books.append(book)
        if book['bytes'] > BIG_BOOK:
            problems.append(f"{book['title']}: is {book['bytes'] // 1_000_000} MB, a big download on a phone")
        print(f"  ✓ {book['title']} — {book['author']} ({book['bytes'] // 1024} KB, about {fmt_minutes(book['minutes'])})")

    catalog = {
        'version': 1,
        'updated': datetime.date.today().isoformat(),
        'shelves': [{'id': slugify(s), 'title': s} for s in shelves],
        'books': [{**b, 'shelves': [slugify(s) for s in b['shelves']]} for b in books],
    }
    with open(os.path.join(a.out, 'catalog.json'), 'w', encoding='utf-8') as f:
        json.dump(catalog, f, ensure_ascii=False, indent=1)
    print(f'\n{len(books)} books in {a.out}/catalog.json')
    if problems:
        print('\nPlease check:')
        for p in problems:
            print('  -', p)


# ---------------------------------------------------------------- rights and files

def rights_problem(row):
    def num(k):
        v = (row.get(k) or '').strip()
        return int(v) if v.lstrip('-').isdigit() else None
    year, died = num('year'), num('author_died')
    if year is None:
        return 'no first-publication year (column "year")'
    if year > US_LAST_PD_YEAR:
        return f'published {year}; only {US_LAST_PD_YEAR} or earlier is public domain in the US'
    if died is None:
        return 'no year the author died (column "author_died")'
    if died > WORLD_LAST_DEATH:
        return f'author died {died}; still in copyright in life+70 countries until {died + 71}'
    return None


def find_local(gid, from_dir, cache):
    names = [f'pg{gid}-images-3.epub', f'pg{gid}-images.epub', f'pg{gid}.epub', f'{gid}.epub']
    for d in [from_dir, cache]:
        if d:
            for n in names:
                p = os.path.join(os.path.expanduser(d), n)
                if os.path.exists(p):
                    return p
    return None


def download(gid, cache):
    url = DOWNLOAD_URL.format(id=gid)
    print(f'  ↓ downloading {url}')
    req = urllib.request.Request(url, headers={'User-Agent': 'Folio library builder (one-time download of a curated list)'})
    with urllib.request.urlopen(req, timeout=60) as r:
        data = r.read()
    if not data.startswith(b'PK'):
        raise ValueError('the download is not an EPUB file')
    path = os.path.join(cache, f'pg{gid}-images-3.epub')
    with open(path, 'wb') as f:
        f.write(data)
    return path


# ---------------------------------------------------------------- the clean-up

GUT = re.compile(r'gutenberg', re.I)
BOILERPLATE = re.compile(r'''\b(?:id\s*=\s*["'](?:pg-header|pg-footer|pg-machine-header|pg-start-separator|pg-end-separator)["']'''
                         r'''|class\s*=\s*["'][^"']*\b(?:pg-boilerplate|pgheader|pgfooter)\b[^"']*["'])''', re.I)


def build(data, row):
    """Clean one Gutenberg EPUB. Returns (catalog entry, epub bytes, cover svg, notes)."""
    zin = zipfile.ZipFile(io_bytes(data))
    files = {i.filename: zin.read(i) for i in zin.infolist() if not i.is_dir()}
    container = files['META-INF/container.xml'].decode('utf-8')
    opf_path = re.search(r'full-path\s*=\s*"([^"]+)"', container).group(1)
    opf_dir = posixpath.dirname(opf_path)
    opf = files[opf_path].decode('utf-8')
    notes = []

    title = (row.get('title') or '').strip() or text_of(first(opf, 'dc:title')) or 'Untitled'
    author = (row.get('author') or '').strip() or text_of(first(opf, 'dc:creator')) or ''
    lang = text_of(first(opf, 'dc:language')) or 'en'
    slug = slugify(f"{author.split(' ')[-1] if author else ''} {title}")[:80]

    items = manifest(opf)
    by_href = {posixpath.normpath(posixpath.join(opf_dir, it['href'])): it for it in items}

    # 1. Gutenberg's header and licence sections, in every content document.
    removed_any, dropped = False, set()
    for path, it in by_href.items():
        if it['media-type'] != 'application/xhtml+xml' or 'nav' in it.get('properties', ''):
            continue
        doc = files[path].decode('utf-8')
        new = strip_boilerplate(doc)
        new = strip_mentions(new, notes)
        new = re.sub(r'(<title>)([^<]*)(</title>)', lambda m: m.group(1) + (esc(title) if GUT.search(m.group(2)) else m.group(2)) + m.group(3), new)
        if new != doc:
            removed_any = True
            if not visible_text(new) and not re.search(r'<(img|svg|image)\b', new, re.I):
                dropped.add(path)            # the file only held the licence
            files[path] = new.encode('utf-8')
    if not removed_any:
        raise ValueError("couldn't find Gutenberg's header and licence to remove (an older file layout?); check it by hand")
    for path in dropped:
        it = by_href[path]
        opf = re.sub(r'<itemref\b[^>]*idref\s*=\s*"%s"[^>]*/>\s*' % re.escape(it['id']), '', opf)
        opf = re.sub(r'<item\b[^>]*id\s*=\s*"%s"[^>]*/>\s*' % re.escape(it['id']), '', opf)
        del files[path]

    # 2. Contents: drop entries that pointed at the removed sections or files.
    gone = {posixpath.relpath(p, opf_dir) for p in dropped}
    for path, it in by_href.items():
        if path not in files:
            continue
        if 'nav' in it.get('properties', ''):
            files[path] = strip_head(files[path].decode('utf-8'), slug).encode('utf-8')
            files[path] = clean_toc(files[path].decode('utf-8'), 'li', gone, posixpath.dirname(path), opf_dir).encode('utf-8')
        elif it['media-type'] == 'application/x-dtbncx+xml':
            ncx = clean_toc(files[path].decode('utf-8'), 'navPoint', gone, posixpath.dirname(path), opf_dir)
            ncx = re.sub(r'(<docTitle>\s*<text>)[^<]*(</text>)', lambda m: m.group(1) + esc(title) + m.group(2), ncx)
            ncx = strip_head(ncx, slug)
            files[path] = ncx.encode('utf-8')

    # 3. Package metadata: no Gutenberg identifier, source, publisher or links.
    opf = clean_metadata(opf, slug, title, author)

    # 4. Cover and credits.
    cover_svg = make_cover(title, author, slug)
    if (row.get('cover') or '').strip().lower() != 'keep':
        opf, files = replace_cover(opf, files, opf_dir, cover_svg)
    files[posixpath.join(opf_dir, 'folio-credits.xhtml')] = credits_page(title, lang).encode('utf-8')
    opf = opf.replace('</manifest>', '  <item id="folio-credits" href="folio-credits.xhtml" media-type="application/xhtml+xml"/>\n  </manifest>')
    opf = opf.replace('</spine>', '  <itemref idref="folio-credits"/>\n  </spine>')
    opf = drop_full_size_pages(files, opf, opf_dir)
    files[opf_path] = opf.encode('utf-8')
    shrink_pictures(files, notes)

    # 5. Anything that still says Gutenberg (sometimes a transcriber's note in the text itself).
    for path, content in files.items():
        if path.endswith(('.xhtml', '.html', '.htm', '.opf', '.ncx', '.xml')):   # CSS selectors are never shown
            for m in GUT.finditer(content.decode('utf-8', 'replace')):
                s = content.decode('utf-8', 'replace')
                ctx = re.sub(r'<[^>]+>|\s+', ' ', s[max(0, m.start() - 60):m.end() + 60]).strip()
                notes.append(f'still mentions Gutenberg in {posixpath.basename(path)}: “…{ctx}…”')
                break

    words = sum(len(visible_text(files[p].decode('utf-8')).split()) for p, it in by_href.items()
                if p in files and it['media-type'] == 'application/xhtml+xml' and 'nav' not in it.get('properties', ''))
    epub = write_epub(files)
    entry = {
        'id': slug, 'title': title, 'author': author, 'year': int(row['year']), 'lang': lang,
        'shelves': [s.strip() for s in (row.get('shelf') or '').split(';') if s.strip()] or ['More classics'],
        'blurb': (row.get('blurb') or '').strip(), 'words': words, 'minutes': round(words / 250),
        'bytes': len(epub), 'sha256': hashlib.sha256(epub).hexdigest(),
        'file': f'{slug}.epub', 'cover': f'{slug}.svg',
    }
    return entry, epub, cover_svg, notes


BLOCK = re.compile(r'<(p|div|table|blockquote|ul|ol|li|h[1-6])\b[^>]*?(/?)>', re.I)
SMALL_NOTE = 600                     # characters: a note about other editions, never a chapter


def strip_head(doc, slug):
    """No "made by Gutenberg's Ebookmaker" tags, and the book's own id instead of Gutenberg's."""
    doc = re.sub(r'<meta\b[^>]*name\s*=\s*"(?:generator|dtb:generator)"[^>]*content\s*=\s*"[^"]*gutenberg[^"]*"[^>]*>\s*', '', doc, flags=re.I)
    return re.sub(r'(<meta\b[^>]*name\s*=\s*"dtb:uid"[^>]*content\s*=\s*")[^"]*(")', lambda m: m.group(1) + f'urn:folio-classics:{slug}' + m.group(2), doc)


def strip_mentions(doc, notes):
    """Remove short notes that point readers at Gutenberg (other editions, transcriber's notes).

    Takes the largest block around each mention that is still only a short note, so a whole
    "Transcriber's notes" box goes, but a chapter that happens to say Gutenberg never does."""
    doc = re.sub(r'<meta\b[^>]*name\s*=\s*"generator"[^>]*content\s*=\s*"[^"]*gutenberg[^"]*"[^>]*>\s*', '', doc, flags=re.I)
    body = re.search(r'<body\b[^>]*>', doc, re.I)
    start_at = body.end() if body else 0
    skip = 0
    while True:
        hit = None
        for m in GUT.finditer(doc, start_at):
            if skip:
                skip -= 1
                continue
            hit = m
            break
        if not hit:
            return doc
        best = None
        for b in BLOCK.finditer(doc, start_at, hit.start()):
            if b.group(2):
                continue
            end = matching_end(doc, b.group(1), b.start())
            if end > hit.end() and len(visible_text(doc[b.start():end])) <= SMALL_NOTE:
                if not best or b.start() < best[0]:
                    best = (b.start(), end)
        if best:
            doc = doc[:best[0]] + doc[best[1]:]
        else:
            skip += 1                        # listed in "Please check" by the final scan
    return doc


WRAP_PAGE = re.compile(r'\.wrap-\d+\.html\.xhtml$')


def drop_full_size_pages(files, opf, opf_dir):
    """Illustrated Gutenberg books show each picture twice: in the text, and again full size on its
    own page that the picture links to. Keep the one in the text (Folio can zoom), drop the rest."""
    items = manifest(opf)
    wraps = {it['href'] for it in items if WRAP_PAGE.search(it['href'])}
    if not wraps:
        return opf
    link = re.compile(r'<a\b[^>]*href\s*=\s*"([^"#]+)"[^>]*>(.*?)</a>', re.S)
    for name in files:
        if name.endswith(('.xhtml', '.html', '.htm')) and posixpath.relpath(name, opf_dir) not in wraps:
            doc = files[name].decode('utf-8')
            new = link.sub(lambda m: m.group(2) if posixpath.basename(urllib.request.unquote(m.group(1))) in wraps else m.group(0), doc)
            if new != doc:
                files[name] = new.encode('utf-8')
    text = ''.join(v.decode('utf-8', 'replace') for k, v in files.items()
                   if k.endswith(('.xhtml', '.html', '.htm', '.css', '.ncx')) and posixpath.relpath(k, opf_dir) not in wraps)
    for it in items:
        unused = re.search(r'\.(jpe?g|png|gif)$', it['href'], re.I) and posixpath.basename(it['href']) not in text
        if it['href'] in wraps or unused:
            opf = re.sub(r'<itemref\b[^>]*idref\s*=\s*"%s"[^>]*/>\s*' % re.escape(it['id']), '', opf)
            opf = re.sub(r'<item\b[^>]*id\s*=\s*"%s"[^>]*/>\s*' % re.escape(it['id']), '', opf)
            files.pop(posixpath.normpath(posixpath.join(opf_dir, it['href'])), None)
    return opf


def shrink_pictures(files, notes):
    """Scale pictures down to MAX_PICTURE pixels, keeping file names and formats so no page changes."""
    try:
        from PIL import Image, ImageChops
    except ImportError:
        if sum(len(v) for k, v in files.items() if k.lower().endswith(('.jpg', '.jpeg', '.png'))) > BIG_BOOK:
            notes.append('has big pictures; install Pillow (python -m pip install pillow) and run again to shrink them')
        return
    import io
    for name, data in list(files.items()):
        ext = name.lower().rsplit('.', 1)[-1]
        if ext not in ('jpg', 'jpeg', 'png') or len(data) < 30_000:
            continue
        try:
            im = Image.open(io.BytesIO(data))
            im.load()
            im.thumbnail((MAX_PICTURE, MAX_PICTURE), Image.LANCZOS)
            if im.mode == 'RGB':                 # old engravings scanned in colour: grey is a third of the size
                grey = im.convert('L')
                if max(hi for lo, hi in ImageChops.difference(im, grey.convert('RGB')).getextrema()) < 24:
                    im = grey
            out = io.BytesIO()
            if ext == 'png':
                im.save(out, 'PNG', optimize=True)
            else:
                im.convert('L' if im.mode == 'L' else 'RGB').save(out, 'JPEG', quality=70, optimize=True, progressive=True)
            if out.tell() < len(data):
                files[name] = out.getvalue()
        except Exception:
            pass                             # leave a picture Pillow can't read as it is


def strip_boilerplate(doc):
    """Remove every element marked as Gutenberg boilerplate, with all it contains."""
    while True:
        m = None
        for t in re.finditer(r'<([a-zA-Z][\w:-]*)\b([^>]*)>', doc):
            if BOILERPLATE.search(t.group(2)):
                m = t
                break
        if not m:
            return doc
        tag, start = m.group(1), m.start()
        if m.group(0).endswith('/>'):
            doc = doc[:start] + doc[m.end():]
            continue
        depth, pos = 0, start
        pat = re.compile(r'<(/?)%s\b[^>]*?(/?)>' % re.escape(tag))
        for t in pat.finditer(doc, start):
            if t.group(1):
                depth -= 1
            elif not t.group(2):
                depth += 1
            if depth == 0:
                pos = t.end()
                break
        else:
            raise ValueError(f'unbalanced <{tag}> in Gutenberg boilerplate')
        doc = doc[:start] + doc[pos:]


def clean_toc(doc, tag, gone, doc_dir, opf_dir):
    """Remove contents entries (<li> or <navPoint>) that lead to Gutenberg's sections or removed files."""
    out, pos = [], 0
    for m in re.finditer(r'<%s\b[^>]*>' % tag, doc):
        if m.start() < pos:
            continue
        end = matching_end(doc, tag, m.start())
        block = doc[m.start():end]
        inner_first = re.search(r'(?:href|src)\s*=\s*"([^"]+)"', block)
        target = inner_first.group(1) if inner_first else ''
        file_part = posixpath.relpath(posixpath.normpath(posixpath.join(doc_dir, target.split('#')[0])), opf_dir) if target else ''
        label = re.search(r'<(?:a|text)\b[^>]*>(.*?)</(?:a|text)>', block, re.S)
        label = re.sub(r'<[^>]+>', '', label.group(1)) if label else ''
        if re.search(r'#pg-(header|footer)', target) or file_part in gone or GUT.search(label):
            out.append(doc[pos:m.start()])
            pos = end
    out.append(doc[pos:])
    return ''.join(out)


def matching_end(doc, tag, start):
    depth = 0
    for t in re.finditer(r'<(/?)%s\b[^>]*?(/?)>' % tag, doc[start:]):
        if t.group(1):
            depth -= 1
        elif not t.group(2):
            depth += 1
        if depth == 0:
            return start + t.end()
    return len(doc)


def clean_metadata(opf, slug, title, author):
    """No Gutenberg identifier, source, publisher or links in the package metadata."""
    m = re.search(r'(<(?:opf:)?metadata\b[^>]*>)(.*?)(</(?:opf:)?metadata>)', opf, re.S)

    def fix(e):
        name, body = e.group(1), e.group(0)
        if name == 'dc:identifier' and GUT.search(body):
            return re.sub(r'>[^<]*<', f'>urn:folio-classics:{slug}<', body, count=1)
        if name == 'dc:rights':
            return re.sub(r'>[^<]*<', '>Public domain<', body, count=1)
        if name == 'dc:title':
            return re.sub(r'>[^<]*<', f'>{esc(title)}<', body, count=1)
        if name == 'dc:creator' and author:
            return re.sub(r'>[^<]*<', f'>{esc(author)}<', body, count=1)
        return '' if GUT.search(body) else body
    meta = re.sub(r'<((?:dc|opf):[\w-]+|meta|link)\b[^>]*?(?:/>|>.*?</\1>)', fix, m.group(2), flags=re.S)
    meta = re.sub(r'\n[ \t]*(?=\n)', '', meta)
    return opf[:m.start(2)] + meta + opf[m.end(2):]


def replace_cover(opf, files, opf_dir, svg):
    old = re.search(r'<item\b[^>]*properties\s*=\s*"[^"]*cover-image[^"]*"[^>]*/>', opf)
    old_href = re.search(r'href\s*=\s*"([^"]+)"', old.group(0)).group(1) if old else None
    if old:                                       # the old cover image goes (Gutenberg's made-up covers can carry its name)
        opf = opf.replace(old.group(0), '')
        files.pop(posixpath.normpath(posixpath.join(opf_dir, old_href)), None)
    opf = opf.replace('</manifest>', '  <item id="folio-cover" href="folio-cover.svg" media-type="image/svg+xml" properties="cover-image"/>\n  </manifest>')
    opf = re.sub(r'(<meta\b[^>]*name\s*=\s*"cover"[^>]*content\s*=\s*")[^"]*(")', r'\1folio-cover\2', opf)
    files[posixpath.join(opf_dir, 'folio-cover.svg')] = svg.encode('utf-8')
    if old_href:                                  # the cover page shows the new cover too
        old_abs = posixpath.normpath(posixpath.join(opf_dir, old_href))
        for path in list(files):
            if path.endswith(('.xhtml', '.html')):
                d = posixpath.dirname(path)
                rel_old, rel_new = posixpath.relpath(old_abs, d), posixpath.relpath(posixpath.join(opf_dir, 'folio-cover.svg'), d)
                s = files[path].decode('utf-8')
                if f'"{rel_old}"' in s:
                    files[path] = s.replace(f'"{rel_old}"', f'"{rel_new}"').encode('utf-8')
    return opf, files


def make_cover(title, author, slug):
    color = PALETTE[int(hashlib.md5(slug.encode()).hexdigest(), 16) % len(PALETTE)]
    lines = wrap(title, 15 if len(title) < 40 else 19)
    size = 64 if len(lines) <= 3 else 50
    y0 = 360 - (len(lines) - 1) * size * 0.6
    tspans = ''.join(f'<tspan x="300" y="{y0 + i * size * 1.15:.0f}">{esc(l)}</tspan>' for i, l in enumerate(lines))
    return f'''<svg xmlns="http://www.w3.org/2000/svg" width="600" height="900" viewBox="0 0 600 900">
<rect width="600" height="900" fill="{color}"/>
<rect x="34" y="34" width="532" height="832" fill="none" stroke="#f3e9d2" stroke-opacity=".55" stroke-width="2"/>
<rect x="46" y="46" width="508" height="808" fill="none" stroke="#f3e9d2" stroke-opacity=".3" stroke-width="1"/>
<text font-family="Georgia, 'Times New Roman', serif" font-size="{size}" fill="#f8f1e1" text-anchor="middle">{tspans}</text>
<line x1="250" x2="350" y1="{y0 + len(lines) * size * 1.15 + 10:.0f}" y2="{y0 + len(lines) * size * 1.15 + 10:.0f}" stroke="#f3e9d2" stroke-opacity=".7" stroke-width="2"/>
<text x="300" y="760" font-family="Georgia, 'Times New Roman', serif" font-size="34" font-style="italic" fill="#f3e9d2" text-anchor="middle">{esc(author)}</text>
</svg>
'''


def credits_page(title, lang):
    return f'''<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="{lang}" xml:lang="{lang}">
<head><title>About this edition</title></head>
<body><section epub:type="colophon"><h2>About this edition</h2>
<p><i>{esc(title)}</i></p>
{CREDITS}
</section></body></html>
'''


def write_epub(files):
    import io
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, 'w') as z:
        z.writestr(zipfile.ZipInfo('mimetype'), b'application/epub+zip', compress_type=zipfile.ZIP_STORED)
        for name, data in files.items():
            if name != 'mimetype':
                z.writestr(name, data, compress_type=zipfile.ZIP_DEFLATED)
    return buf.getvalue()


# ---------------------------------------------------------------- small helpers

def io_bytes(b):
    import io
    return io.BytesIO(b)


def manifest(opf):
    out = []
    for m in re.finditer(r'<item\b[^>]*/?>', opf):
        attrs = dict(re.findall(r'([\w:-]+)\s*=\s*"([^"]*)"', m.group(0)))
        if 'href' in attrs:
            attrs['href'] = urllib.request.unquote(attrs['href'])
            out.append(attrs)
    return out


def first(opf, tag):
    m = re.search(r'<%s\b[^>]*>(.*?)</%s>' % (tag, tag), opf, re.S)
    return m.group(1) if m else ''


def text_of(s):
    return html.unescape(re.sub(r'<[^>]+>', '', s or '')).strip()


def visible_text(doc):
    body = re.search(r'<body\b[^>]*>(.*)</body>', doc, re.S | re.I)
    s = body.group(1) if body else doc
    s = re.sub(r'<(script|style)\b.*?</\1>', ' ', s, flags=re.S | re.I)
    return html.unescape(re.sub(r'<[^>]+>', ' ', s)).strip()


def esc(s):
    return html.escape(s, quote=True)


def slugify(s):
    import unicodedata
    s = unicodedata.normalize('NFKD', s).encode('ascii', 'ignore').decode()
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-') or 'book'


def wrap(text, width):
    lines, cur = [], ''
    for w in text.split():
        if cur and len(cur) + 1 + len(w) > width:
            lines.append(cur)
            cur = w
        else:
            cur = f'{cur} {w}'.strip()
    return lines + ([cur] if cur else [])


def fmt_minutes(m):
    return f'{m} min' if m < 60 else f'{m / 60:.0f} h' if m >= 90 else '1 h'


if __name__ == '__main__':
    sys.exit(main())

"""Builds samples/welcome-to-folio.pdf, the guide book the first-run tour opens.

Run from the repo root:  python3 tools/make-sample-book.py   (needs: pip install reportlab)
The output is committed, so this only needs re-running after editing the text below.

The fonts (Source Serif 4, SIL Open Font License) are downloaded into tools/.fonts on the
first run and embedded in the PDF. Embedding matters: a PDF that only names a standard
font like Times gets a stand-in font on phones, with the original letter widths, which
leaves odd gaps between words.
"""
import os
import urllib.request

from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph

OUT = 'samples/welcome-to-folio.pdf'
FONT_DIR = os.path.join(os.path.dirname(__file__), '.fonts')
FONT_URL = 'https://raw.githubusercontent.com/adobe-fonts/source-serif/release/TTF/'
FONTS = {
    'Serif': 'SourceSerif4-Regular.ttf',
    'Serif-Italic': 'SourceSerif4-It.ttf',
    'Serif-Bold': 'SourceSerif4-Semibold.ttf',
    'Display': 'SourceSerif4Display-Semibold.ttf',
}

W, H = 396, 612            # 5.5 x 8.5 in, a trade paperback page
M = 46                     # side margin
ACCENT = HexColor('#b4532a')
INK = HexColor('#2b2622')
MUTED = HexColor('#7a6f66')
RULE = HexColor('#e3ddd3')
PAPER = HexColor('#f6f3ee')


def load_fonts():
    os.makedirs(FONT_DIR, exist_ok=True)
    for name, file in FONTS.items():
        path = os.path.join(FONT_DIR, file)
        if not os.path.exists(path):
            print('Downloading', file)
            urllib.request.urlretrieve(FONT_URL + file, path)
        pdfmetrics.registerFont(TTFont(name, path))
    pdfmetrics.registerFontFamily('Serif', normal='Serif', bold='Serif-Bold', italic='Serif-Italic', boldItalic='Serif-Bold')


load_fonts()
body = ParagraphStyle('body', fontName='Serif', fontSize=12.5, leading=18.5, textColor=INK, spaceAfter=9)
intro = ParagraphStyle('intro', parent=body, fontName='Serif-Italic', textColor=MUTED, spaceAfter=14)
label = ParagraphStyle('label', parent=body, fontName='Serif-Bold', spaceAfter=1)
item = ParagraphStyle('item', parent=body, spaceAfter=11)
note = ParagraphStyle('note', parent=body, fontName='Serif-Italic', fontSize=11.5, leading=16.5, textColor=MUTED)

# Each chapter is one page: (title, intro line, [(label, text)] rows, closing note or None).
# A row with an empty label is a plain paragraph.
CHAPTERS = [
    ('Reading', 'Folio turns pages sideways, like a paper book.', [
        ('Turn the page', 'Swipe left or right, or tap the right or left edge of the screen. A quick flick is enough.'),
        ('Zoom', 'Pinch, or double-tap the spot you want to see closer. Double-tap again to zoom back out. '
                 'The zoom stays on as you turn pages, so you can read a whole book zoomed in.'),
        ('Show the menus', 'Tap the middle of the page. They tuck themselves away when you turn a page.'),
        ('Jump anywhere', 'Drag the slider at the bottom, or tap the page number to type one. '
                          'After a jump, Back to page takes you back.'),
    ], 'Folio remembers your page in every book and reopens right where you stopped.'),
    ('Find your way', 'Three buttons at the top right of every book.', [
        ('The ribbon', 'Bookmarks the page you are on. Tap it again to remove the bookmark.'),
        ('The list', 'Opens the contents, your bookmarks, and search. This guide has chapters, '
                     'so try jumping to one from the contents.'),
        ('Aa', 'Display settings: light, sepia and dark themes, one page or two side by side, and zoom.'),
    ], 'On a tablet, turn the screen sideways to see two pages at once, like an open book.'),
    ('Your library', 'Everything you add stays on this device and works offline.', [
        ('Add books', 'Tap + to pick PDFs from Files, Drive or Downloads. On Android you can also '
                      'share a PDF straight to Folio, and on a computer you can drag PDFs onto the window.'),
        ('Albums', 'Folio reads each new PDF, on this device only, and works out the title, the author '
                   'and what kind of book it is. It then suggests an album, such as Fiction or Textbooks. '
                   'Check the guess and tap to file it.'),
        ('Tidy up', 'Each book has a … menu to rename it, move it to another album or remove it. '
                    'Select lets you move several books at once.'),
    ], None),
    ('Keep a backup', 'Your books never leave this device, so keep a copy of your setup.', [
        ('Back up', 'In the library, open Settings and tap Back up. It saves your albums, bookmarks and '
                    'reading positions to a small file.'),
        ('Restore', 'On a new device, tap Restore, then add the same PDFs. Everything attaches to them again.'),
        ('Your PDFs', 'The backup holds your setup, not the books themselves, so keep the PDFs in Files, '
                      'Drive or Downloads too. Uninstalling Folio removes the copies inside it.'),
    ], None),
    ('Where to find books', 'Folio opens PDFs you already have. These sites offer books you can download legally and free.', [
        ('Project Gutenberg', 'gutenberg.org. Over 70,000 classics whose copyright has expired.'),
        ('OpenStax', 'openstax.org. Free college textbooks as PDFs.'),
        ('Internet Archive', 'archive.org. Its public-domain collections.'),
        ('arXiv', 'arxiv.org. Research papers in science and maths.'),
    ], 'Books bought from Kindle or Apple Books are copy-protected, so they cannot be opened in Folio.'),
    ('On a computer', 'Folio works with a keyboard and mouse too.', [
        ('Turn pages', 'Arrow keys, Space, Page Up and Page Down, or the mouse wheel.'),
        ('Jump to the ends', 'Home and End.'),
        ('Zoom', 'Ctrl or Cmd with plus, minus, or 0 to fit the page.'),
        ('Search and bookmarks', 'Ctrl or Cmd with F to search, B to bookmark, Esc to close a panel.'),
    ], None),
]


def para(c, text, style, x, y, width):
    p = Paragraph(text, style)
    _, h = p.wrap(width, H)
    p.drawOn(c, x, y - h)
    return y - h - style.spaceAfter


def folio_number(c, n):
    c.setFont('Serif', 9)
    c.setFillColor(MUTED)
    c.drawCentredString(W / 2, 30, str(n))


def cover(c):
    c.setFillColor(PAPER)
    c.rect(0, 0, W, H, stroke=0, fill=1)
    c.setFillColor(ACCENT)
    c.rect(0, H - 14, W, 14, stroke=0, fill=1)
    c.setFillColor(INK)
    c.setFont('Display', 40)
    c.drawCentredString(W / 2, H * 0.6, 'Welcome')
    c.drawCentredString(W / 2, H * 0.6 - 46, 'to Folio')
    c.setStrokeColor(ACCENT)
    c.setLineWidth(1.5)
    c.line(W / 2 - 36, H * 0.6 - 72, W / 2 + 36, H * 0.6 - 72)
    sub = ParagraphStyle('sub', parent=intro, alignment=TA_CENTER, fontSize=12.5, leading=18)
    para(c, 'A short guide to your new reader', sub, M, H * 0.6 - 90, W - 2 * M)
    c.setFont('Serif', 10)
    c.setFillColor(MUTED)
    c.drawCentredString(W / 2, 50, 'Your PDFs, read like books.')


def chapter(c, n, key, title, lead, rows, closing):
    c.bookmarkPage(key)
    c.addOutlineEntry(title, key, level=0)
    c.setFillColor(ACCENT)
    c.setFont('Serif', 10)
    c.drawString(M, H - 58, f'CHAPTER {n}')
    c.setFillColor(INK)
    c.setFont('Display', 25)
    c.drawString(M, H - 90, title)
    y = para(c, lead, intro, M, H - 104, W - 2 * M)
    for lab, text in rows:
        if lab:
            y = para(c, lab, label, M, y, W - 2 * M)
        y = para(c, text, item, M, y, W - 2 * M)
    if closing:
        y -= 4
        c.setStrokeColor(RULE)
        c.setLineWidth(1)
        c.line(M, y, W - M, y)
        para(c, closing, note, M, y - 12, W - 2 * M)
    folio_number(c, n + 1)


def back_page(c, n):
    c.bookmarkPage('ready')
    c.addOutlineEntry('You are ready', 'ready', level=0)
    c.setFillColor(INK)
    c.setFont('Display', 25)
    c.drawCentredString(W / 2, H * 0.58, 'You are ready')
    c.setStrokeColor(ACCENT)
    c.setLineWidth(1.5)
    c.line(W / 2 - 36, H * 0.58 - 20, W / 2 + 36, H * 0.58 - 20)
    centred = ParagraphStyle('centred', parent=body, alignment=TA_CENTER)
    y = para(c, 'Tap the back arrow at the top left to return to your library and add your own books.',
             centred, M + 10, H * 0.58 - 36, W - 2 * M - 20)
    para(c, 'Done with this guide? Remove it from its … menu in the library. '
            'Settings brings the tour back whenever you like.', ParagraphStyle('n2', parent=note, alignment=TA_CENTER),
         M + 10, y - 6, W - 2 * M - 20)
    folio_number(c, n)


def main():
    c = canvas.Canvas(OUT, pagesize=(W, H), invariant=1, initialFontName='Serif', initialFontSize=11)
    c.setTitle('Welcome to Folio')
    c.setAuthor('Folio')
    c.setSubject('A short guide to using Folio')
    c.setCreator('Folio')
    c.showOutline()
    c.bookmarkPage('cover')
    c.addOutlineEntry('Cover', 'cover', level=0)
    cover(c)
    c.showPage()
    for n, (title, lead, rows, closing) in enumerate(CHAPTERS, start=1):
        chapter(c, n, f'ch{n}', title, lead, rows, closing)
        c.showPage()
    back_page(c, len(CHAPTERS) + 2)
    c.showPage()
    c.save()


if __name__ == '__main__':
    main()

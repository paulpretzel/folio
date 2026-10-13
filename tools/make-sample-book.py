"""Builds samples/welcome-to-folio.pdf, the guide book the first-run tour walks you through.

Each page teaches one thing. The tour in js/tour.js points at the screen to match, so if
you reorder or retitle pages here, update its STEPS (page numbers, and the "Your library"
contents entry) to match.

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
text = ParagraphStyle('text', fontName='Serif', fontSize=14, leading=20.5, textColor=INK, spaceAfter=12)
lead = ParagraphStyle('lead', parent=text, fontName='Serif-Italic', textColor=MUTED, spaceAfter=18)
action = ParagraphStyle('action', parent=text, fontName='Serif-Bold', textColor=ACCENT, spaceAfter=12)
fine = ParagraphStyle('fine', parent=text, fontSize=6, leading=8, textColor=MUTED)
TRY_BG = HexColor('#f7e6dc')

# One page each: (title, lead line, blocks). A block is plain text, or (kind, text) where kind is
# 'try' (the thing to do on this page, drawn in a box) or 'fine' (small print, to practise zooming).
PAGES = [
    ('Zoom in', 'Make small text bigger.', [
        ('try', 'Double-tap anywhere on this page to zoom in. Double-tap again to zoom out.'),
        'You can also pinch with two fingers. While zoomed in, drag to look around the page.',
        ('fine', 'You zoomed in. Turn the page from here and the next one opens with its '
                 'margins trimmed, so the words fill the screen. The crop button at the top '
                 'switches between that and whole pages.'),
    ]),
    ('Show the menus', 'The page fills your screen while you read.', [
        ('try', 'Tap the middle of the page to show the menus. Tap again to hide them.'),
        'The menus hide on their own when you turn a page.',
        'In the menus, the slider at the bottom moves you anywhere in the book.',
    ]),
    ('Bookmark a page', 'Save a page to come back to.', [
        ('try', 'Tap the ribbon at the top right to bookmark this page.'),
        'Tap the ribbon again to remove the bookmark.',
    ]),
    ('Jump to a chapter', 'Find your way around a long book.', [
        ('try', 'Tap the list button at the top right, then tap Your library.'),
        'The list also shows your bookmarks and lets you search the book.',
    ]),
    ('Your library', 'Add your own books.', [
        'In the library, tap <b>+</b> to add PDFs from Files, Drive or Downloads.',
        'Folio suggests an album for each new book, such as Fiction or Textbooks. Tap the suggestion to file it.',
        'Folio saves your page in every book, so you always pick up where you left off.',
    ]),
    ('Keep a backup', 'Your books stay on this device.', [
        'Uninstalling Folio deletes the books inside it, so keep your PDFs in Files or Drive too.',
        'In the library, tap <b>Settings</b>, then <b>Back up</b>. This saves your albums, bookmarks '
        'and reading positions to a small file.',
        'On a new device, tap <b>Restore</b> and add the same PDFs.',
    ]),
    ('Free books', 'Folio opens PDFs you already have.', [
        'These sites offer free books you can download legally:',
        '<b>Project Gutenberg</b> (gutenberg.org) for classic books.',
        '<b>OpenStax</b> (openstax.org) for college textbooks.',
    ]),
]


def para(c, text_, style, x, y, width):
    p = Paragraph(text_, style)
    _, h = p.wrap(width, H)
    p.drawOn(c, x, y - h)
    return y - h - style.spaceAfter


def page_number(c, n):
    c.setFont('Serif', 9)
    c.setFillColor(MUTED)
    c.drawCentredString(W / 2, 30, str(n))


def cover(c):
    c.bookmarkPage('cover')
    c.addOutlineEntry('Welcome', 'cover', level=0)
    c.setFillColor(PAPER)
    c.rect(0, 0, W, H, stroke=0, fill=1)
    c.setFillColor(ACCENT)
    c.rect(0, H - 14, W, 14, stroke=0, fill=1)
    c.setFillColor(INK)
    c.setFont('Display', 40)
    c.drawCentredString(W / 2, H * 0.62, 'Welcome')
    c.drawCentredString(W / 2, H * 0.62 - 46, 'to Folio')
    c.setStrokeColor(ACCENT)
    c.setLineWidth(1.5)
    c.line(W / 2 - 36, H * 0.62 - 72, W / 2 + 36, H * 0.62 - 72)
    sub = ParagraphStyle('sub', parent=lead, alignment=TA_CENTER)
    para(c, 'Your PDFs, read like books.', sub, M, H * 0.62 - 90, W - 2 * M)
    go = ParagraphStyle('go', parent=action, alignment=TA_CENTER)
    para(c, 'Swipe left or tap the right edge of the screen to turn the page.', go, M + 6, 120, W - 2 * M - 12)


def try_box(c, text_, y):
    p = Paragraph(text_, action)
    pad = 12
    _, h = p.wrap(W - 2 * M - 2 * pad, H)
    c.setFillColor(TRY_BG)
    c.roundRect(M, y - h - 2 * pad, W - 2 * M, h + 2 * pad, 10, stroke=0, fill=1)
    c.setFillColor(ACCENT)
    c.rect(M, y - h - 2 * pad, 4, h + 2 * pad, stroke=0, fill=1)
    p.drawOn(c, M + pad + 2, y - pad - h)
    return y - h - 2 * pad - 18


def page(c, n, title, lead_line, blocks):
    key = f'p{n}'
    c.bookmarkPage(key)
    c.addOutlineEntry(title, key, level=0)
    c.setFillColor(INK)
    c.setFont('Display', 27)
    c.drawString(M, H - 84, title)
    y = para(c, lead_line, lead, M, H - 98, W - 2 * M)
    for b in blocks:
        kind, t = b if isinstance(b, tuple) else ('text', b)
        if kind == 'try':
            y = try_box(c, t, y)
        else:
            y = para(c, t, fine if kind == 'fine' else text, M, y, W - 2 * M)
    c.setFont('Serif-Italic', 11)
    c.setFillColor(ACCENT)
    c.drawRightString(W - M, 52, 'Next page ›')
    page_number(c, n)


def last_page(c, n):
    c.bookmarkPage('ready')
    c.addOutlineEntry('You’re ready', 'ready', level=0)
    c.setFillColor(INK)
    c.setFont('Display', 27)
    c.drawCentredString(W / 2, H * 0.6, 'You’re ready')
    c.setStrokeColor(ACCENT)
    c.setLineWidth(1.5)
    c.line(W / 2 - 36, H * 0.6 - 20, W / 2 + 36, H * 0.6 - 20)
    y = try_box(c, 'Tap the back arrow at the top left to go to your library and add your first book.', H * 0.6 - 40)
    centred = ParagraphStyle('centred', parent=lead, alignment=TA_CENTER, fontSize=12, leading=17)
    para(c, 'You can delete this guide from its … menu in the library.', centred, M, y, W - 2 * M)
    page_number(c, n)


def main():
    c = canvas.Canvas(OUT, pagesize=(W, H), invariant=1, initialFontName='Serif', initialFontSize=11)
    c.setTitle('Welcome to Folio')
    c.setAuthor('Folio')
    c.setSubject('A short guide to using Folio')
    c.setCreator('Folio')
    c.showOutline()
    cover(c)
    c.showPage()
    for n, (title, lead_line, blocks) in enumerate(PAGES, start=2):
        page(c, n, title, lead_line, blocks)
        c.showPage()
    last_page(c, len(PAGES) + 2)
    c.showPage()
    c.save()


if __name__ == '__main__':
    main()

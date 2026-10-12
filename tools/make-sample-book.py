"""Builds samples/welcome-to-folio.pdf, the practice book the first-run tour opens.

Run from the repo root:  python3 tools/make-sample-book.py   (needs: pip install reportlab)
The output is committed, so this only needs re-running after editing the text below.
"""
from reportlab.lib.colors import HexColor
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph
from reportlab.pdfgen import canvas

OUT = 'samples/welcome-to-folio.pdf'
W, H = 396, 612            # 5.5 x 8.5 in, a trade paperback page
M = 44                     # margin
ACCENT = HexColor('#b4532a')
INK = HexColor('#2b2622')
MUTED = HexColor('#7a6f66')

body = ParagraphStyle('body', fontName='Times-Roman', fontSize=12.5, leading=18, textColor=INK, spaceAfter=10)
tip = ParagraphStyle('tip', parent=body, fontName='Times-Italic', textColor=MUTED, fontSize=11.5, leading=16)
tiny = ParagraphStyle('tiny', parent=body, fontSize=5.5, leading=7.5, textColor=MUTED)

# (outline title, heading, [paragraphs]) — each entry is one page
PAGES = [
    ('Turn the page', 'Turn the page', [
        'Folio turns pages sideways, like a paper book. <b>Swipe left</b>, or <b>tap the right edge</b> of the screen, to go forward.',
        'To go back, swipe right or tap the left edge. A quick flick is enough; drag partway and let go to change your mind.',
        ('On a computer, the arrow keys, Space and the mouse wheel turn pages too.', tip),
    ]),
    ('Zoom in', 'Zoom in', [
        '<b>Pinch</b> to zoom, or <b>double-tap</b> the spot you want to see closer. Double-tap again to zoom back out.',
        'While zoomed, drag to move around the page. Push past the edge of the page to turn it.',
        'Try it on the small print below:',
        ('Well done, you zoomed in. Folio redraws the text sharply as you zoom, up to five times, so small print '
         'in scanned books and textbooks stays readable.', tiny),
    ]),
    ('Show the menus', 'Show the menus', [
        '<b>Tap the middle of the page</b> to show or hide the bars at the top and bottom.',
        'The bars tuck themselves away when you turn a page, so the book fills the screen.',
        'At the bottom, drag the slider to jump through the book, or tap <b>Page X of Y</b> to type a page number. '
        'After a jump, a <b>Back to page</b> button takes you back to where you were.',
    ]),
    ('Bookmarks and contents', 'Bookmarks and contents', [
        'Tap the <b>ribbon</b> at the top right to bookmark the page you are on.',
        'The <b>list</b> button opens a side panel with three tabs: <b>Contents</b> (this book has chapters, so you can jump to any of them), '
        '<b>Bookmarks</b>, and <b>Search</b>. Try searching for the word <i>albums</i>.',
        'The <b>Aa</b> button holds display settings: light, sepia and dark themes, page layout and zoom.',
    ]),
    ('Two pages at once', 'Two pages at once', [
        'On a tablet, <b>turn the screen sideways</b>. Folio shows two pages side by side, like an open book, '
        'with the cover on its own.',
        'If you prefer one page at a time, open the <b>Aa</b> display settings and choose <b>Single</b> under Pages.',
    ]),
    ('Albums', 'Albums', [
        'When you add a PDF, Folio looks inside it, on this device only, and works out the title, the author, '
        'and what kind of book it is: fiction, a textbook, a manual, a cookbook and so on.',
        'It then suggests an album for it. Check the guess, fix anything it got wrong, and tap to file the book. '
        'You can move books between albums later from their <b>…</b> menu.',
    ]),
    ('Keep a backup', 'Keep a backup', [
        'Your books live only on this device. Nothing is uploaded anywhere, which also means that uninstalling Folio removes them.',
        'In the library, open <b>Settings</b> and tap <b>Back up</b> now and then. It saves your albums, bookmarks and reading '
        'positions to a small file. Keep your PDFs themselves in Files, Drive or Downloads too.',
        'On a new device, tap <b>Restore</b> and add the same PDFs: everything attaches to them again.',
    ]),
    ('Where to find books', 'Where to find books', [
        'Folio opens PDFs you already have: downloads, email attachments, your own documents and scans. '
        'These sites offer books you can download legally and free:',
        '<b>Project Gutenberg</b> (gutenberg.org): over 70,000 classics whose copyright has expired.',
        '<b>OpenStax</b> (openstax.org): free college textbooks as PDFs.',
        '<b>Internet Archive</b> (archive.org): its public-domain collections.',
        '<b>arXiv</b> (arxiv.org): research papers in science and maths.',
        ('Books bought from Kindle or Apple Books are copy-protected, so they cannot be opened in Folio.', tip),
    ]),
    ('You are ready', 'You are ready', [
        'That is everything. Tap the back arrow at the top left to return to your library and add your own books.',
        'When you are done with this practice book, delete it from its <b>…</b> menu in the library. '
        'You can bring it back any time from <b>Settings, then Show the tour again</b>.',
        ('Happy reading.', tip),
    ]),
]


def footer(c, n):
    c.setFont('Times-Roman', 9)
    c.setFillColor(MUTED)
    c.drawCentredString(W / 2, 28, str(n))


def cover(c):
    c.setFillColor(HexColor('#f6f3ee'))
    c.rect(0, 0, W, H, stroke=0, fill=1)
    c.setFillColor(ACCENT)
    c.rect(0, H - 14, W, 14, stroke=0, fill=1)
    c.setFillColor(INK)
    c.setFont('Times-Bold', 38)
    c.drawCentredString(W / 2, H * 0.62, 'Welcome')
    c.drawCentredString(W / 2, H * 0.62 - 44, 'to Folio')
    c.setStrokeColor(ACCENT)
    c.setLineWidth(1.5)
    c.line(W / 2 - 40, H * 0.62 - 70, W / 2 + 40, H * 0.62 - 70)
    sub = ParagraphStyle('sub', parent=body, alignment=TA_CENTER, textColor=MUTED, fontName='Times-Italic')
    p = Paragraph('A short practice book. Swipe left or tap the right edge to begin.', sub)
    _, h = p.wrap(W - 2 * M - 30, H)
    p.drawOn(c, M + 15, H * 0.62 - 100 - h)
    c.setFont('Times-Roman', 10)
    c.setFillColor(MUTED)
    c.drawCentredString(W / 2, 48, 'Your PDFs, read like books.')


def page(c, n, key, heading, paras):
    c.bookmarkPage(key)
    c.addOutlineEntry(heading, key, level=0)
    c.setFillColor(ACCENT)
    c.setFont('Times-Roman', 10)
    c.drawString(M, H - M - 4, f'Chapter {n - 1}')
    c.setFillColor(INK)
    c.setFont('Times-Bold', 24)
    c.drawString(M, H - M - 36, heading)
    y = H - M - 64
    for para in paras:
        text, style = para if isinstance(para, tuple) else (para, body)
        p = Paragraph(text, style)
        _, h = p.wrap(W - 2 * M, H)
        p.drawOn(c, M, y - h)
        y -= h + style.spaceAfter
    footer(c, n)


def main():
    c = canvas.Canvas(OUT, pagesize=(W, H), invariant=1)
    c.setTitle('Welcome to Folio')
    c.setAuthor('Folio')
    c.setSubject('A practice book for learning to use Folio')
    c.setCreator('Folio')
    c.showOutline()
    c.bookmarkPage('cover')
    c.addOutlineEntry('Cover', 'cover', level=0)
    cover(c)
    c.showPage()
    for i, (key, heading, paras) in enumerate(PAGES, start=2):
        page(c, i, key, heading, paras)
        c.showPage()
    c.save()


if __name__ == '__main__':
    main()

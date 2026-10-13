# Folio — book reader for iPad & Android

A private, offline reading app for PDF, EPUB, Kindle and Word books. Turn pages sideways like a book, keep your books sorted into albums, and pick up exactly where you left off. Your books, bookmarks and reading position stay on each device.

## 1. Put it online (one time, ~5 minutes, from a computer)

The app has to be served from a web address once so your devices can install it. Netlify's free drag-and-drop hosting is the easiest way:

1. Unzip `folio.zip` so you have a folder called **folio** (it contains `index.html`).
2. Go to **app.netlify.com/drop** and drag the **folio** folder onto the page.
3. When it finishes you'll get an address like `https://something-random-123.netlify.app`.
4. **Claim the site** (sign up for a free account when prompted) so it stays online. In *Site configuration → Change site name* you can rename it, e.g. `paul-folio.netlify.app`.

> Keep the same address forever. Your books are stored per web address, so if the address changes the app on your devices starts empty.

**Alternative — GitHub Pages:** make a public repo, upload the *contents* of the folio folder (GitHub's web uploader takes 100 files at a time, so upload `vendor/pdfjs/cmaps` in a second batch), then turn on *Settings → Pages → Deploy from branch → main*.

> **Updating from an older version?** Re-upload the whole folder to the same address. The app updates itself the next time it's opened online (close and reopen it once or twice). Your books, bookmarks and positions carry over.

## 2. Install on your iPad

1. Open the address in **Safari**.
2. Tap the **Share** button → **Add to Home Screen** → **Add**.
3. Open Folio from the home screen icon. **Add your books from inside the home-screen app.** It keeps its own storage, separate from Safari tabs.

## 3. Install on your Samsung phone

1. Open the address in **Chrome** (or Samsung Internet).
2. Chrome: **⋮ menu → Add to home screen → Install**. Samsung Internet: **☰ menu → Add page to → Home screen**.
3. Open Folio from the icon and add your books.

## First-run tour

The first time Folio opens with an empty shelf, it offers a quick tour that walks you through **Welcome to Folio**, a short guide book. Each page teaches one thing (zoom, the menus, bookmarks, jumping to a chapter, adding books, backups) and the tour points at the screen to match: an arrow on the real button, or an animated hint on the page. It waits until you've done each one, gives you time to read the pages that only explain, and at the end takes you back to the library to add your own books. *Skip* works at any point, and **Settings → Show the tour again** replays it. Delete the guide like any other book when you're done.

The guide PDF is built by `tools/make-sample-book.py` (needs `pip install reportlab`; it downloads the Source Serif 4 fonts into `tools/.fonts` and embeds them). Edit the text there and re-run it from the repo root to change it; if you reorder or retitle pages, update `STEPS` in `js/tour.js` to match.

## Book formats

| Format | How it reads |
| --- | --- |
| **PDF** | Page by page, exactly as printed, with zoom |
| **EPUB** (2 and 3), **Kindle** (MOBI, AZW3, AZW), **FB2** | Text that re-flows to the screen, with your choice of text size, font and line spacing |
| **Word** (.docx), **text** (.txt), **Markdown** (.md), **web pages** (.html) | Converted on the device into a re-flowing book, split into chapters at its headings |
| **Comics** (CBZ) | One image per page |

Re-flowing books count pages in steps of about 1,500 characters, so "page 41" stays the same place whatever the text size or screen, and bookmarks and backups keep working across devices.

**Books locked by a store can't be opened.** Books bought from Amazon, Apple Books, Google Play Books or Kobo, and library loans, are copy-protected (DRM) and only open in their own apps. Folio recognises them and says so; it never tries to unlock them. The same goes for `.acsm` files (Adobe download tickets), the newer KFX Kindle format, and older formats like `.doc`, `.rtf` and `.odt` (save those as `.docx` or PDF first).

Scripts inside EPUBs and web pages never run: the app's content security policy blocks them.

## Adding books (and what Folio does with them)

- **Add book:** tap *Add book* and pick books from Files, Drive or Downloads. You can pick several at once, or drag them onto the window on a computer.
- **Share to Folio (Android):** after installing from Chrome, open a downloaded book in Files/Downloads/Gmail → **Share → Folio**. It's added straight away. (iPad Safari doesn't offer this, so use *Add book* there. If you installed Folio before this version, Android may need a day to notice the new Share option, or remove and reinstall the app.)
- **It reads each book for you.** EPUB and Kindle files carry their own title, author and cover. For PDFs, Folio looks inside every new one, on your device only, and works out:
  - the **title and author** (from the file's info, or the biggest text on the cover, or a cleaned-up file name),
  - the **ISBN** and copyright year, if it has them,
  - whether it's a **scan** (no selectable text),
  - **what kind of document it is** — book, fiction, textbook, research paper, manual, cookbook, comic, slides or general document.
- **File your new books.** A sheet shows what was found. Fix the title or author if needed, then choose an album for each book. Tap **Suggested: …** (or **Use all suggestions**) to file by the guess; the suggested album is created for you the first time. These are educated guesses, not magic: check them, and skip anything you don't want. Settings → *Ask where to file new books* turns the sheet off.

## Albums

- The **Albums** row at the top of the library holds your albums. Tap one to open it; **New album** makes another. Each album shows a collage of its covers.
- **Move a book:** tap its **⋯ → Move to album**, or tap **Select**, tick several books, and tap **Move**.
- **Rename or delete an album** from the **⋯** in its header. Deleting an album never deletes books; they go back to *Unsorted*.
- A book lives in one album at a time. Adding a book while you're inside an album files it there.
- **Sort** the library by recently read, title, author, date added or progress.

## Reading

- **Turn pages sideways:** swipe left/right, or tap the left/right edge of the screen. A quick flick is enough; drag partway and let go to cancel.
- **Two-page spreads** appear automatically on wide screens (iPad landscape, computers), with the cover on its own like a closed book. *Display settings → Pages* lets you force Single or Spread.
- **Zoom:** pinch, or double-tap (double-tap again to zoom out). Drag to move around a zoomed page. While zoomed, tapping the right edge of the screen moves one screen on in reading order: down the page, then to the top of the next column or right-hand page, then to the next page, which opens at its top left (the left edge goes back the same way). Keep pushing past a page's edge to turn straight to the next page. The zoom stays on as you turn, so you can read a whole book zoomed in. Text is re-drawn sharply as you zoom and pan (up to 5×).
- **Tap the middle of the page** to show or hide the bars. The bars hide themselves when you turn a page (you can turn that off). On a computer, move the mouse to the top or bottom edge to bring them back.
- **Keyboard:** ← → / Space / Page Up / Page Down turn pages (zoomed in, Space and Page Up/Down move a screen at a time), Home / End jump to the ends, **Ctrl/⌘ +/−/0** zoom, **Ctrl/⌘ F** search, **B** bookmark, **Esc** closes things. The mouse wheel and trackpad swipes turn pages too, and you can select and copy text.
- **Bookmark:** tap the ribbon at the top right (or press **B**).
- **Contents / Bookmarks / Search:** the list button opens the side panel.
- **Jump anywhere:** drag the slider at the bottom (it previews the chapter), or tap "Page X of Y" to type a page number. After any jump, a **Back to page N** button takes you back.
- **Tт menu:** Auto/Light/Sepia/Dark theme, single/spread layout, zoom, dark pages in dark mode, tap-the-edge page turning, hide-the-bars, keep the screen awake. In re-flowing books (EPUB, Kindle, Word…) zoom is replaced by **text size**, **font** and **line spacing**. The fonts are the book's own, a serif, and six bundled free fonts: Arimo (like Arial/Helvetica), DejaVu Sans (like Verdana), Comic Neue (like Comic Sans), Lexend, Atkinson Hyperlegible (for low vision) and OpenDyslexic (for dyslexia). PDFs keep the fonts printed in them, and **Ctrl/⌘ +/−/0** change the text size.
- **Reading direction:** **Tт → Direction** (Auto / Left to right / Right to left), saved per book, in both readers. Auto reads it from the file (a PDF's right-to-left setting, an EPUB's page direction or language) or from Hebrew/Arabic text. Right to left flips taps, swipes, arrow keys, the slider, two-page spreads and the zoomed reading order (which starts top right), so it also suits manga.
- **It remembers your spot:** your position is saved continuously. If you close the app while reading, it reopens straight to that page (you can turn this off in Library → settings).

## Moving your library setup between devices

Each device is separate. To copy your albums, bookmarks and reading positions: **Library → settings (sliders icon) → Back up**, send the file to the other device (AirDrop, Drive, email…), then **Restore** there. Everything attaches to the same book automatically, even if you add the book after restoring.

## Good to know

- **Scanned PDFs** (photos of pages with no real text) can be read and bookmarked, but text can't be selected or searched, and Folio can only identify them from their file name and length.
- Everything works **offline** after the first launch.
- The Library settings show how much storage the app uses on the device.
- **Highlights and notes were removed** in this version. If an older version of Folio saved any on your device, they are left untouched in the app's storage (nothing is deleted), they just aren't shown or exported any more. Backups made by older versions restore fine; their highlights are ignored.
- PDF rendering uses Mozilla's pdf.js (Apache-2.0 license, included in `vendor/pdfjs`). EPUB, Kindle, FB2 and comic books use [foliate-js](https://github.com/johnfactotum/foliate-js) (MIT, `vendor/foliate`), and Word files are converted with [mammoth.js](https://github.com/mwilliamson/mammoth.js) (BSD-2-Clause, `vendor/mammoth`). Both are unmodified copies; `VERSION` in each folder says which. The reading fonts in `vendor/fonts` are free fonts under the SIL Open Font License (Arimo, Comic Neue, Lexend, Atkinson Hyperlegible, OpenDyslexic) and the Bitstream Vera licence (DejaVu Sans); see `vendor/fonts/README.md` and the `LICENSE` in each folder.

## For developers

No build step: it's plain ES modules served as static files.

| File | What it does |
| --- | --- |
| `index.html`, `css/app.css` | Markup and styles (light / sepia / dark) |
| `js/app.js` | Boot, shared-file intake |
| `js/library.js` | Library, albums, import, review sheet, backup/restore |
| `js/identify.js` | Offline PDF identification (title, author, ISBN, scan?, kind) |
| `js/reader.js` | The reader: bars, contents, bookmarks, search; pages, gestures, spreads and zoom for PDFs |
| `js/flow.js` | The text reader for every other format (wraps foliate-js) |
| `js/formats.js` | Detecting formats and locked books; Word/text/Markdown/HTML → book |
| `js/fonts.js` | The reading fonts offered in the text reader (files in `vendor/fonts`) |
| `js/db.js` | IndexedDB (v2: books, files, bookmarks, albums) |
| `js/ui.js`, `js/settings.js`, `js/pdf.js` | Shared helpers, settings/theme, pdf.js setup |
| `sw.js`, `manifest.webmanifest` | Offline cache, Android share target |

Serve the folder with any static server (e.g. `python3 -m http.server`) and open it in a browser. If you add a file under `js/`, add it to `SHELL` in `sw.js` and bump `VERSION` so offline installs pick it up.

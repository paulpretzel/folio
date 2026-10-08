# Folio — PDF book reader for iPad & Android

A private, offline reading app. Turn pages sideways like a book, keep your PDFs sorted into albums, and pick up exactly where you left off. Your books, bookmarks and reading position stay on each device.

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

## Adding books (and what Folio does with them)

- **Add book:** tap *Add book* and pick PDFs from Files, Drive or Downloads. You can pick several at once, or drag PDFs onto the window on a computer.
- **Share to Folio (Android):** after installing from Chrome, open a downloaded PDF in Files/Downloads/Gmail → **Share → Folio**. It's added straight away. (iPad Safari doesn't offer this, so use *Add book* there. If you installed Folio before this version, Android may need a day to notice the new Share option, or remove and reinstall the app.)
- **It reads each PDF for you.** Folio looks inside every new PDF, on your device only, and works out:
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
- **Zoom:** pinch, or double-tap (double-tap again to zoom out). Drag to move around a zoomed page; push past its edge to turn the page. Text is re-drawn sharply as you zoom (up to 5×).
- **Tap the middle of the page** to show or hide the bars. The bars hide themselves when you turn a page (you can turn that off). On a computer, move the mouse to the top or bottom edge to bring them back.
- **Keyboard:** ← → / Space / Page Up / Page Down turn pages, Home / End jump to the ends, **Ctrl/⌘ +/−/0** zoom, **Ctrl/⌘ F** search, **B** bookmark, **Esc** closes things. The mouse wheel and trackpad swipes turn pages too, and you can select and copy text.
- **Bookmark:** tap the ribbon at the top right (or press **B**).
- **Contents / Bookmarks / Search:** the list button opens the side panel.
- **Jump anywhere:** drag the slider at the bottom (it previews the chapter), or tap "Page X of Y" to type a page number. After any jump, a **Back to page N** button takes you back.
- **Tт menu:** Auto/Light/Sepia/Dark theme, single/spread layout, zoom, dark pages in dark mode, tap-the-edge page turning, hide-the-bars, keep the screen awake.
- **It remembers your spot:** your position is saved continuously. If you close the app while reading, it reopens straight to that page (you can turn this off in Library → settings).

## Moving your library setup between devices

Each device is separate. To copy your albums, bookmarks and reading positions: **Library → settings (sliders icon) → Back up**, send the file to the other device (AirDrop, Drive, email…), then **Restore** there. Everything attaches to the same PDF automatically, even if you add the book after restoring.

## Good to know

- **Scanned PDFs** (photos of pages with no real text) can be read and bookmarked, but text can't be selected or searched, and Folio can only identify them from their file name and length.
- Everything works **offline** after the first launch.
- The Library settings show how much storage the app uses on the device.
- **Highlights and notes were removed** in this version. If an older version of Folio saved any on your device, they are left untouched in the app's storage (nothing is deleted), they just aren't shown or exported any more. Backups made by older versions restore fine; their highlights are ignored.
- PDF rendering uses Mozilla's pdf.js (Apache-2.0 license, included in `vendor/pdfjs`).

## For developers

No build step: it's plain ES modules served as static files.

| File | What it does |
| --- | --- |
| `index.html`, `css/app.css` | Markup and styles (light / sepia / dark) |
| `js/app.js` | Boot, shared-file intake |
| `js/library.js` | Library, albums, import, review sheet, backup/restore |
| `js/identify.js` | Offline PDF identification (title, author, ISBN, scan?, kind) |
| `js/reader.js` | The paged reader: gestures, spreads, zoom, search, contents |
| `js/db.js` | IndexedDB (v2: books, files, bookmarks, albums) |
| `js/ui.js`, `js/settings.js`, `js/pdf.js` | Shared helpers, settings/theme, pdf.js setup |
| `sw.js`, `manifest.webmanifest` | Offline cache, Android share target |

Serve the folder with any static server (e.g. `python3 -m http.server`) and open it in a browser. If you add a file under `js/`, add it to `SHELL` in `sw.js` and bump `VERSION` so offline installs pick it up.

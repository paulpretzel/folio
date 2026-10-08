# Folio — PDF book reader for iPad & Android

A private, offline reading app. Your PDFs, highlights, notes, bookmarks and reading position stay on each device.

## 1. Put it online (one time, ~5 minutes, from a computer)

The app has to be served from a web address once so your devices can install it. Netlify's free drag-and-drop hosting is the easiest way:

1. Unzip `folio.zip` so you have a folder called **folio** (it contains `index.html`).
2. Go to **app.netlify.com/drop** and drag the **folio** folder onto the page.
3. When it finishes you'll get an address like `https://something-random-123.netlify.app`.
4. **Claim the site** (sign up for a free account when prompted) so it stays online. In *Site configuration → Change site name* you can rename it, e.g. `paul-folio.netlify.app`.

> Keep the same address forever. Your books are stored per web address, so if the address changes the app on your devices starts empty.

**Alternative — GitHub Pages:** make a public repo, upload the *contents* of the folio folder (GitHub's web uploader takes 100 files at a time, so upload `vendor/pdfjs/cmaps` in a second batch), then turn on *Settings → Pages → Deploy from branch → main*.

## 2. Install on your iPad

1. Open the address in **Safari**.
2. Tap the **Share** button → **Add to Home Screen** → **Add**.
3. Open Folio from the home screen icon. **Add your books from inside the home-screen app.** It keeps its own storage, separate from Safari tabs.

## 3. Install on your Samsung phone

1. Open the address in **Chrome** (or Samsung Internet).
2. Chrome: **⋮ menu → Add to home screen → Install**. Samsung Internet: **☰ menu → Add page to → Home screen**.
3. Open Folio from the icon and add your books.

## Using it

- **Add a book:** tap *Add book* and pick a PDF from Files, Drive or Downloads. You can pick several at once.
- **Highlight:** press and hold on text, drag the handles, then tap a color. The speech-bubble button highlights *and* adds a note.
- **Edit or remove a highlight:** tap it to change its color, add a note, copy the text or remove it (with Undo).
- **Bookmark:** tap the ribbon at the top right (or press **B** on a keyboard).
- **Contents / Bookmarks / Highlights / Search:** the list button opens the side panel. Highlights can be filtered by color or "Notes", and exported as a Markdown file.
- **Jump anywhere:** drag the slider at the bottom (it previews the chapter), or tap "Page X of Y" to type a page number. After any jump, a **Back to page N** button takes you back.
- **Zoom:** pinch, or use the Tт menu (− / + / Fit width). Each book remembers its zoom.
- **Tт menu:** Auto/Light/Sepia/Dark theme, dark pages in dark mode, tap-the-edge page turning, keep the screen awake, auto-hide the bars.
- **Tap the page** to show or hide the toolbars.
- **It remembers your spot:** your position is saved continuously. If you close the app while reading, it reopens straight to that page (you can turn this off in Library → settings).

## Moving annotations between devices

Each device is separate. To copy your highlights, notes, bookmarks and reading positions: **Library → settings (sliders icon) → Back up**, send the file to the other device (AirDrop, Drive, email…), then **Restore** there. Annotations attach to the same PDF automatically, even if you add the book after restoring.

## Good to know

- **Scanned PDFs** (photos of pages with no real text) can be read and bookmarked, but text can't be highlighted or searched.
- Everything works **offline** after the first launch.
- The Library settings show how much storage the app uses on the device.
- PDF rendering uses Mozilla's pdf.js (Apache-2.0 license, included in `vendor/pdfjs`).

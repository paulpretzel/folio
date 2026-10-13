/* Adding books. "Add book" offers two ways in:
 *   Auto select: pick a folder, and Folio adds every book in it (and in its folders)
 *   Manual select: pick the files yourself
 * Both pickers offer only files Folio can open. Chrome on Android adds "take a photo" and
 * "record audio" (and asks for the camera and microphone) whenever a file picker accepts any
 * kind of file, so the picker always names the book types.
 *
 * Android's picker filters by file type, and Chrome turns any extension Android doesn't know
 * (like .azw3) into "any file", which would switch the filter off. So on Android the picker gets
 * type names only; everywhere else it also gets the extensions. Auto select matches by
 * extension, so it also finds books whose type Android doesn't know.
 */
import { $, toast, busy, actionSheet } from './ui.js';
import { getBooks, importFiles } from './library.js';

const EXTENSIONS = ['pdf', 'epub', 'kepub', 'mobi', 'azw', 'azw3', 'prc', 'fb2', 'fbz', 'cbz', 'docx', 'txt', 'md', 'markdown', 'html', 'htm'];
const TYPES = [
  'application/pdf', 'application/epub+zip',
  'application/x-mobipocket-ebook', 'application/vnd.amazon.ebook', 'application/vnd.amazon.mobi8-ebook',
  'application/x-fictionbook+xml', 'application/x-fictionbook',
  'application/vnd.comicbook+zip', 'application/x-cbz',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain', 'text/markdown', 'text/x-markdown', 'text/html', 'application/xhtml+xml',
];
const TEXTY = new Set(['txt', 'md', 'markdown', 'html', 'htm']);
const MIN_TEXT_BYTES = 16 * 1024;   // Auto select skips notes and readme files: a book is longer than this
const MAX_DEPTH = 6;
const MAX_FILES = 300;

const android = /Android/i.test(navigator.userAgent);
const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const fileInput = $('#file-input');
fileInput.accept = (android ? TYPES : [...TYPES, ...EXTENSIONS.map((e) => `.${e}`)]).join(',');
fileInput.onchange = () => { importFiles(fileInput.files); fileInput.value = ''; };

// A folder picker: the File System Access one where there is one (Chrome), else a folder upload input
const canPickFolder = !ios && ('showDirectoryPicker' in window || 'webkitdirectory' in HTMLInputElement.prototype);
const folderInput = document.createElement('input');
Object.assign(folderInput, { type: 'file', hidden: true, multiple: true });
folderInput.setAttribute('webkitdirectory', '');
folderInput.onchange = () => { addFound([...folderInput.files]); folderInput.value = ''; };
fileInput.after(folderInput);

const extOf = (name) => (/\.([a-z0-9]+)$/i.exec(name || '')?.[1] || '').toLowerCase();
const isBook = (f) => EXTENSIONS.includes(extOf(f.name)) && !(TEXTY.has(extOf(f.name)) && f.size < MIN_TEXT_BYTES);

export function chooseFiles() { fileInput.click(); }

export async function chooseFolder() {
  if (!('showDirectoryPicker' in window)) return folderInput.click();
  let dir;
  try { dir = await showDirectoryPicker({ id: 'folio-books', mode: 'read' }); }
  catch (e) {
    if (e?.name !== 'AbortError') { console.warn(e); toast('Couldn’t open that folder'); }
    return;
  }
  busy(true, 'Looking for books…');
  const found = [];
  try { await walk(dir, 0, found); }
  catch (e) { console.warn('Couldn’t read the whole folder', e); }
  finally { busy(false); }
  addFound(found);
}

async function walk(dir, depth, found) {
  for await (const entry of dir.values()) {
    if (found.length >= MAX_FILES || entry.name.startsWith('.')) continue;
    if (entry.kind === 'directory') { if (depth < MAX_DEPTH) await walk(entry, depth + 1, found); }
    else if (EXTENSIONS.includes(extOf(entry.name))) found.push(await entry.getFile());
  }
}

/* Books found in a folder: skips what's already in the library (same name and size), adds the rest */
async function addFound(files) {
  const books = files.filter(isBook).slice(0, MAX_FILES);
  if (!books.length) return toast('No books in that folder');
  const have = new Set(getBooks().map((b) => `${b.fileName}|${b.size}`));
  const fresh = books.filter((f) => !have.has(`${f.name}|${f.size}`));
  if (!fresh.length) return toast(books.length === 1 ? 'That book is already in your library' : 'Those books are already in your library');
  await importFiles(fresh);
}

/** "Add book": Auto select or Manual select (straight to the file picker where folders can't be picked). */
export function addBooks() {
  if (!canPickFolder) return chooseFiles();
  actionSheet('Add books', [
    { label: 'Auto select', sub: 'Pick a folder. Folio adds every book in it.', icon: 'sparkle', run: chooseFolder },
    { label: 'Manual select', sub: 'Pick the books yourself.', icon: 'book', run: chooseFiles },
  ]);
}

$('#add-book-btn').onclick = addBooks;
$('#empty-add-btn').onclick = addBooks;

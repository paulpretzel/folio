// Tiny promise wrapper around IndexedDB.
//
// v1: books, files, highlights, bookmarks
// v2: + albums. The old `highlights` store is deliberately left in place on
//     upgraded installs (the feature is gone, but we never delete user data
//     during a schema upgrade). Fresh installs don't create it.
const DB_NAME = 'folio';
const DB_VERSION = 2;
let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('books')) db.createObjectStore('books', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      if (!db.objectStoreNames.contains('bookmarks')) {
        db.createObjectStore('bookmarks', { keyPath: 'id' }).createIndex('bookId', 'bookId');
      }
      if (!db.objectStoreNames.contains('albums')) db.createObjectStore('albums', { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('Database blocked — close other Folio tabs.'));
  });
  return dbPromise;
}

function done(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function store(name, mode = 'readonly') {
  const db = await open();
  return db.transaction(name, mode).objectStore(name);
}

export const db = {
  async get(name, key) { return done((await store(name)).get(key)); },
  async all(name) { return done((await store(name)).getAll()); },
  async put(name, value, key) { return done((await store(name, 'readwrite')).put(value, key)); },
  async del(name, key) { return done((await store(name, 'readwrite')).delete(key)); },
  async byBook(name, bookId) { return done((await store(name)).index('bookId').getAll(bookId)); },
  async putMany(name, values) {
    if (!values.length) return;
    const database = await open();
    return new Promise((resolve, reject) => {
      const tx = database.transaction(name, 'readwrite');
      const s = tx.objectStore(name);
      for (const v of values) s.put(v);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
  async deleteBook(bookId) {
    const database = await open();
    const bm = await this.byBook('bookmarks', bookId);
    // Clean up any highlights left over from older versions of the app.
    const legacy = database.objectStoreNames.contains('highlights')
      ? await this.byBook('highlights', bookId) : [];
    const stores = ['books', 'files', 'bookmarks', ...(legacy.length ? ['highlights'] : [])];
    return new Promise((resolve, reject) => {
      const tx = database.transaction(stores, 'readwrite');
      tx.objectStore('books').delete(bookId);
      tx.objectStore('files').delete(bookId);
      for (const b of bm) tx.objectStore('bookmarks').delete(b.id);
      for (const h of legacy) tx.objectStore('highlights').delete(h.id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  },
};

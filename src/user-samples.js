// IndexedDB-backed local sample loading for the Trussal Strudel engine.
// Mirrors the idbutils.mjs + files.mjs approach from the strudel.cc REPL so
// users can load folders of WAV/MP3/etc. files and reference them in patterns
// by parent-directory name, e.g. s("mydrums").

const DB_NAME = 'samples';
const DB_VERSION = 1;
const DB_TABLE = 'usersamples';
const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac']);
// Images ride in the same upload and the same store. They are not samples in
// the Strudel sense — nothing plays them — but they are the same gesture (drop
// a folder in, name it in a pattern) and splitting them into a second database
// would mean a second upload control and a second clear button.
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif']);

function extensionOf(filename) {
  return String(filename || '').split('.').pop().toLowerCase();
}

export function isAudioFile(filename) {
  return AUDIO_EXTENSIONS.has(extensionOf(filename));
}

export function isImageFile(filename) {
  return IMAGE_EXTENSIONS.has(extensionOf(filename));
}

// Uploads are stored EXACTLY as they arrive and are never rewritten — not on
// upload, not by an effect. `# crush` compresses a render-time copy
// (compressImage below); the bytes in IndexedDB stay the performer's original,
// so turning an effect off restores the picture rather than leaving it
// permanently degraded, and a set does not slowly destroy its own material.

// Open (and create if necessary) the samples IndexedDB. Returns a Promise that
// resolves to { objectStore, db } or null when IDB is unavailable.
function openSamplesDB() {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      resolve(null);
      return;
    }
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const store = req.result.createObjectStore(DB_TABLE, { keyPath: 'id', autoIncrement: false });
      ['blob', 'title'].forEach(c => store.createIndex(c, c, { unique: false }));
    };
    req.onerror = () => reject(req.error);
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction([DB_TABLE], 'readwrite');
      resolve({ objectStore: tx.objectStore(DB_TABLE), db });
    };
  });
}

// Read all stored samples from IDB and register them with Strudel.
// `registerSampleSource` comes from @strudel/web (passed in so this module
// doesn't import it statically — Strudel is loaded lazily).
export async function registerSamplesFromDB(registerSampleSource) {
  const idb = await openSamplesDB().catch(() => null);
  if (!idb) return;

  const { objectStore } = idb;
  const soundFiles = await new Promise((resolve, reject) => {
    const q = objectStore.getAll();
    q.onerror = () => reject(q.error);
    q.onsuccess = (e) => resolve(e.target.result);
  });

  if (!soundFiles?.length) return;

  const sounds = new Map();
  await Promise.all(
    [...soundFiles]
      .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }))
      .map((sf) => {
        if (!isAudioFile(sf.title)) return null;
        const parts = sf.id.split('/');
        const parent = parts.length >= 2 ? parts[parts.length - 2] : (sf.id.split(/\W+/)[0] ?? 'user');
        const url = URL.createObjectURL(sf.blob);
        const bank = sounds.get(parent) ?? new Map();
        bank.set(sf.title, url);
        sounds.set(parent, bank);
        return null;
      })
      .filter(Boolean),
  );

  sounds.forEach((bank, key) => {
    const urls = Array.from(bank.keys()).sort((a, b) => a.localeCompare(b)).map(t => bank.get(t));
    registerSampleSource(key, urls, { prebake: false });
  });

  if (sounds.size > 0) {
    console.log('[trussal] local samples registered:', [...sounds.keys()].join(', '));
  }
}

// Return [{name, count}] for every audio folder currently stored in IDB,
// sorted alphabetically. Used to render the sample bank list in the Studio UI.
export async function getSampleBanks() {
  const idb = await openSamplesDB().catch(() => null);
  if (!idb) return [];
  const { objectStore } = idb;
  const soundFiles = await new Promise((resolve, reject) => {
    const q = objectStore.getAll();
    q.onerror = () => reject(q.error);
    q.onsuccess = (e) => resolve(e.target.result);
  }).catch(() => []);
  if (!soundFiles?.length) return [];
  const counts = new Map();
  for (const sf of soundFiles) {
    if (!isAudioFile(sf.title)) continue;
    const parts = sf.id.split('/');
    const parent = parts.length >= 2 ? parts[parts.length - 2] : (sf.id.split(/\W+/)[0] ?? 'user');
    counts.set(parent, (counts.get(parent) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }));
}

// Delete the entire samples IndexedDB. After this, getSampleBanks() returns [].
export async function clearSamplesDB() {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) { resolve(); return; }
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = resolve;
    req.onerror = resolve;
    req.onblocked = resolve;
  });
}

// Store a FileList (from <input type="file"> or drag-and-drop) in IDB.
// Calls onDone(count) when complete, where count is the number of files stored.
export async function uploadSamplesToDB(files, onDone) {
  const wanted = Array.from(files).filter(f => isAudioFile(f.name) || isImageFile(f.name));
  if (!wanted.length) { onDone?.(0); return; }

  const records = await Promise.all(wanted.map(async (f) => {
    const blob = await fetch(URL.createObjectURL(f)).then(r => r.blob());
    return {
      id: f.webkitRelativePath?.length ? f.webkitRelativePath : f.name,
      title: f.name,
      blob,
    };
  }));

  const idb = await openSamplesDB();
  if (!idb) { onDone?.(0); return; }

  const { objectStore } = idb;
  records.forEach(r => objectStore.put(r));
  console.log(`[trussal] stored ${records.length} sample(s) in IDB`);
  onDone?.(records.length);
}

// --- uploaded images ----------------------------------------------------------
//
// An uploaded image is addressed the way an uploaded sample bank is: by the
// folder it arrived in. `img("mypics")` gives the first image in that folder,
// `img("mypics", 2)` the third, and the result is an object URL that Hydra's
// own initImage takes:
//
//   await initHydra()
//   s1.initImage(img("mypics"))
//   src(s1).modulate(osc(4)).out(o0)
//
// These URLs are minted in THIS browser against THIS browser's IndexedDB, so
// they mean nothing anywhere else — which is why hydra-code.js treats an
// `img(` preamble as a blit cell, exactly as it treats the camera: the room
// sees the performer's published track rather than a broken image drawn by an
// aggregator that never had the file.

const imageUrls = new Map();   // folder → [{ title, url }]

function folderOf(id) {
  const parts = String(id).split('/');
  return parts.length > 1 ? parts[parts.length - 2] : '';
}

// Mint object URLs for every stored image and expose `img()` to Hydra code.
// Called alongside registerSamplesFromDB. Idempotent: existing URLs are
// revoked first so a re-registration does not leak one per call.
export async function registerImagesFromDB() {
  const idb = await openSamplesDB().catch((e) => {
    console.error('[trussal] could not open the sample DB for images', e);
    throw e;
  });
  if (!idb) return 0;

  for (const entries of imageUrls.values()) {
    for (const entry of entries) URL.revokeObjectURL(entry.url);
  }
  imageUrls.clear();

  const { objectStore } = idb;
  const stored = await new Promise((resolve, reject) => {
    const req = objectStore.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });

  let count = 0;
  for (const record of stored) {
    if (!record || !isImageFile(record.title || record.id)) continue;
    const folder = folderOf(record.id) || (record.title || '').replace(/\.[^.]+$/, '');
    if (!imageUrls.has(folder)) imageUrls.set(folder, []);
    // The blob is READ, never written back: an object URL is a handle to the
    // stored bytes, not a copy of them, and nothing here puts a record.
    imageUrls.get(folder).push({ title: record.title, url: URL.createObjectURL(record.blob) });
    count++;
  }
  for (const entries of imageUrls.values()) {
    entries.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  }

  if (typeof window !== 'undefined') window.img = imageUrl;
  console.log(`[trussal] ${count} uploaded image(s) available to img()`);
  return count;
}

// `img("folder"[, index])` — the URL a Hydra preamble hands to initImage.
// Returns an empty string for an unknown folder rather than throwing: a typo
// in a live-coded preamble should draw nothing, not take the program down.
export function imageUrl(folder, index = 0) {
  const entries = imageUrls.get(String(folder));
  if (!entries || !entries.length) {
    console.warn(`[trussal] img("${folder}") — no uploaded image by that name`);
    return '';
  }
  const i = Number.isFinite(index) ? Math.abs(Math.trunc(index)) % entries.length : 0;
  return entries[i].url;
}

// How much of an image survives `# crush`, given the pixel block the frame
// effects resolved to. Pure, so the mapping is testable without a canvas: a
// block of 1 is the untouched image, and the result is the size the copy is
// drawn THROUGH before being scaled back up.
export function compressedSize(width, height, pixelBlock) {
  const block = Math.max(1, Math.round(pixelBlock || 1));
  return {
    width: Math.max(1, Math.round(width / block)),
    height: Math.max(1, Math.round(height / block))
  };
}

// Render-time compression: draw the image through a smaller canvas and back,
// so what Hydra samples is blocky in the same way the crushed audio is stepped.
//
// Returns a NEW canvas every call and never touches `image` or the stored
// blob — that is the whole contract. An effect must be undoable by deleting
// the directive, which it cannot be if the material itself was rewritten.
export function compressImage(image, pixelBlock) {
  const width = image.naturalWidth || image.width;
  const height = image.naturalHeight || image.height;
  const out = document.createElement('canvas');
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  const small = compressedSize(width, height, pixelBlock);
  if (small.width === width && small.height === height) {
    ctx.drawImage(image, 0, 0);
    return out;
  }
  const buffer = document.createElement('canvas');
  buffer.width = small.width;
  buffer.height = small.height;
  const bctx = buffer.getContext('2d');
  bctx.imageSmoothingEnabled = false;
  bctx.drawImage(image, 0, 0, small.width, small.height);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(buffer, 0, 0, small.width, small.height, 0, 0, width, height);
  return out;
}

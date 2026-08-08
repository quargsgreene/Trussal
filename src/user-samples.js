// IndexedDB-backed local sample loading for the Trussal Strudel engine.
// Mirrors the idbutils.mjs + files.mjs approach from the strudel.cc REPL so
// users can load folders of WAV/MP3/etc. files and reference them in patterns
// by parent-directory name, e.g. s("mydrums").
//
// The same uploader also takes JSON/CSV/TSV files, which become DATA packs
// rather than sounds: a file becomes a pack named after itself and each column
// or top-level property becomes one sample of values, referenced as
// "Weather:3". Parsing lives in data-samples-core.js and reference semantics in
// data-ref.js; this module only stores the result.
//
// Both kinds share one object store. A data record carries `pack` where an
// audio record carries `blob`, and since isAudioFile() gates every audio read
// on the file extension, the audio paths skip data records without needing to
// know they exist.

import {
  parseDataFile, isDataFile, MAX_VALUES_TOTAL,
} from './data-samples-core.js';

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

// Data records are keyed under this prefix so they can be told apart from the
// audio records, whose ids are file paths.
const DATA_ID_PREFIX = 'data:';

export function isAudioFile(filename) {
  return AUDIO_EXTENSIONS.has(extensionOf(filename));
}

export function isImageFile(filename) {
  return IMAGE_EXTENSIONS.has(extensionOf(filename));
}

export { isDataFile };

// Uploads are stored EXACTLY as they arrive and are never rewritten — not on
// upload, not by an effect. `# crush` compresses a render-time copy
// (compressImage below); the bytes in IndexedDB stay the performer's original,
// so turning an effect off restores the picture rather than leaving it
// permanently degraded, and a set does not slowly destroy its own material.

// Open (and create if necessary) the samples IndexedDB. Resolves to the db, or
// null when IDB is unavailable.
function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) {
      resolve(null);
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore(DB_TABLE, { keyPath: 'id', autoIncrement: false });
      ['blob', 'title'].forEach(c => store.createIndex(c, c, { unique: false }));
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

// Run `fn` against a FRESH transaction and resolve once that transaction has
// committed. Each call gets its own transaction on purpose: a read-then-write
// flow (per-sample delete) cannot borrow one created at open time, because the
// transaction goes inactive as soon as the task that created it yields.
async function withStore(mode, fn) {
  const db = await openDB().catch((e) => {
    console.error('[trussal] samples DB failed to open', e);
    throw e;
  });
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction([DB_TABLE], mode);
    const store = tx.objectStore(DB_TABLE);
    let result;
    Promise.resolve(fn(store)).then((r) => { result = r; }).catch(reject);
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Promisify one IDBRequest.
function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readAll() {
  return withStore('readonly', (store) => req(store.getAll())).catch((e) => {
    console.error('[trussal] samples DB read failed', e);
    return [];
  });
}

// The bank an audio record belongs to: its parent directory, which is what
// s("foldername") refers to.
function bankOf(record) {
  const parts = record.id.split('/');
  return parts.length >= 2 ? parts[parts.length - 2] : (record.id.split(/\W+/)[0] ?? 'user');
}

const isDataRecord = (record) => record?.kind === 'data' && !!record.pack;

// Read all stored samples from IDB and register them with Strudel.
// `registerSampleSource` comes from @strudel/web (passed in so this module
// doesn't import it statically — Strudel is loaded lazily).
export async function registerSamplesFromDB(registerSampleSource) {
  const soundFiles = await readAll();
  if (!soundFiles?.length) return;

  const sounds = new Map();
  [...soundFiles]
    .sort((a, b) => a.title.localeCompare(b.title, undefined, { numeric: true, sensitivity: 'base' }))
    .forEach((sf) => {
      if (isDataRecord(sf) || !isAudioFile(sf.title)) return;
      const url = URL.createObjectURL(sf.blob);
      const bank = sounds.get(bankOf(sf)) ?? new Map();
      bank.set(sf.title, url);
      sounds.set(bankOf(sf), bank);
    });

  sounds.forEach((bank, key) => {
    const urls = Array.from(bank.keys()).sort((a, b) => a.localeCompare(b)).map(t => bank.get(t));
    registerSampleSource(key, urls, { prebake: false });
  });

  if (sounds.size > 0) {
    console.log('[trussal] local samples registered:', [...sounds.keys()].join(', '));
  }
}

// Every stored sample as { bank, name, blob }, grouped the same way
// registerSamplesFromDB groups them (parent folder = bank name) so a bot
// registers exactly the banks its author's own `s("...")` calls name.
//
// Used to hand a performer's library to their bots, which run in separate
// browser profiles and therefore share none of this IndexedDB.
export async function readSampleBanks() {
  const records = await readAll();
  if (!records?.length) return [];

  return records
    .filter((sf) => !isDataRecord(sf) && isAudioFile(sf.title))
    .map((sf) => ({ bank: bankOf(sf), name: sf.title, blob: sf.blob }));
}

/**
 * Every bank and pack currently stored, for the Studio list.
 *
 * Returns [{ name, kind, count, samples: [{ label, id }] }] sorted by name,
 * where `kind` is 'audio' or one of 'csv' | 'tsv' | 'json'. `count` is the
 * number of samples — for a data pack that is its column/property count, not
 * its row count. Each sample carries the `id` its own delete needs. A data
 * pack's sample also carries `preview`, the raw→cast tooltip text built at
 * upload time (undefined for audio samples).
 */
export async function getSampleBanks() {
  const records = await readAll();
  if (!records?.length) return [];

  const banks = new Map();
  for (const record of records) {
    if (isDataRecord(record)) {
      banks.set(record.pack.name, {
        name: record.pack.name,
        kind: record.pack.kind,
        count: record.pack.samples.length,
        truncated: record.pack.truncatedSamples > 0 || record.pack.droppedSamples > 0,
        samples: record.pack.samples.map((s, i) => ({
          label: s.label,
          id: `${record.id}#${i}`,
          length: s.values.length,
          truncated: s.truncated,
          preview: s.preview,
        })),
      });
      continue;
    }
    if (!isAudioFile(record.title)) continue;
    const name = bankOf(record);
    const bank = banks.get(name) ?? { name, kind: 'audio', count: 0, truncated: false, samples: [] };
    bank.samples.push({ label: record.title, id: record.id });
    bank.count = bank.samples.length;
    banks.set(name, bank);
  }

  for (const bank of banks.values()) {
    if (bank.kind === 'audio') bank.samples.sort((a, b) => a.label.localeCompare(b.label));
  }
  return [...banks.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Every stored data pack, for the reference registry and the peer broadcast. */
export async function getDataPacks() {
  const records = await readAll();
  return (records ?? []).filter(isDataRecord).map(r => r.pack);
}

// Delete the entire samples IndexedDB. After this, getSampleBanks() returns [].
export async function clearSamplesDB() {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) { resolve(); return; }
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = resolve;
    request.onerror = resolve;
    request.onblocked = resolve;
  });
}

/**
 * Delete one sample by the id getSampleBanks() gave it.
 *
 * An audio sample is its own record, so it just goes. A data sample is one
 * entry inside a pack record, so the pack is rewritten without it — and when
 * that empties the pack, the record goes too rather than leaving a bank with
 * nothing in it.
 */
export async function deleteSample(sampleId) {
  const id = String(sampleId ?? '');
  if (!id) return;

  const hash = id.lastIndexOf('#');
  if (!id.startsWith(DATA_ID_PREFIX) || hash < 0) {
    await withStore('readwrite', (store) => req(store.delete(id)));
    return;
  }

  const recordId = id.slice(0, hash);
  const index = Number(id.slice(hash + 1));
  await withStore('readwrite', async (store) => {
    const record = await req(store.get(recordId));
    if (!isDataRecord(record) || !Number.isInteger(index)) return;
    const samples = record.pack.samples.filter((_, i) => i !== index);
    if (!samples.length) {
      await req(store.delete(recordId));
      return;
    }
    await req(store.put({ ...record, pack: { ...record.pack, samples } }));
  });
}

// Store a FileList (from <input type="file"> or drag-and-drop) in IDB.
// Audio files become sample banks, images become image folders, and
// JSON/CSV/TSV files become data packs.
// Calls onDone({ audio, images, packs, errors }) when complete.
export async function uploadSamplesToDB(files, onDone) {
  const all = Array.from(files ?? []);
  const audioFiles = all.filter(f => isAudioFile(f.name));
  const imageFiles = all.filter(f => isImageFile(f.name));
  const dataFiles = all.filter(f => isDataFile(f.name));
  if (!audioFiles.length && !imageFiles.length && !dataFiles.length) {
    onDone?.({ audio: 0, images: 0, packs: 0, errors: [] });
    return;
  }

  // Audio and images are stored identically — id, title, blob — and told apart
  // on the way out by extension, so both are addressed by the folder they
  // arrived in. Only a data pack carries a `kind`.
  const blobRecords = await Promise.all([...audioFiles, ...imageFiles].map(async (f) => ({
    id: f.webkitRelativePath?.length ? f.webkitRelativePath : f.name,
    title: f.name,
    blob: await f.arrayBuffer().then(buf => new Blob([buf], { type: f.type })),
  })));

  // Names already in use, so an upload can never silently replace a bank or a
  // pack, and the browser-wide value budget left for the new packs.
  const existing = await getSampleBanks();
  const taken = new Set(existing.map(b => b.name));
  for (const record of blobRecords) taken.add(bankOf(record));
  let budget = MAX_VALUES_TOTAL - (await getDataPacks())
    .reduce((sum, pack) => sum + pack.samples.reduce((n, s) => n + s.values.length, 0), 0);

  const errors = [];
  const dataRecords = [];
  for (const f of dataFiles) {
    try {
      if (budget <= 0) throw new Error(`${f.name}: no room left — delete some data samples first`);
      const pack = parseDataFile(f.name, await f.text(), { budget, taken });
      taken.add(pack.name);
      budget -= pack.samples.reduce((n, s) => n + s.values.length, 0);
      dataRecords.push({ id: `${DATA_ID_PREFIX}${pack.name}`, title: f.name, kind: 'data', pack });
    } catch (e) {
      console.error('[trussal] data file rejected', e);
      errors.push(e.message);
    }
  }

  const records = [...blobRecords, ...dataRecords];
  if (records.length) {
    await withStore('readwrite', (store) => { records.forEach(r => store.put(r)); });
    console.log(`[trussal] stored ${audioFiles.length} sample(s), ${imageFiles.length} image(s)`
      + ` and ${dataRecords.length} data pack(s) in IDB`);
  }
  onDone?.({
    audio: audioFiles.length,
    images: imageFiles.length,
    packs: dataRecords.length,
    errors,
  });
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

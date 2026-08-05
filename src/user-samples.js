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

// Data records are keyed under this prefix so they can be told apart from the
// audio records, whose ids are file paths.
const DATA_ID_PREFIX = 'data:';

export function isAudioFile(filename) {
  return AUDIO_EXTENSIONS.has(filename.split('.').pop().toLowerCase());
}

export { isDataFile };

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

/**
 * Every bank and pack currently stored, for the Studio list.
 *
 * Returns [{ name, kind, count, samples: [{ label, id }] }] sorted by name,
 * where `kind` is 'audio' or one of 'csv' | 'tsv' | 'json'. `count` is the
 * number of samples — for a data pack that is its column/property count, not
 * its row count. Each sample carries the `id` its own delete needs.
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
// Audio files become sample banks; JSON/CSV/TSV files become data packs.
// Calls onDone({ audio, packs, errors }) when complete.
export async function uploadSamplesToDB(files, onDone) {
  const all = Array.from(files ?? []);
  const audioFiles = all.filter(f => isAudioFile(f.name));
  const dataFiles = all.filter(f => isDataFile(f.name));
  if (!audioFiles.length && !dataFiles.length) {
    onDone?.({ audio: 0, packs: 0, errors: [] });
    return;
  }

  const audioRecords = await Promise.all(audioFiles.map(async (f) => ({
    id: f.webkitRelativePath?.length ? f.webkitRelativePath : f.name,
    title: f.name,
    blob: await f.arrayBuffer().then(buf => new Blob([buf], { type: f.type })),
  })));

  // Names already in use, so an upload can never silently replace a bank or a
  // pack, and the browser-wide value budget left for the new packs.
  const existing = await getSampleBanks();
  const taken = new Set(existing.map(b => b.name));
  for (const record of audioRecords) taken.add(bankOf(record));
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

  const records = [...audioRecords, ...dataRecords];
  if (records.length) {
    await withStore('readwrite', (store) => { records.forEach(r => store.put(r)); });
    console.log(`[trussal] stored ${audioRecords.length} sample(s)`
      + ` and ${dataRecords.length} data pack(s) in IDB`);
  }
  onDone?.({ audio: audioRecords.length, packs: dataRecords.length, errors });
}

// IndexedDB-backed local sample loading for the Trussal Strudel engine.
// Mirrors the idbutils.mjs + files.mjs approach from the strudel.cc REPL so
// users can load folders of WAV/MP3/etc. files and reference them in patterns
// by parent-directory name, e.g. s("mydrums").

const DB_NAME = 'samples';
const DB_VERSION = 1;
const DB_TABLE = 'usersamples';
const AUDIO_EXTENSIONS = new Set(['wav', 'mp3', 'flac', 'ogg', 'm4a', 'aac']);

export function isAudioFile(filename) {
  return AUDIO_EXTENSIONS.has(filename.split('.').pop().toLowerCase());
}

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

// Every stored sample as { bank, name, blob }, grouped the same way
// registerSamplesFromDB groups them (parent folder = bank name) so a bot
// registers exactly the banks its author's own `s("...")` calls name.
//
// Used to hand a performer's library to their bots, which run in separate
// browser profiles and therefore share none of this IndexedDB.
export async function readSampleBanks() {
  const idb = await openSamplesDB().catch(() => null);
  if (!idb) return [];

  const soundFiles = await new Promise((resolve, reject) => {
    const q = idb.objectStore.getAll();
    q.onerror = () => reject(q.error);
    q.onsuccess = (e) => resolve(e.target.result);
  }).catch(() => null);
  if (!soundFiles?.length) return [];

  return soundFiles
    .filter((sf) => isAudioFile(sf.title))
    .map((sf) => {
      const parts = String(sf.id).split('/');
      const bank = parts.length >= 2 ? parts[parts.length - 2] : (String(sf.id).split(/\W+/)[0] ?? 'user');
      return { bank, name: sf.title, blob: sf.blob };
    });
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
  const audioFiles = Array.from(files).filter(f => isAudioFile(f.name));
  if (!audioFiles.length) { onDone?.(0); return; }

  const records = await Promise.all(audioFiles.map(async (f) => {
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

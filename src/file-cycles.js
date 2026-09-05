// File-attachment patterns — Strudel patterns that post a file into Jitsi's
// chat as a downloadable attachment instead of making sound:
//
//   $: image("cat.png dog.jpeg").fast(4)
//   vid: video("me.mp4")
//
// A file is uploaded once (Studio's Files picker, wired in studio.js), stored
// in this browser's own IndexedDB, and referenced by filename from a
// pattern. Every browser evaluates every peer's program (see strudel.js), so
// on the FIRST trigger of a given filename, the authoring browser reads it
// from its own store and broadcasts it once over the sidecar
// (peer-state.js's sendChatFile / latency-instrument/server.js's 'chat-file'
// case); every other browser that receives it, and every later trigger of
// the same filename anywhere, renders from a local cache instead of
// re-sending or re-fetching anything.
//
// SILENT BY CONSTRUCTION and MINTED, the same mechanism word() uses (see
// text-cycles.js's doc comment and file-cycles-core.js's) — a filename may
// hold characters mini notation cannot (a space, mixed case), so it travels
// as a placeholder token with the real name and its authoring peer carried
// in an atom table set by strudel.js before each evaluate.

import { getPeerByJitsiId, getLocalPeer, isPeerJPatternTurn, sendChatFile, subscribePeerState } from './peer-state.js';
import { FILE_KINDS, mimeOfFilename, validateUpload } from './file-cycles-core.js';
import { ensureChatEntry } from './chat-entry.js';

const CONTAINER_ID = 'trussal-file-cycles';
const STYLE_ID = 'trussal-file-cycles-style';
const MAX_BUBBLES = 100;

let atoms = {};      // token -> { text, peer }
let active = false;
let container = null;
let styleEl = null;
let bubbleCount = 0;

// Replace the atom table. Called by strudel.js immediately before evaluate(),
// exactly as setTextAtoms is.
export function setFileAtoms(table) { atoms = table || {}; }

function resolve(value) {
  if (value == null) return null;
  const atom = atoms[String(value)];
  return atom ? atom.text : String(value);
}

function peerOf(value) {
  const atom = atoms[String(value)];
  return atom ? atom.peer : null;
}

// --- local upload store (IndexedDB) -----------------------------------------
//
// Deliberately its OWN small database rather than folded into
// user-samples.js: that module's records, groupings and exported functions
// (bankOf, registerSamplesFromDB, getSampleBanks, …) are all built around
// audio banks and Hydra image folders, a different feature with a different
// extension allow-list — see file-cycles-core.js's doc comment.

const DB_NAME = 'trussal-attachments';
const DB_VERSION = 1;
const DB_TABLE = 'files';

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) { resolve(null); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(DB_TABLE, { keyPath: 'name' });
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function withStore(mode, fn) {
  const db = await openDB().catch((e) => { console.error('[file-cycles] DB failed to open', e); throw e; });
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

function req(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

// Store a FileList (from Studio's Files picker) in IDB, capped and
// extension-checked with the same rule the sidecar re-checks on the way out
// (validateUpload — one rule, two consumers, the same reasoning as
// hydra-code.js). Calls onDone({ count, errors }).
export async function uploadChatFilesToDB(files, onDone) {
  const all = Array.from(files ?? []);
  const errors = [];
  const records = [];
  for (const f of all) {
    const { ok, reason, kind } = validateUpload(f.name, f.size);
    if (!ok) { errors.push(reason); continue; }
    records.push({
      name: f.name,
      kind,
      mime: f.type || mimeOfFilename(f.name),
      blob: await f.arrayBuffer().then((buf) => new Blob([buf])),
    });
  }
  if (records.length) {
    await withStore('readwrite', (store) => { records.forEach((r) => store.put(r)); });
    console.log(`[trussal] stored ${records.length} attachment(s) in IDB`);
  }
  onDone?.({ count: records.length, errors });
}

function getLocalFile(name) {
  return withStore('readonly', (store) => req(store.get(name))).catch((e) => {
    console.error('[file-cycles] read failed', e);
    return null;
  });
}

export async function clearFilesDB() {
  return new Promise((resolve) => {
    if (typeof window === 'undefined' || !('indexedDB' in window)) { resolve(); return; }
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = resolve;
    request.onerror = resolve;
    request.onblocked = resolve;
  });
}

// --- cross-peer bytes: broadcast once, cache everywhere ---------------------
//
// Keyed by filename alone, not by (peer, filename): two different peers
// uploading two different files under the identical name would collide in
// this cache the same way two different-content s("kick") banks would in
// user-samples.js's — an accepted, documented simplification rather than
// carrying a room-index↔jitsiId translation just for a cache key. The
// bubble's byline still shows the right author, from the atom's own peer
// field, independent of this cache.
const received = new Map();  // name -> { blob, mime, kind }
const inFlight = new Map();  // name -> Promise, so two haps racing the same
                              // filename before the first resolves don't both
                              // read IDB and both broadcast.

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Load this browser's own copy of `name` from IDB and broadcast it once.
// Returns the record for immediate local rendering, or null if there is no
// such upload (a typo in a live-coded pattern draws nothing, the same
// graceful-failure contract imageUrl() in user-samples.js follows).
function loadAndBroadcastOwn(name) {
  if (received.has(name)) return Promise.resolve(received.get(name));
  if (inFlight.has(name)) return inFlight.get(name);
  const p = (async () => {
    const stored = await getLocalFile(name);
    if (!stored) {
      console.warn(`[file-cycles] "${name}" — no file by that name in your uploads`);
      return null;
    }
    const record = { blob: stored.blob, mime: stored.mime, kind: stored.kind };
    received.set(name, record);
    const data = await blobToBase64(stored.blob);
    sendChatFile({ kind: stored.kind, name: stored.name, mime: stored.mime, data });
    return record;
  })();
  inFlight.set(name, p);
  p.finally(() => inFlight.delete(name));
  return p;
}

subscribePeerState((event, payload) => {
  if (event !== 'chat-file') return;
  // Our own upload already went straight into `received` when we broadcast
  // it — a remote peer's file is what actually needs this path.
  if (received.has(payload.name)) return;
  try {
    const bytes = Uint8Array.from(atob(payload.data), (c) => c.charCodeAt(0));
    received.set(payload.name, { blob: new Blob([bytes], { type: payload.mime }), mime: payload.mime, kind: payload.kind });
  } catch (e) {
    console.error('[file-cycles] could not decode a received attachment', e);
  }
});

// --- chat rendering ----------------------------------------------------------

function ensureStyle() {
  if (styleEl && document.contains(styleEl)) return styleEl;
  styleEl = document.getElementById(STYLE_ID) || document.createElement('style');
  styleEl.id = STYLE_ID;
  if (!styleEl.textContent) {
    styleEl.textContent = `
#${CONTAINER_ID} .fc-bubble { margin: 4px 0; padding: 0 16px; }
#${CONTAINER_ID} .fc-name { font-size: 12px; opacity: .6; }
#${CONTAINER_ID} .fc-media { max-width: 240px; max-height: 240px; display: block; margin-top: 2px; border-radius: 4px; }
#${CONTAINER_ID} .fc-link { display: inline-block; margin-top: 2px; }
`;
  }
  if (!document.contains(styleEl)) document.head.appendChild(styleEl);
  return styleEl;
}

function ensureContainer() {
  if (!container) {
    container = document.createElement('div');
    container.id = CONTAINER_ID;
  }
  ensureStyle();
  return container;
}

function localToken() {
  const index = getLocalPeer()?.roomIndex;
  return index == null || index === '' ? null : String(index);
}

function mediaElementFor(kind, url, name, mime) {
  if (kind === 'image') {
    const img = document.createElement('img');
    img.className = 'fc-media';
    img.src = url;
    img.alt = name;
    return img;
  }
  if (kind === 'video') {
    const video = document.createElement('video');
    video.className = 'fc-media';
    video.src = url;
    video.controls = true;
    return video;
  }
  if (kind === 'soundFile') {
    const audio = document.createElement('audio');
    audio.src = url;
    audio.controls = true;
    return audio;
  }
  // textFile / pdfFile: a plain download link.
  const a = document.createElement('a');
  a.className = 'fc-link';
  a.href = url;
  a.download = name;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.textContent = `⬇ ${name}`;
  return a;
}

function renderBubble(name, record, peerId) {
  ensureContainer();
  const bubble = document.createElement('div');
  bubble.className = 'fc-bubble';

  const label = document.createElement('div');
  label.className = 'fc-name';
  const peer = peerId ? getPeerByJitsiId(peerId) : null;
  label.textContent = peer?.displayName || name;
  bubble.appendChild(label);

  const url = URL.createObjectURL(record.blob);
  bubble.appendChild(mediaElementFor(record.kind, url, name, record.mime));

  ensureChatEntry(container, localToken(), () => active);
  container.appendChild(bubble);
  bubbleCount++;
  while (bubbleCount > MAX_BUBBLES && container.firstChild) {
    // Revoke the outgoing bubble's object URL(s) before dropping it.
    for (const media of container.firstChild.querySelectorAll('img,video,audio,a')) {
      const src = media.src || media.href;
      if (src) URL.revokeObjectURL(src);
    }
    container.removeChild(container.firstChild);
    bubbleCount--;
  }

  const log = container.parentNode;
  if (log && log.scrollHeight - log.scrollTop - log.clientHeight < 80) {
    log.scrollTop = log.scrollHeight;
  }
}

// --- trigger -----------------------------------------------------------------

function handleTrigger(hap, currentTime, cps, targetTime) {
  if (!active) return;
  const value = hap?.value;
  if (!value) return;
  const param = Object.keys(FILE_KINDS).find((k) => value[k] != null);
  if (!param) return;

  const name = resolve(value[param]);
  if (!name) return;
  const peerId = peerOf(value[param]);

  const lead = Number(targetTime) - Number(currentTime);
  const delayMs = Number.isFinite(lead) ? Math.max(0, lead * 1000) : 0;
  setTimeout(async () => {
    if (!isPeerJPatternTurn(peerId)) return;
    let record = received.get(name);
    if (!record && peerId != null && peerId === getLocalPeer()?.jitsiId) {
      record = await loadAndBroadcastOwn(name);
    }
    // A remote peer's file that has not arrived yet: this occurrence draws
    // nothing, the same graceful skip text-cycles.js's paint() takes for an
    // unresolved token. A later occurrence (the pattern repeats, or the
    // broadcast lands moments later) succeeds once `received` has it.
    if (!record) return;
    renderBubble(name, record, peerId);
  }, delayMs);
}

// Called once from ensureStrudel after initStrudel. Registers image()/
// video()/textFile()/pdfFile()/soundFile() plus initFileCycles(), and
// returns the names to merge into evalScope.
export function installFileCycles(mod) {
  const { registerControl, register } = mod;
  const scope = {};
  for (const kind of Object.keys(FILE_KINDS)) {
    Object.assign(scope, registerControl(kind));
  }
  register('_fcRender', (pat) => pat.onTrigger(handleTrigger, true));

  scope.initFileCycles = async () => {
    const wasActive = active;
    active = true;
    if (!wasActive) ensureChatEntry(ensureContainer(), localToken(), () => active);
    return true;
  };
  return scope;
}

// Attachments already posted stay in the chat as history, exactly as Text
// Cycles' bubbles do — only new ones stop.
export function stopFileCycles() {
  active = false;
}

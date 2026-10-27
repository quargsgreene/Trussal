// custom-emoji.js
// Emoji people upload themselves. An image dropped on (or picked from) the
// on-screen keyboard's emoji "Mine" page is scaled down, stored in this
// browser's IndexedDB, and typed into code as a :shortcode:. Wherever Text
// Cycles paints that shortcode into the chat, every browser in the meeting
// draws the picture instead (fillWithEmoji).
//
// SHARING. The images ride on the uploader's sidecar record, exactly like a
// data pack (peer-state.js's sendLocalCustomEmoji / the sidecar's
// 'custom-emoji' case): one message per change, mirrored to the room, and in
// the roster for anyone who joins later. A shortcode resolves against the
// emoji of whoever wrote the word first, then anyone else's, so two people
// can both own a :cat: and each of their words shows their own.
//
// Pure rules (names, caps, shortcode parsing) live in custom-emoji-core.js.

import {
  EMOJI_MIMES, EMOJI_SIZE, MAX_EMOJI, MAX_EMOJI_BYTES,
  emojiNameFromFilename, sanitizeEmojiList, splitShortcodes, base64ByteLength,
} from './custom-emoji-core.js';
import { getAllPeers, getPeerByJitsiId, sendLocalCustomEmoji, subscribePeerState } from './peer-state.js';

const DB_NAME = 'trussal-custom-emoji';
const DB_VERSION = 1;
const DB_TABLE = 'emoji';

let own = [];                 // [{ name, mime, data }] — this browser's uploads
const listeners = new Set();  // notified when any emoji set changes
const urls = new Map();       // `${mime}|${data.length}|${name}` → blob URL

// --- storage -----------------------------------------------------------------

function openDB() {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => request.result.createObjectStore(DB_TABLE, { keyPath: 'name' });
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
  });
}

async function withStore(mode, fn) {
  const db = await openDB();
  if (!db) return null;
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_TABLE, mode);
    const result = fn(tx.objectStore(DB_TABLE));
    tx.oncomplete = () => resolve(result?.result ?? null);
    tx.onerror = () => reject(tx.error);
  });
}

function changed() {
  for (const fn of listeners) {
    try { fn(); } catch (e) { console.error('[custom-emoji] listener failed', e); }
  }
}

function publish() {
  sendLocalCustomEmoji(own);
  changed();
}

// Load this browser's uploads and put them on our sidecar record. Runs when
// this module loads (bottom of file), so a shortcode in someone's code draws
// for the room even if its owner never opens the keyboard this session.
let loaded = null;
export function initCustomEmoji() {
  if (!loaded) {
    loaded = withStore('readonly', (store) => store.getAll())
      .then((rows) => {
        own = sanitizeEmojiList((rows || []).sort((a, b) => (a.added ?? 0) - (b.added ?? 0)));
        if (own.length) publish();
      })
      .catch((e) => console.error('[custom-emoji] could not read uploads', e));
  }
  return loaded;
}

// Someone else's set arrived or changed: tell the keyboard. peer-upsert also
// fires for every metrics tick, so only a change in who owns which names counts.
let lastSignature = '';
subscribePeerState((event) => {
  if (event !== 'peer-upsert' && event !== 'peer-leave') return;
  const signature = getAllPeers()
    .map((p) => `${p.peerId}:${(p.customEmoji || []).map((e) => `${e.name}/${e.data.length}`).join(',')}`)
    .join(';');
  if (signature === lastSignature) return;
  lastSignature = signature;
  changed();
});

export function subscribeCustomEmoji(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function listOwnEmoji() {
  return own.slice();
}

// --- upload ------------------------------------------------------------------

function readAsBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('not a readable image')); };
    img.src = url;
  });
}

// Scale to EMOJI_SIZE on the longest side and re-encode as PNG. An image that
// is already small enough is kept byte-for-byte, which keeps an animated GIF
// or WebP animated.
async function fitImage(file) {
  if (EMOJI_MIMES.includes(file.type) && file.size <= MAX_EMOJI_BYTES) {
    const img = await loadImage(file);
    if (Math.max(img.naturalWidth, img.naturalHeight) <= EMOJI_SIZE * 2) {
      return { mime: file.type, data: await readAsBase64(file) };
    }
  }
  const img = await loadImage(file);
  const scale = EMOJI_SIZE / Math.max(img.naturalWidth, img.naturalHeight, 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.naturalWidth * Math.min(1, scale)));
  canvas.height = Math.max(1, Math.round(img.naturalHeight * Math.min(1, scale)));
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('could not re-encode the image');
  return { mime: 'image/png', data: await readAsBase64(blob) };
}

// Add an image file as a new emoji. Resolves to its name, or throws with a
// message fit to show the uploader.
export async function addEmojiFromFile(file) {
  await initCustomEmoji();
  if (!file || !/^image\//.test(file.type)) throw new Error('That is not an image.');
  if (own.length >= MAX_EMOJI) throw new Error(`You already have ${MAX_EMOJI} emoji — delete one first.`);
  const { mime, data } = await fitImage(file);
  if (base64ByteLength(data) > MAX_EMOJI_BYTES) throw new Error('That image is too detailed to share — try a simpler one.');
  const name = emojiNameFromFilename(file.name, new Set(own.map((e) => e.name)));
  const entry = { name, mime, data };
  await withStore('readwrite', (store) => store.put({ ...entry, added: Date.now() }));
  own = [...own, entry];
  publish();
  return name;
}

export async function removeEmoji(name) {
  await initCustomEmoji();
  await withStore('readwrite', (store) => store.delete(name));
  own = own.filter((e) => e.name !== name);
  publish();
}

// --- drawing -------------------------------------------------------------------

export function emojiUrl(entry) {
  const key = `${entry.mime}|${entry.data.length}|${entry.name}|${entry.data.slice(-16)}`;
  let url = urls.get(key);
  if (!url) {
    const bytes = Uint8Array.from(atob(entry.data), (c) => c.charCodeAt(0));
    url = URL.createObjectURL(new Blob([bytes], { type: entry.mime }));
    urls.set(key, url);
  }
  return url;
}

// The emoji `name` as `jitsiId` would mean it: theirs first, then ours, then
// anyone's in the room.
export function findEmoji(name, jitsiId = null) {
  // The local peer's record holds `own` too, once it is published.
  const author = jitsiId ? getPeerByJitsiId(jitsiId) : null;
  const sets = [author?.customEmoji, own, ...getAllPeers().map((p) => p.customEmoji)];
  for (const set of sets) {
    const hit = set?.find?.((e) => e.name === name);
    if (hit) return hit;
  }
  return null;
}

// Put `text` into `el`, drawing every :shortcode: that names an emoji as an
// image. Plain text when there is none — the common case costs one regex.
export function fillWithEmoji(el, text, jitsiId = null) {
  const parts = splitShortcodes(text, (name) => !!findEmoji(name, jitsiId));
  if (!parts.some((p) => p.emoji)) {
    el.textContent = text;
    return;
  }
  el.textContent = '';
  for (const part of parts) {
    if (part.text) { el.appendChild(document.createTextNode(part.text)); continue; }
    const img = document.createElement('img');
    img.className = 'tc-custom-emoji';
    img.src = emojiUrl(findEmoji(part.emoji, jitsiId));
    img.alt = `:${part.emoji}:`;
    img.title = `:${part.emoji}:`;
    el.appendChild(img);
  }
}

if (typeof window !== 'undefined') initCustomEmoji();

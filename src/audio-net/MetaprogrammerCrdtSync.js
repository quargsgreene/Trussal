// Shared metaprogram document: Yjs doc lifecycle + sidecar sync.
//
// One Y.Doc per meeting with a Y.Text named 'metaprogram'. Updates travel
// as base64 over the existing peer-state socket (`crdt-update` relay
// message); the sidecar keeps the update log for late joiners and enforces
// bot edit permissions. Every ~25 local updates we ship a full-state
// snapshot so the server log stays small.
//
// The doc/diff helpers are pure (two in-memory docs converge under
// node:test); only connectMetaprogramSync touches the peer-state bus.

import * as Y from 'yjs';

export const TEXT_KEY = 'metaprogram';
const SNAPSHOT_EVERY = 25;

export function createMetaprogramDoc() {
  const doc = new Y.Doc();
  return { doc, text: doc.getText(TEXT_KEY) };
}

export function encodeUpdateB64(update) {
  let s = '';
  for (const b of update) s += String.fromCharCode(b);
  return btoa(s);
}

export function decodeUpdateB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export function encodeFullState(doc) {
  return encodeUpdateB64(Y.encodeStateAsUpdate(doc));
}

export function applyRemoteUpdate(doc, b64, origin = 'remote') {
  Y.applyUpdate(doc, decodeUpdateB64(b64), origin);
}

// Minimal common-prefix/suffix diff: turn "textarea now shows B, doc holds A"
// into a single delete+insert on the Y.Text. Good enough for a code editor
// (per-keystroke edits are tiny); CRDT merge semantics come from Yjs itself.
export function applyTextDiff(ytext, nextValue, origin = 'local') {
  const prev = ytext.toString();
  if (prev === nextValue) return false;
  let start = 0;
  const maxStart = Math.min(prev.length, nextValue.length);
  while (start < maxStart && prev[start] === nextValue[start]) start++;
  let endPrev = prev.length;
  let endNext = nextValue.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === nextValue[endNext - 1]) {
    endPrev--; endNext--;
  }
  const doc = ytext.doc;
  doc.transact(() => {
    if (endPrev > start) ytext.delete(start, endPrev - start);
    if (endNext > start) ytext.insert(start, nextValue.slice(start, endNext));
  }, origin);
  return true;
}

// Replace the whole doc text (roster auto-edits, programmatic writes).
export function setDocText(ytext, value, origin = 'local') {
  return applyTextDiff(ytext, value, origin);
}

// --- Browser provider ---------------------------------------------------------

// Binds a doc to the sidecar relay via the peer-state bus. `bus` is injected
// ({ subscribe, sendUpdate }) so tests can run two providers over a fake bus.
export function connectMetaprogramSync({ doc, text }, bus, { modality = 'keyboard' } = {}) {
  let localUpdates = 0;
  const listeners = new Set();
  let lastAuthorIndex = null;

  const onDocUpdate = (update, origin) => {
    if (origin === 'remote') return; // don't echo remote updates back
    localUpdates++;
    if (localUpdates % SNAPSHOT_EVERY === 0) {
      bus.sendUpdate(encodeFullState(doc), { snapshot: true, modality });
    } else {
      bus.sendUpdate(encodeUpdateB64(update), { snapshot: false, modality });
    }
  };
  doc.on('update', onDocUpdate);

  const unsubscribe = bus.subscribe((event, payload) => {
    if (event === 'crdt-update' && payload && payload.update) {
      lastAuthorIndex = payload.authorIndex ?? lastAuthorIndex;
      applyRemoteUpdate(doc, payload.update);
      listeners.forEach(fn => { try { fn(text.toString(), payload); } catch (e) {} });
    } else if (event === 'crdt-state' && payload && Array.isArray(payload.updates)) {
      for (const u of payload.updates) applyRemoteUpdate(doc, u);
      listeners.forEach(fn => { try { fn(text.toString(), { catchUp: true }); } catch (e) {} });
    }
  });

  return {
    doc,
    text,
    getText: () => text.toString(),
    setText: (value, origin = 'local') => setDocText(text, value, origin),
    onRemoteChange: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    getLastAuthorIndex: () => lastAuthorIndex,
    disconnect() {
      doc.off('update', onDocUpdate);
      unsubscribe();
    }
  };
}

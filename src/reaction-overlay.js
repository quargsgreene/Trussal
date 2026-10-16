// reaction-overlay.js — Trussal's own reaction overlay.
//
// The Jitsi web app's own native reactions (dispatched into its Redux store)
// are gone with the app shell. This module replaces them with a Trussal-native
// overlay: reactions ride the existing WS sidecar bus (peer-state.js's
// sendReaction / the 'reaction' relay), so every browser in the room renders
// them at roughly the same time. The authoring peer renders locally and
// broadcasts; everybody else renders when the relay arrives.
//
// Silent-by-construction semantics are preserved — each peer's own
// reaction() voice is the only one that ever fires from that peer's browser —
// but propagation is our own bus, not Jitsi's conference relay.

import { subscribePeerState, getAllPeers } from './peer-state.js';
import { reactionEmojiById } from './reactions-core.js';
import overlayStyles from './reaction-overlay.css';

const OVERLAY_ID = 'trussal-reaction-overlay';
const STYLE_ID = 'trussal-reaction-overlay-style';
const MAX_REACTIONS_ON_SCREEN = 12;
const REACTION_LIFESPAN_MS = 2600;
const POS_CLASSES = ['tr-reaction-p0', 'tr-reaction-p1', 'tr-reaction-p2', 'tr-reaction-p3', 'tr-reaction-p4', 'tr-reaction-p5'];

let overlayEl = null;
let activeCount = 0;

function ensureStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = overlayStyles;
  (doc.head || doc.body).appendChild(style);
}

function ensureOverlay() {
  if (overlayEl && typeof document !== 'undefined' && document.contains(overlayEl)) return overlayEl;
  if (typeof document === 'undefined' || !document.body) return null;
  ensureStyle(document);
  overlayEl = document.getElementById(OVERLAY_ID);
  if (!overlayEl) {
    overlayEl = document.createElement('div');
    overlayEl.id = OVERLAY_ID;
    document.body.appendChild(overlayEl);
  }
  return overlayEl;
}

function positionClass(fromIndex) {
  let n = 0;
  if (fromIndex != null) {
    const v = typeof fromIndex === 'number' ? fromIndex : Number(fromIndex);
    if (Number.isFinite(v) && v >= 0) n = v;
  }
  const idx = n % POS_CLASSES.length;
  return POS_CLASSES[idx];
}

// Show a reaction emoji for the given reaction id. If fromIndex is given, a
// position class is derived from it so peers' reactions don't always land in
// the same horizontal slot.
export function showReaction(id, fromIndex) {
  const emoji = reactionEmojiById(id);
  if (!emoji) return false;
  const overlay = ensureOverlay();
  if (!overlay) return false;
  const el = document.createElement('div');
  el.className = 'tr-reaction ' + positionClass(fromIndex);
  el.textContent = emoji;
  overlay.appendChild(el);
  activeCount = Math.min(activeCount + 1, MAX_REACTIONS_ON_SCREEN + 4);
  setTimeout(() => {
    if (el.parentNode) el.parentNode.removeChild(el);
    activeCount = Math.max(0, activeCount - 1);
  }, REACTION_LIFESPAN_MS);
  return true;
}

function nameForIndex(fromIndex) {
  if (fromIndex == null) return null;
  try {
    const peer = getAllPeers().find((p) => p && String(p.roomIndex) === String(fromIndex));
    return peer && typeof peer.displayName === 'string' ? peer.displayName.trim() || null : null;
  } catch (e) { return null; }
}

subscribePeerState((event, payload) => {
  if (event !== 'reaction') return;
  const rid = payload && payload.reaction;
  if (typeof rid !== 'string') return;
  showReaction(rid, payload.fromIndex);
});

// Build as soon as the module loads.
if (typeof document !== 'undefined') {
  if (document.body) ensureOverlay();
  else document.addEventListener('DOMContentLoaded', () => ensureOverlay());
}

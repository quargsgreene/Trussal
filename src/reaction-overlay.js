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
import { reactionEmojiById, reactionSoundFileById } from './reactions-core.js';
import overlayStyles from './reaction-overlay.css';

const OVERLAY_ID = 'trussal-reaction-overlay';
const STYLE_ID = 'trussal-reaction-overlay-style';
const MAX_REACTIONS_ON_SCREEN = 12;
const REACTION_LIFESPAN_MS = 2600;
const POS_CLASSES = ['tr-reaction-p0', 'tr-reaction-p1', 'tr-reaction-p2', 'tr-reaction-p3', 'tr-reaction-p4', 'tr-reaction-p5'];

// The reaction sounds live in the deployment's sounds/ dir (Jitsi's own bundled
// files — see reactions-core.js). Resolve them relative to the document so a
// subdirectory deploy works, exactly as Strudel resolves trussal-impulse.wav.
const SOUND_DIR = 'sounds/';

// One tiny pool of <audio> elements per reaction id, reused across plays so a
// fast pattern doesn't allocate unboundedly and a rapid retrigger can overlap a
// little (Jitsi stacks up to three of each). Elements are created lazily on the
// first play, which is always inside (or after) a user gesture.
const soundPools = new Map();
const SOUND_POOL_SIZE = 3;

function playReactionSound(id) {
  const file = reactionSoundFileById(id);
  if (!file) return;
  if (typeof Audio === 'undefined' || typeof document === 'undefined') return;
  try {
    let pool = soundPools.get(id);
    if (!pool) {
      let src = SOUND_DIR + file;
      try { src = new URL(src, document.baseURI).href; } catch (e) { /* keep the relative path */ }
      pool = [];
      for (let i = 0; i < SOUND_POOL_SIZE; i++) {
        const el = new Audio(src);
        el.preload = 'auto';
        pool.push(el);
      }
      soundPools.set(id, pool);
    }
    const el = pool.find((a) => a.paused || a.ended) || pool[0];
    try { el.currentTime = 0; } catch (e) { /* not seekable yet — play from the top */ }
    const played = el.play();
    if (played && typeof played.catch === 'function') played.catch(() => { /* autoplay policy — best effort */ });
  } catch (e) { /* audio is best-effort; never block the overlay */ }
}

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
  // The reaction had a sound in the Jitsi web app; play it here too — for the
  // authoring peer (fireReaction calls this directly) and for every peer that
  // renders a relayed reaction. Each browser hears one sound per reaction.
  playReactionSound(id);
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

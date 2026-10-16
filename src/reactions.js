// Reaction patterns — Strudel patterns that fire Trussal-native meeting
// reactions (👍 😲 🤫 😂 👎 ❤️ 👏) instead of making sound.
//
//   $: reaction("<su la*3 b? [c, h] si>/3").fast(4).unreact(10)
//
// LOCAL ONLY BY CONSTRUCTION. A reaction can only ever be sent from the
// reacting participant's own browser: every browser evaluates every peer's
// program (see strudel.js), so buildPeerBlock strips reaction() out of anyone
// else's contribution before it reaches this renderer (silent-voice-core.js's
// stripCalls) — only the authoring peer's own browser ever calls handleTrigger
// for their own reaction() voice. Once sent, the Trussal WS sidecar bus relays
// it to everyone else (the job Jitsi's own conference relay used to do), and
// every client renders the same overlay.
//
// SILENT BY CONSTRUCTION. The renderer is attached with onTrigger(fn, dominant
// = true) — see text-cycles.js's doc comment for why that keeps a reaction
// voice out of superdough even if it names a sound too. No atom minting is
// needed: every reaction() atom is one of reactions-core.js's abbreviations,
// already a grammar-legal mini-notation atom.

import { getLocalPeer, isPeerJPatternTurn, sendReaction } from './peer-state.js';
import { resolveReaction, resolveUnreactMs } from './reactions-core.js';
import { showReaction } from './reaction-overlay.js';

// Fire a reaction: show the overlay locally and relay it to the room via the
// WS sidecar bus so everyone else renders it too.
function fireReaction(id) {
  const idx = getLocalPeer()?.roomIndex;
  showReaction(id, idx);
  sendReaction(id);
  return true;
}

// Per-reaction-id cooldown, local to this browser: Jitsi's reactions are a
// fire-and-forget animation with no "on" state of their own to hold, so
// unreact(ms) is read as the minimum spacing between repeats of the SAME
// reaction — a fast()-patterned voice retriggering "su" every 250ms with the
// default 4s unreact fires once and then waits, rather than flooding the room.
const lastFiredAt = new Map();

function handleTrigger(hap, currentTime, cps, targetTime) {
  const value = hap?.value;
  if (!value || value.reaction == null) return;
  const reaction = resolveReaction(value.reaction);
  if (!reaction) {
    console.warn(`[reactions] unknown reaction "${value.reaction}" — expected one of tu/su/si/la/b/h/c`);
    return;
  }
  const unreactMs = resolveUnreactMs(value.unreact);

  const lead = Number(targetTime) - Number(currentTime);
  const delayMs = Number.isFinite(lead) ? Math.max(0, lead * 1000) : 0;
  setTimeout(() => {
    // Turn-gated like every other silent-by-construction renderer, so a
    // reaction voice obeys the same rotation as Text/CSS Cycles once a
    // metaprogram is scheduling the room (isPeerJPatternTurn fails open —
    // true — when no rotation is active, so this is a no-op otherwise).
    if (!isPeerJPatternTurn(getLocalPeer()?.jitsiId)) return;
    const now = Date.now();
    if (now - (lastFiredAt.get(reaction.id) || 0) < unreactMs) return;
    lastFiredAt.set(reaction.id, now);
    fireReaction(reaction.id);
  }, delayMs);
}

// Called once from ensureStrudel after initStrudel. Registers reaction()/
// unreact() and the renderer, and returns the names to merge into evalScope.
export function installReactions(mod) {
  const { registerControl, register } = mod;
  const scope = {
    ...registerControl('reaction'),
    ...registerControl('unreact'),
  };
  register('_rxRender', (pat) => pat.onTrigger(handleTrigger, true));
  return scope;
}

export function stopReactions() {
  lastFiredAt.clear();
}

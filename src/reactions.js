// Reaction patterns — Strudel patterns that fire Jitsi's own native meeting
// reactions (👍 😲 🤫 😂 👎 ❤️ 👏) instead of making sound.
//
//   $: reaction("<su la*3 b? [c, h] si>/3").fast(4).unreact(10)
//
// LOCAL ONLY BY CONSTRUCTION. A reaction can only ever be sent from the
// reacting participant's own Jitsi connection — there is no such thing as
// making a REMOTE participant's client emit a reaction on their behalf. Every
// browser evaluates every peer's program (see strudel.js), so buildPeerBlock
// strips reaction() out of anyone else's contribution before it ever reaches
// this renderer (silent-voice-core.js's stripCalls) — only the authoring
// peer's own browser ever calls handleTrigger for their own reaction() voice.
// Once sent, Jitsi's own conference relay is what makes it visible to
// everyone else, exactly as it already does for a manually-clicked reaction.
//
// SILENT BY CONSTRUCTION. The renderer is attached with onTrigger(fn, dominant
// = true) — see text-cycles.js's doc comment for why that keeps a reaction
// voice out of superdough even if it names a sound too. No atom minting is
// needed (unlike word()): every reaction() atom is one of reactions-core.js's
// abbreviations, already a grammar-legal mini-notation atom.

import { getLocalPeer, isPeerJPatternTurn } from './peer-state.js';
import { resolveReaction, resolveUnreactMs } from './reactions-core.js';

// Best-effort dispatch into Jitsi's own reactions feature, exactly the way
// text-cycles.js's openChatPanel()/setNickname() reach into APP.store: if the
// internal Redux shape this targets ever drifts, this simply does nothing
// rather than throwing and taking the room's whole program down with it.
function sendJitsiReaction(id) {
  try {
    const store = typeof window !== 'undefined' ? window.APP?.store : null;
    if (!store || typeof store.dispatch !== 'function') return false;
    store.dispatch({ type: 'ADD_REACTION_BUFFER', reaction: id });
    return true;
  } catch (e) {
    console.warn('[reactions] could not dispatch to Jitsi', e);
    return false;
  }
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
    sendJitsiReaction(reaction.id);
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

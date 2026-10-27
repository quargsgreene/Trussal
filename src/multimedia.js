// multimedia.js — the browser half of multiArrange() and multiStack().
//
//   $: multiArrange(
//        [4, s("bd*4"), osc(10).kaleid()],
//        [2, word("<hello there>"), noise(3)],
//      )
//
// The pattern logic lives in multimedia-core.js. This supplies what only a
// page knows: the scheduler's cycle, whose turn it is, which media a peer's
// arrangement may reach on this page, and how a Hydra section is drawn.

import { getLocalPeer, getPeerByJitsiId, isPeerJPatternTurn, getActiveJPatternKind } from './peer-state.js';
import { getAggregatorPeer } from './latency-instrument.js';
import { getMode as getHydraVideoMode, MODE_DIRECT } from './hydra-video.js';
import { createMultimedia, LOCAL_ONLY_MEDIA, PER_PAGE_MEDIA } from './multimedia-core.js';

function localId() {
  return getLocalPeer()?.jitsiId ?? null;
}

// The turn clock's question. Stricter than isPeerJPatternTurn on one point: a
// written `~` rest is a turn nobody holds, so every arrangement waits through
// it rather than all of them advancing at once. With no turn signal at all it
// fails open like everything else, and multiArrange() reads the room clock.
function isOnTurn(peer) {
  if (getActiveJPatternKind() === 'rest') return false;
  return isPeerJPatternTurn(peer || localId());
}

// What a peer's arrangement may reach on THIS page. Mirrors buildPeerBlock's
// rules for whole statements, per hap:
//   - your own arrangement plays everything;
//   - a bot's, or anyone else's while an aggregator is present, keeps only the
//     media painted per-page — their audio and visuals reach this page as
//     their own tracks (or the aggregator's master), and a copy here would be
//     heard twice and, worse, published in your track;
//   - anyone else's, with no aggregator, plays everything but the local-only
//     media, which only their own browser may fire.
function allows(peer, medium) {
  if (!peer || peer === localId()) return true;
  if (getPeerByJitsiId(peer)?.isBot || getAggregatorPeer()) return PER_PAGE_MEDIA.includes(medium);
  return !LOCAL_ONLY_MEDIA.includes(medium);
}

// The source each Hydra output last showed for a section, so a section held
// for several cycles compiles its shader once rather than once per cycle.
const shown = new WeakMap();

// Draw a Hydra section on the beat (Strudel triggers a lookahead early, the
// same lead css-cycles.js waits out) and only on its performer's turn, the
// same gate every other silent renderer obeys. A section that ends leaves its
// visuals running until the next one replaces them, as `.out()` always does.
//
// In `direct` mode a performer's Hydra lands in o1 and is blended with the
// camera into o0 (see rebuildAndEvaluate), so a section goes there too unless
// the arrangement names its own output.
function renderHydra({ source, output, peer, currentTime, targetTime }) {
  const lead = Number(targetTime) - Number(currentTime);
  const delayMs = Number.isFinite(lead) ? Math.max(0, lead * 1000) : 0;
  setTimeout(() => {
    if (!isPeerJPatternTurn(peer || localId())) return;
    const target = output || (getHydraVideoMode() === MODE_DIRECT ? globalThis.o1 : globalThis.o0);
    if (!target || shown.get(target) === source) return;
    shown.set(target, source);
    try {
      source.out(target);
    } catch (e) {
      console.error('[multimedia] a Hydra section failed to render', e);
    }
  }, delayMs);
}

// Called once from ensureStrudel after initStrudel. Returns the names to merge
// into evalScope: the two functions as performers write them, owned by the
// local peer, and the `_mm*` forms buildPeerBlock rewrites every peer's calls
// into so each arrangement keeps its own author's turns (injectMultiPeer).
export function installMultimedia(mod) {
  const mm = createMultimedia(mod, {
    now: () => mod.getTime(),
    isOnTurn,
    allows,
    renderHydra,
  });
  return {
    multiArrange: (...args) => mm.multiArrange(localId(), ...args),
    multiStack: (...args) => mm.multiStack(localId(), ...args),
    _mmArrange: mm.multiArrange,
    _mmStack: mm.multiStack,
  };
}

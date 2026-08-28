// ARCHIVED 2026-08-28 — moved out of src/audio-net/EffectMedia.js as dead code.
//
// No callers. Consumers gate per-entry with `entryAffects` (still exported)
// rather than pre-filtering the whole chain.

import { entryAffects } from '../../../src/audio-net/EffectMedia.js';

// The subset of a chain that acts on one medium — what each consumer wants
// before it builds anything, since an effect the medium excludes should not
// cost a node, a canvas filter, or a mutated span.
export function chainForMedium(chainEntries, medium, cyclePos = 0) {
  return (chainEntries || []).filter(entry => entryAffects(entry, medium, cyclePos));
}

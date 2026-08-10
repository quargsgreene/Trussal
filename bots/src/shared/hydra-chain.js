/**
 * Splicing a chain suffix into Hydra code that already ends its own pipeline
 * with `.out(o0)` (or bare `.out()`, which defaults to o0).
 *
 * A second top-level `.out(o0)` statement does not composite with the first —
 * Hydra's `.out()` REBINDS the named buffer to whatever pipeline precedes it,
 * discarding the one that was there before. Appending
 * `src(o0).hue(x).out(o0)` after a master's own `osc(...).out(o0)` therefore
 * doesn't tint the master's image: it replaces the whole pipeline with a
 * feedback read of a buffer that pipeline never renders into, so the visual
 * is either black or a broken feedback loop and the effect is invisible. The
 * fix is to chain the effect onto the SAME pipeline, before its one `.out(o0)`
 * — no `src()` needed.
 */

// Only o0: the buffer every per-bot postlude (band hue, tile crop, colour
// scheme) targets, matching the one canvas that gets published as this bot's
// video. `.out(o1)`/`.out(o2)`/`.out(o3)` are separate layers a postlude has
// no business touching.
const HYDRA_O0_OUT_RE = /\.out\s*\(\s*(?:o0\s*)?\)/g;

/**
 * Insert `suffix` (a chain fragment like `.hue(0.3)`, starting with `.`)
 * immediately before the LAST `.out(o0)`/`.out()` call in `code` — the one
 * that actually renders, since any earlier ones are dead pipeline
 * reassignments. A no-op when `suffix` is empty or `code` has no o0 output to
 * attach to.
 */
export function insertBeforeHydraOut(code, suffix) {
  const src = String(code ?? '');
  if (!suffix || !src.trim()) return src;
  let last = null;
  for (const m of src.matchAll(HYDRA_O0_OUT_RE)) last = m;
  if (!last) return src;
  return src.slice(0, last.index) + suffix + src.slice(last.index);
}

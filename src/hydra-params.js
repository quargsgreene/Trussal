// hydra-params.js — `H(...)` for the aggregator's mosaic.
//
// A performer can bind a Hydra parameter to a Strudel pattern:
//
//     await initHydra()
//     osc(H("<10 40>"), 0.1, H(saw.range(0, 2))).out()
//
// On their own page that works because Strudel is running: `H` reifies the
// pattern and Hydra calls the returned function every frame, sampling it at
// the scheduler's current cycle position. The aggregator re-executes that same
// preamble to fill their mosaic cell, but it does NOT run their Strudel — it
// already has their AUDIO on the master bus, and running a second copy would
// be a whole scheduler and audio graph to produce numbers.
//
// So this lends the mosaic the half of Strudel that H actually needs: the
// pattern machinery (reify + mini notation + the signal library), sampled
// against the room's own cycle grid rather than a local audio clock. No
// AudioContext is created — @strudel/web builds one lazily inside
// getAudioContext(), which nothing here calls — and nothing is scheduled.
//
// Sampling against the shared grid is the deliberate choice: the aggregator's
// cycle position is the clock the whole room is already synchronised to, so a
// pattern-bound parameter advances in step with the turn-taking the audience
// is hearing, rather than drifting on a free-running clock of its own.

// Installed synchronously so the page script has something to await; the
// Strudel import fills it in.
let api = null;

export function installHydraParamApi() {
  if (api) return api;

  let strudel = null;
  const whenReady = import('@strudel/web')
    .then((mod) => {
      // reify() only mini-parses strings once a parser is registered, and
      // initStrudel is what normally does that — the aggregator never calls
      // it, so `H("<10 40>")` would otherwise reify to the literal STRING
      // "<10 40>" and the parameter would sit on a constant.
      if (typeof mod.miniAllStrings === 'function') mod.miniAllStrings();
      strudel = mod;
      return true;
    })
    .catch((e) => {
      console.error('[hydra-params] Strudel pattern machinery failed to load —'
        + ' H() parameters will hold at their fallback', e);
      return false;
    });

  api = {
    whenReady,

    // The module namespace, so a preamble's `H(saw.range(0,2))` can resolve
    // `saw` at all. Read lazily: the import may still be in flight.
    patternScope: () => strudel,

    /**
     * Build the `H` a single cell's preamble runs against. `getCyclePos`
     * returns the room's current position in fractional cycles.
     *
     * Mirrors @strudel/hydra's H, with one deliberate difference: the pattern
     * is reified ONCE here rather than on every frame inside the returned
     * function. reify is deterministic, so the sampled values are identical —
     * it just stops the mosaic re-parsing mini notation 15 times a second per
     * parameter.
     */
    makeH(getCyclePos) {
      return function H(spec) {
        let pattern = null;
        let last = typeof spec === 'number' ? spec : 0;
        try {
          pattern = strudel ? strudel.reify(spec) : null;
        } catch (e) {
          console.error('[hydra-params] could not reify a H() argument', e);
        }
        return () => {
          if (!pattern) return last;
          try {
            const value = sampleAt(pattern, getCyclePos());
            if (value !== undefined) last = value;
          } catch (e) {
            // Per-frame: log once-ish rather than every frame, and hold the
            // last good value so one bad query doesn't strobe the cell.
            if (!H.warned) { H.warned = true; console.error('[hydra-params] H() query failed', e); }
          }
          return last;
        };
      };
    },
  };
  window.__trussalHydraParams = api;
  return api;
}

// A pattern's value at a point on the cycle grid. Strudel's own H queries a
// ZERO-WIDTH arc, which is what returns the event whose span contains that
// instant; a few pattern shapes yield nothing there, so fall back to a hair's
// width before giving up (the caller then holds the previous value).
export function sampleAt(pattern, cyclePos) {
  const at = Number.isFinite(cyclePos) ? cyclePos : 0;
  const first = pattern.queryArc(at, at);
  if (first && first.length) return first[0].value;
  const nudged = pattern.queryArc(at, at + 1e-6);
  if (nudged && nudged.length) return nudged[0].value;
  return undefined;
}

// Test seam.
export function resetHydraParamApi() {
  api = null;
  if (typeof window !== 'undefined') delete window.__trussalHydraParams;
}

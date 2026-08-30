// The video counterpart of the `#` effect chain: what the aggregator's
// compositor does to the frame it publishes.
//
// One application point, for the same reason the audio effects have one — the
// aggregator's master bus is the single mix the room hears, and its composited
// canvas is the single image the room sees. Applying these per browser would
// give every viewer a different picture of the same performance, and applying
// them per CELL would process a blitted camera cell twice (once in the
// performer's own published track, once here).
//
// Deliberately NOT published to `window._jpVisual`. That object has carried
// lowpass/pixelate/noise channels that nothing has ever rendered; adding more
// state that no consumer reads is how an effect ends up "implemented" and
// invisible. Everything below is consumed by pageMosaic's frame loop.
//
// Each effect keeps the parameters it already computes for audio — this module
// only maps them onto the frame, so a directive's sound and its image move
// together by construction rather than by two formulas kept in step by hand.
//
// Pure module: no DOM, no WebAudio, so it runs in the bundle, in bots, and
// under node:test.

import { roomParams } from './Room.js';
import { echoParams } from './Echo.js';
import { crushParams } from './Crush.js';
import { noiseParams } from './Noise.js';
import { resolveEffectParams } from '../MetaprogrammerParser.js';
import { entryAffects } from '../EffectMedia.js';

// Ceilings. Every one of these is the point past which more of the effect
// stops reading as the effect and starts reading as a broken stream, which is
// the same reason the audio side clamps feedback and bit depth.
export const MAX_BLUR_PX = 24;      // beyond this the image is fog
export const MAX_PIXEL_BLOCK = 32;  // beyond this a 360p cell is a few squares
export const MAX_GRAIN = 0.6;       // matches Noise.js's own visual ceiling
export const MAX_CROSSFADE_S = 2;   // a fade longer than a short turn never lands

// Decay at which the blurred layer reaches half strength. room's wet/dry mix
// is its "how much reverb", so the blur gets the same treatment: a saturating
// curve rather than a linear one, because decay is unbounded above and a
// linear map would be all-or-nothing for any real metric.
export const BLUR_WET_HALF_S = 1;

// The neutral frame: nothing to do. Also what an empty chain resolves to, so
// the compositor can apply this unconditionally instead of branching.
export function neutralVideoState() {
  return { blurPx: 0, blurWet: 0, pixelBlock: 1, grain: 0, crossfadeS: 0, crossfadeGain: 0 };
}

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(value) ? value : lo));

// The frame parameters in force for this chain, at these metrics, at this
// point on the cycle grid.
//
// `cycle` is { cycleSeconds, cyclePos } exactly as the audio path takes it:
// echo needs the cycle LENGTH because its delay is written in cycles, and
// every patterned argument — the medium set included — is sampled at cyclePos.
//
// Where several directives of the same kind are chained, the strongest wins
// rather than the last: these compose on one image, and a later `# room` that
// happens to be gentler should not undo an earlier fierce one.
export function videoStateFor(chainEntries, metrics, cycle = {}) {
  const cyclePos = cycle.cyclePos || 0;
  const state = neutralVideoState();

  for (const entry of (chainEntries || [])) {
    // The medium set is what makes `# room wcl 2 ["audio"]` leave the image
    // alone, and it patterns, so it is asked per call rather than per program.
    if (!entryAffects(entry, 'video', cyclePos)) continue;
    const user = resolveEffectParams(entry, { cycle: cyclePos });

    switch (entry.fn) {
      case 'room': {
        // The reverb darkens the image as it darkens the sound: the same
        // cutoff that drives the lowpass sets the blur RADIUS (visualLowpass
        // is 1 at open, 0 fully lowpassed), and the decay — room's "how much
        // tail" — sets how much of the blurred layer is mixed over the dry
        // one, which is the wet/dry balance the audio node already has.
        const params = roomParams(metrics, user, cyclePos);
        state.blurPx = Math.max(state.blurPx, MAX_BLUR_PX * (1 - clamp(params.visualLowpass, 0, 1)));
        state.blurWet = Math.max(
          state.blurWet,
          params.decayS > 0 ? params.decayS / (params.decayS + BLUR_WET_HALF_S) : 0
        );
        break;
      }
      case 'crush': {
        // Sample-rate decimation, applied to pixels instead of samples —
        // which is what visualPixelate has always meant. The blockiness IS
        // the visible compression: the frame is drawn small and scaled back
        // up with smoothing off, exactly as a crushed signal is held between
        // sample points.
        const params = crushParams(metrics, user, cyclePos);
        state.pixelBlock = Math.max(state.pixelBlock, clamp(Math.round(params.visualPixelate), 1, MAX_PIXEL_BLOCK));
        break;
      }
      case 'noise': {
        // The bed, as grain: colour sets its character and level scales it,
        // so a quiet brown bed barely marks the image and a loud white one
        // buries it (Noise.js owns that curve).
        const params = noiseParams(metrics, user);
        state.grain = Math.max(state.grain, clamp(params.visualNoise, 0, MAX_GRAIN));
        break;
      }
      case 'echo': {
        // The repeats, as a crossfade between turns: the delay time is how
        // long the outgoing performer lingers over the incoming one, and the
        // wet gain is how visible that lingering is. A chain whose delay
        // rounds to nothing gets no fade, matching the muted wet path.
        const params = echoParams(metrics, user, cycle);
        state.crossfadeS = Math.max(state.crossfadeS, clamp(params.delayS, 0, MAX_CROSSFADE_S));
        state.crossfadeGain = Math.max(state.crossfadeGain, clamp(params.wetGain, 0, 1));
        break;
      }
      default: break; // grid/mosaic are not frame effects; pattern fns are scheduling
    }
  }
  return state;
}

// Whether a state would change any pixel. The compositor uses this to skip its
// offscreen work entirely on a program with no video effects, which is the
// common case and must cost nothing.
export function videoStateIsNeutral(state) {
  if (!state) return true;
  return !(state.blurPx > 0 && state.blurWet > 0)
    && !(state.pixelBlock > 1)
    && !(state.grain > 0)
    && !(state.crossfadeS > 0 && state.crossfadeGain > 0);
}

// The text and CSS counterparts of the `#` effect chain: what the room's
// effects do to the words Text Cycles paints, and to the styling they carry.
//
// Two media, one module, because they are two halves of the same span — `text`
// is the glyph stream (characters added, dropped, repeated) and `css` is the
// styling those glyphs are painted with. A directive can name either, both, or
// neither.
//
// Unlike audio and video, this one has NO single application point: every
// browser paints its own chat panel from the shared program. That is what
// makes seeding non-negotiable. Text Cycles' guarantee is that every client
// paints the same words at the same time, so a mutation drawn from
// Math.random() would silently give each viewer different text — the same
// failure the scheduler's `?` avoids by drawing from SeededRandom. The seed
// must also come from the NET CYCLES grid rather than the Strudel hap's cycle
// number: each browser starts its own Strudel scheduler at its own moment, so
// hap cycle numbers are not a shared coordinate and would reintroduce exactly
// the divergence the seeding is there to prevent.
//
// Pure module: no DOM, no WebAudio, so it runs in the bundle, in bots, and
// under node:test.

import { roomParams } from './Room.js';
import { echoParams } from './Echo.js';
import { crushParams } from './Crush.js';
import { noiseParams } from './Noise.js';
import { resolveEffectParams } from '../MetaprogrammerParser.js';
import { entryAffects } from '../EffectMedia.js';
import { seededRandom, hashSeed } from '../SeededRandom.js';

// Ceilings, each at the point where more of the effect stops being the effect
// and starts being an unreadable line.
export const MAX_SPACING_PX = 14;   // past this a word is a scatter of letters
export const MAX_DROP = 0.6;        // dropping more than this leaves no word
export const MAX_NOISE_CHARS = 4;   // injected glyphs per word
export const MAX_REPEATS = 3;       // echoes of the last word
export const MAX_TEXT_BLUR_PX = 3;  // past this the text cannot be read at all
export const MAX_JITTER = 0.5;      // fractional perturbation of a styled value

// Decay at which room's text growth reaches half its ceiling — the same
// saturating shape the video blur's wet mix uses, and for the same reason:
// decay is unbounded above.
export const SPACING_HALF_S = 1;

// The glyphs noise injects. Brown noise is low-frequency, so it lands on quiet
// marks; white noise is dense and lands on loud ones. The tilt picks the band,
// which is how a bed's COLOUR reaches the text rather than only its level.
export const NOISE_GLYPHS = [
  ' .,\'`-_',                    // brown — barely marks the word
  '~^*+=:;<>/\\|',               // pink/white middle
  '#@%&$!?0123456789ABCXYZ'      // white — dense and loud
];

export function neutralTextState() {
  return { spacingPx: 0, dropChance: 0, noiseChars: 0, noiseBand: 0, repeats: 0, repeatAlpha: 0 };
}

export function neutralCssState() {
  return { blurPx: 0, quantizeStep: 0, colorLevels: 0, jitter: 0, fadeFromPrevious: 0 };
}

const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(value) ? value : lo));

// Both states in one pass, since every directive is asked about both media and
// resolving the chain twice would double the pattern sampling for nothing.
export function textAndCssStateFor(chainEntries, metrics, cycle = {}) {
  const cyclePos = cycle.cyclePos || 0;
  const text = neutralTextState();
  const css = neutralCssState();

  for (const entry of (chainEntries || [])) {
    const onText = entryAffects(entry, 'text', cyclePos);
    const onCss = entryAffects(entry, 'css', cyclePos);
    if (!onText && !onCss) continue;
    const user = resolveEffectParams(entry, { cycle: cyclePos });

    switch (entry.fn) {
      case 'room': {
        const params = roomParams(metrics, user, cyclePos);
        // The tail pushes the letters apart, as it smears the sound.
        if (onText) {
          const growth = params.decayS > 0 ? params.decayS / (params.decayS + SPACING_HALF_S) : 0;
          text.spacingPx = Math.max(text.spacingPx, MAX_SPACING_PX * growth);
        }
        // The same cutoff that darkens the audio softens the glyphs.
        if (onCss) {
          css.blurPx = Math.max(css.blurPx, MAX_TEXT_BLUR_PX * (1 - clamp(params.visualLowpass, 0, 1)));
        }
        break;
      }
      case 'crush': {
        const params = crushParams(metrics, user, cyclePos);
        // Decimation, applied to letters: the harder the crush, the more of
        // the word is simply not there — the visual of a quantized signal
        // losing detail between its steps.
        if (onText) {
          const reduction = Math.max(1, params.reduction || 1);
          text.dropChance = Math.max(text.dropChance, clamp(1 - 1 / reduction, 0, MAX_DROP));
        }
        // Quantization, applied to the styling itself: sizes and spacings snap
        // to a coarse step and colours to a few levels, which is bit depth
        // expressed in CSS rather than in samples.
        if (onCss) {
          css.quantizeStep = Math.max(css.quantizeStep, clamp(Math.round(params.reduction), 0, 64));
          css.colorLevels = Math.max(css.colorLevels, clamp(Math.round(Math.pow(2, params.bitDepth)), 2, 256));
        }
        break;
      }
      case 'noise': {
        const params = noiseParams(metrics, user);
        const level = clamp(params.visualNoise, 0, 1);
        if (onText) {
          text.noiseChars = Math.max(text.noiseChars, Math.round(MAX_NOISE_CHARS * level));
          // tilt runs 0 (brown) → 1 (white); the band it lands in chooses the
          // glyphs, so a brown bed speckles and a white one shouts.
          text.noiseBand = Math.max(
            text.noiseBand,
            clamp(Math.floor(clamp(params.tilt, 0, 1) * NOISE_GLYPHS.length), 0, NOISE_GLYPHS.length - 1)
          );
        }
        // A bed under the styling: every numeric declaration wobbles by up to
        // this fraction, so the line never sits quite still.
        if (onCss) css.jitter = Math.max(css.jitter, MAX_JITTER * level);
        break;
      }
      case 'echo': {
        const params = echoParams(metrics, user, cycle);
        // The repeats, as repeats: the last word comes back as many times as
        // the feedback carries it, at the wet gain's visibility.
        if (onText && params.wetGain > 0) {
          // ceil, not round: an echo audible on the mix must be visible in the
          // text too, and rounding gave no repeat at all for any feedback
          // below 1/6 — which is most of the useful range, since feedback is
          // normalized against a metric's upper bound.
          text.repeats = Math.max(text.repeats, Math.ceil(MAX_REPEATS * clamp(params.feedback, 0, 1)));
          text.repeatAlpha = Math.max(text.repeatAlpha, clamp(params.wetGain, 0, 1));
        }
        // Each turn's styling arrives out of the previous turn's rather than
        // switching hard — the CSS counterpart of a delay's tail.
        if (onCss) css.fadeFromPrevious = Math.max(css.fadeFromPrevious, clamp(params.wetGain, 0, 1));
        break;
      }
      default: break;
    }
  }
  return { text, css };
}

export function textStateIsNeutral(state) {
  if (!state) return true;
  return !(state.spacingPx > 0) && !(state.dropChance > 0)
    && !(state.noiseChars > 0) && !(state.repeats > 0 && state.repeatAlpha > 0);
}

export function cssStateIsNeutral(state) {
  if (!state) return true;
  return !(state.blurPx > 0) && !(state.quantizeStep > 1)
    && !(state.colorLevels > 0 && state.colorLevels < 256)
    && !(state.jitter > 0) && !(state.fadeFromPrevious > 0);
}

// --- the mutations themselves -------------------------------------------------
//
// Pure functions of (word, state, seed parts) so the renderer does no
// randomness of its own and node:test can check the exact output. `cycle`,
// `peer` and `index` NAME the occurrence, exactly as SeededRandom's callers
// name theirs: the same word, in the same cycle, from the same performer,
// mutates identically in every browser in the room.

// Drop a scaled share of the letters. Each character is decided on its own, so
// a long word loses proportionally more than a short one rather than being
// truncated.
export function crushWord(word, dropChance, cycle, peer, index) {
  if (!(dropChance > 0) || !word) return word;
  const rand = seededRandom(hashSeed(cycle, peer, index, 0x63));
  let out = '';
  for (const ch of word) {
    if (rand() >= dropChance) out += ch;
  }
  return out;
}

// Prefix, infix and suffix the word with glyphs from the bed's band. The three
// positions are drawn from one generator in a fixed order, so the whole
// injection is one occurrence rather than three that could drift apart.
export function noiseWord(word, { noiseChars, noiseBand }, cycle, peer, index) {
  if (!(noiseChars > 0) || !word) return word;
  const glyphs = NOISE_GLYPHS[clamp(noiseBand, 0, NOISE_GLYPHS.length - 1)] || NOISE_GLYPHS[0];
  const rand = seededRandom(hashSeed(cycle, peer, index, 0x6e));
  const draw = (n) => {
    let s = '';
    for (let i = 0; i < n; i++) s += glyphs[Math.floor(rand() * glyphs.length)] ?? '';
    return s;
  };
  // Split the budget across the three positions; at least one glyph goes
  // somewhere whenever the effect is on at all.
  const pre = Math.round(rand() * noiseChars);
  const suf = Math.round(rand() * (noiseChars - pre));
  const inf = Math.max(0, noiseChars - pre - suf);
  const prefix = draw(pre);
  const suffix = draw(suf);
  if (inf > 0 && word.length > 1) {
    const at = 1 + Math.floor(rand() * (word.length - 1));
    return prefix + word.slice(0, at) + draw(inf) + word.slice(at) + suffix;
  }
  return prefix + word + suffix;
}

// Quantize one numeric CSS value to the crush step, and jitter it by the noise
// bed. Returns the number; the caller re-attaches the unit it came with.
export function mutateNumber(value, { quantizeStep, jitter }, cycle, peer, index) {
  let out = value;
  if (quantizeStep > 1) out = Math.round(out / quantizeStep) * quantizeStep;
  if (jitter > 0) {
    const rand = seededRandom(hashSeed(cycle, peer, index, 0x6a));
    out = out * (1 + (rand() * 2 - 1) * jitter);
  }
  return out;
}

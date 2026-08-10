/**
 * Per-bot variation of the master script.
 *
 * Strategy: never rewrite the master code's internals — wrap it. The master
 * strudel code must evaluate to a pattern expression, so `(master).hpf(...)`
 * style chaining lets us layer any combination of the four stratification
 * roles without parsing user code. Hydra is varied the same way in spirit,
 * but Hydra has no such wrapper: a second top-level `.out(o0)` REBINDS the
 * buffer rather than compositing with it, so a role's visual has to be
 * spliced into the master's own chain, before its one `.out(o0)` (see
 * ../shared/hydra-chain.js).
 *
 * The roles are non mutually exclusive (spec): each enabled role contributes
 * its own chain suffix / hydra postlude / entry delay, and they compose.
 *
 * Always applied regardless of roles:
 *  - gain staging (gainForBotCount) so the Jamulus mix can't clip, and
 *  - the Trussal latency/jitter effects chain (effectsChain) from the bot's
 *    OWN measured link stats.
 */

import { gainForBotCount, effectsChain } from '../shared/audio-math.js';
import { staggerOffsetMs } from '../shared/stats.js';
import { insertBeforeHydraOut } from '../shared/hydra-chain.js';
import { wrapAsVoice } from '../../../src/strudel-voice.js';

// Audible band edges for role 1. 80 Hz spares the band-split from sub rumble
// every bot would otherwise share; 8 kHz keeps the top band musical.
const BAND_LO = 80;
const BAND_HI = 8000;

// Strudel's .late() takes cycles. Strudel's default tempo is 0.5 cps
// (one cycle = 2 s); the generated code can't read the live cps, so we
// convert with the default and document the assumption.
const DEFAULT_CPS = 0.5;

/**
 * Log-even split of [BAND_LO, BAND_HI]: each of the `count` bands spans the
 * same frequency RATIO (equal perceptual width), and bands are contiguous so
 * the fleet covers the whole spectrum with no gap and no overlap.
 */
export function frequencyBand(index, count) {
  if (!Number.isInteger(index) || index < 0 || index >= count) {
    throw new RangeError('index must be in [0, count)');
  }
  const ratio = (BAND_HI / BAND_LO) ** (1 / count);
  return {
    lo: BAND_LO * ratio ** index,
    hi: BAND_LO * ratio ** (index + 1),
  };
}

const round2 = (x) => Math.round(x * 100) / 100;

export function variationFor(botId, master, opts) {
  const {
    botCount, roles = {}, wclMs = 0, latencyMs = 0, jitterMs = 0,
    staggerSubdivisions = 1,
  } = opts;
  const index = botId % botCount;

  const strudelChain = [];
  const hydraSuffix = [];
  let entryDelayMs = 0;

  if (roles.frequencyBands) {
    const { lo, hi } = frequencyBand(index, botCount);
    strudelChain.push(`.hpf(${round2(lo)}).lpf(${round2(hi)})`);
    // Visual EM mirror: map the bot's audio band position onto the hue
    // circle, so low bots glow red-ish and high bots violet-ish. Chained
    // onto the master's own pipeline (see hydra-chain.js), not a separate
    // src(o0) statement — that would rebind o0 instead of tinting it. The
    // lowest-band bot (index 0) always computes 0/botCount — skip pushing a
    // `.hue(0)` for it, since that rotation is a Hydra no-op and would be
    // dead syntax rather than an actual colour shift.
    const bandHue = round2(index / botCount);
    if (bandHue !== 0) hydraSuffix.push(`.hue(${bandHue})`);
  }

  if (roles.staggeredRound) {
    entryDelayMs = staggerOffsetMs(index, botCount, wclMs, staggerSubdivisions);
    // In-pattern musical offset mirrors the entry delay (Global Drum Circle):
    // updates land one WCL-subdivision apart per bot.
    const lateCycles = (entryDelayMs / 1000) * DEFAULT_CPS;
    strudelChain.push(`.late(${round2(lateCycles)})`);
  }

  // Unison adds no transform by definition — its presence simply means the
  // master plays as-is alongside whatever other roles contribute.

  if (roles.stereoTiles) {
    // Evenly divided stereo image: bot 0 hard left … bot N-1 hard right.
    const pan = botCount === 1 ? 0.5 : index / (botCount - 1);
    strudelChain.push(`.pan(${round2(pan)})`);
    // Hydra: zoom into this bot's 1/N-wide column and shift it so the fleet's
    // tiles recompose the whole master image across the Jitsi grid.
    hydraSuffix.push(`.scale(${botCount}, 1).scrollX(${round2(index / botCount)})`);
  }

  // Universal stages: own-link fx chain, then gain staging last so nothing
  // after it can push the level back up.
  const fx = effectsChain({ latencyMs, jitterMs });
  // Latency-as-echo, baked in at the source so it is heard over any path
  // (Jamulus or Jitsi) with no double-processing: latency sets the echo time,
  // jitter the feedback. Worklet effects (distort/crush) mute headless bots, so
  // the native delay is the audible latency tell. Gain staging stays last.
  strudelChain.push(
    `.delay(.4).delaytime(${fx.delaySeconds}).delayfeedback(${round2(fx.feedback)})`,
  );
  strudelChain.push(`.gain(${round2(gainForBotCount(botCount))})`);

  return {
    botId,
    // wrapAsVoice, not a bare `(master.strudel)` wrap: the master code is
    // often more than one expression once it combines an audio voice with a
    // separate $: css(...)/$: word(...) voice (see strudel-voice.js's doc) —
    // wrapping THAT in one grouping expression is a SyntaxError that took
    // every bot down the moment a performer's repertoire did this.
    strudel: wrapAsVoice(master.strudel, strudelChain.join('')),
    hydra: insertBeforeHydraOut(master.hydra, hydraSuffix.join('')),
    // What peer-state broadcasts as this bot's pattern — passed through
    // as-is, not wrapped in the per-bot mix chain: the chain is an audible
    // shaping detail, invisible to the OTHER viewers who only ever extract
    // word()/css() statements from this string (buildBotSilentBlock). Falls
    // back to the eval master when a source has none (the fleet-wide random
    // master has no human text/css to parrot in the first place).
    announceStrudel: master.announceStrudel ?? master.strudel,
    entryDelayMs,
  };
}

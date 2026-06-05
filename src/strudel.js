// Strudel engine for the distributed instrument.
//
// One Cyclist scheduler per browser. Every browser combines the pattern code
// from every peer into a single `stack(...)` program and re-evaluates whenever
// any peer's state changes, so the whole room hears the same mix.
//
// Per-peer effect toggles are translated into Strudel-native operators
// (distort / crush / room) applied to that peer's portion of the stack — the
// worklet chain handles mic effects, this handles instrument effects.

import { getStrudelAudioContext } from './latency-instrument.js';
import { subscribePeerState, getAllPeers } from './peer-state.js';
import { subscribeParticipants, getLocalParticipant } from './participants.js';

export const DEFAULT_PATTERN = `n("<0 1 2 3 4>*8").scale('G4 minor')
  .s("gm_lead_6_voice")
  .clip(sine.range(.2,.8).slow(8))
  .jux(rev)
  .room(2)
  .sometimes(add(note("12")))
  .lpf(perlin.range(200,20000).slow(4))
`;

let strudelMod = null;
let strudelBoot = null;
let lastEvaluated = null;
let anyPlaying = false;

// Effect-parameter calculation must mirror latency-instrument.js so the audible
// mix matches the per-peer mic chain settings.
function computePeerStrudelParams(peer) {
  const rtt = typeof peer.rtt === 'number' ? peer.rtt : 0;
  const jitter = typeof peer.jitter === 'number' ? peer.jitter : 0;
  let glitchIntensity = 0;
  if (peer.effects && peer.effects.distortion) {
    const cleanThreshold = 5;
    const maxGlitchThreshold = 70;
    glitchIntensity = Math.max(0, Math.min(1,
      (rtt - cleanThreshold) / (maxGlitchThreshold - cleanThreshold) + (jitter / 15)
    ));
  }
  let crushBits = 0;
  if (peer.effects && peer.effects.noise) {
    if (jitter > 0.5 && jitter < 1.5) crushBits = 6;
    else if (jitter >= 1.5 && jitter < 3) crushBits = 4;
    else if (jitter >= 3) crushBits = 3;
  }
  return {
    glitchIntensity,
    crushBits,
    reverb: !!(peer.effects && peer.effects.reverb)
  };
}

// Returns the effect suffix string for a peer's computed params.
function effectChainFor(params) {
  let chain = '';
  if (params.glitchIntensity > 0) chain += `.distort(${params.glitchIntensity.toFixed(3)})`;
  if (params.crushBits > 0)       chain += `.crush(${params.crushBits})`;
  if (params.reverb)              chain += `.room(2)`;
  return chain;
}

// Builds the code block for one peer's contribution to the combined program.
// Returns a string of strudel statements (may be multi-line) or null if nothing
// to contribute.
//
// We use strudel's $: anonymous-voice syntax rather than wrapping in (...) so
// that the transpiler can handle labeled statements (name: expr → expr.p('name'))
// and *name: code declarations without a SyntaxError.
function buildPeerBlock(peer) {
  let code = (peer.pattern || '').replace(/[\s;]+$/g, '');
  if (!code || !peer.playing) return null;

  // Strip *name: code lines — these are button widget declarations, not patterns.
  // They generate StrudelButton instances for the facial-gesture dwell UI but
  // produce no audio on their own.
  code = code.replace(/^\*[a-zA-Z_$][a-zA-Z0-9_$]*\s*:.*$/mg, '').trim();
  if (!code) return null;

  const params = computePeerStrudelParams(peer);
  const fx = effectChainFor(params);

  // Detect labeled-statement syntax ("name: expr" / "$: expr").
  // These are multi-voice patterns handled natively by strudel's transpiler
  // (label → .p('name')), so we include them as raw statements.
  // When effects are active, inject them inline on single-line voices.
  const hasLabels = /^[a-zA-Z_$][a-zA-Z0-9_$]*\s*:/m.test(code);
  if (hasLabels) {
    // Split into the unlabeled block (before the first label) and the labeled block.
    // The unlabeled block is the user's main expression; without this split it would
    // silently fall out of pPatterns when strudel's applyPatternTransforms only stacks
    // registered (.p()) voices.
    const firstLabelPos = code.search(/^[a-zA-Z_$][a-zA-Z0-9_$]*\s*:/m);
    let unlabeled = '';
    let labeled = code;
    if (firstLabelPos > 0) {
      unlabeled = code.slice(0, firstLabelPos).trim();
      labeled   = code.slice(firstLabelPos);
    }
    if (fx) {
      labeled = labeled.replace(
        /^([a-zA-Z_$][a-zA-Z0-9_$]*\s*:\s*)(.+)$/mg,
        (_, label, expr) => `${label}(${expr.trim()})${fx}`,
      );
    }
    if (unlabeled) {
      return `$: (${unlabeled})${fx}\n${labeled}`;
    }
    return labeled;
  }

  // Simple expression pattern: wrap as an anonymous $: voice so multiple peers
  // are collected into pPatterns and stacked by applyPatternTransforms.
  return `$: (${code})${fx}`;
}

async function loadStrudel() {
  if (strudelMod) return strudelMod;
  strudelMod = await import('@strudel/web');
  return strudelMod;
}

const baseCDN = 'https://strudel.b-cdn.net';

// Boot Strudel exactly once, wiring its audio destination through our master
// gain so the whole stacked program hits realDestination without re-entering
// any peer's per-peer chain. Prebake mirrors strudel.cc exactly: built-in
// synths, ZZFX, GM soundfonts, and all CDN-hosted sample packs so any pattern
// from the public REPL works without surprises.
async function ensureStrudel() {
  if (strudelBoot) return strudelBoot;
  strudelBoot = (async () => {
    const { audioCtx, destinationNode } = await getStrudelAudioContext();
    Object.defineProperty(audioCtx, 'destination', {
      configurable: true,
      get: () => destinationNode
    });

    const mod = await loadStrudel();
    const { initStrudel, initAudio, samples, registerSynthSounds, registerZZFXSounds, registerSoundfonts, aliasBank } = mod;
    await initStrudel({
      audioContext: audioCtx,
      prebake: async () => {
        const safe = (p) => Promise.resolve(p).catch((e) => console.warn('[strudel] prebake item failed', e));
        await Promise.all([
          safe(typeof registerSynthSounds === 'function' && registerSynthSounds()),
          safe(typeof registerZZFXSounds === 'function' && registerZZFXSounds()),
          safe(typeof registerSoundfonts === 'function' && registerSoundfonts()),
          safe(samples(`${baseCDN}/piano.json`, `${baseCDN}/piano/`, { prebake: true })),
          safe(samples(`${baseCDN}/vcsl.json`, `${baseCDN}/VCSL/`, { prebake: true })),
          safe(samples(`${baseCDN}/tidal-drum-machines.json`, `${baseCDN}/tidal-drum-machines/machines/`, { prebake: true, tag: 'drum-machines' })),
          safe(samples(`${baseCDN}/uzu-drumkit.json`, `${baseCDN}/uzu-drumkit/`, { prebake: true, tag: 'drum-machines' })),
          safe(samples(`${baseCDN}/uzu-wavetables.json`, `${baseCDN}/uzu-wavetables/`, { prebake: true })),
          safe(samples(`${baseCDN}/mridangam.json`, `${baseCDN}/mrid/`, { prebake: true, tag: 'drum-machines' })),
          safe(samples(
            {
              casio: ['casio/high.wav', 'casio/low.wav', 'casio/noise.wav'],
              crow: ['crow/000_crow.wav', 'crow/001_crow2.wav', 'crow/002_crow3.wav', 'crow/003_crow4.wav'],
              insect: [
                'insect/000_everglades_conehead.wav',
                'insect/001_robust_shieldback.wav',
                'insect/002_seashore_meadow_katydid.wav',
              ],
              wind: [
                'wind/000_wind1.wav', 'wind/001_wind10.wav', 'wind/002_wind2.wav', 'wind/003_wind3.wav',
                'wind/004_wind4.wav', 'wind/005_wind5.wav', 'wind/006_wind6.wav', 'wind/007_wind7.wav',
                'wind/008_wind8.wav', 'wind/009_wind9.wav',
              ],
              jazz: [
                'jazz/000_BD.wav', 'jazz/001_CB.wav', 'jazz/002_FX.wav', 'jazz/003_HH.wav',
                'jazz/004_OH.wav', 'jazz/005_P1.wav', 'jazz/006_P2.wav', 'jazz/007_SN.wav',
              ],
              metal: [
                'metal/000_0.wav', 'metal/001_1.wav', 'metal/002_2.wav', 'metal/003_3.wav',
                'metal/004_4.wav', 'metal/005_5.wav', 'metal/006_6.wav', 'metal/007_7.wav',
                'metal/008_8.wav', 'metal/009_9.wav',
              ],
              east: [
                'east/000_nipon_wood_block.wav', 'east/001_ohkawa_mute.wav', 'east/002_ohkawa_open.wav',
                'east/003_shime_hi.wav', 'east/004_shime_hi_2.wav', 'east/005_shime_mute.wav',
                'east/006_taiko_1.wav', 'east/007_taiko_2.wav', 'east/008_taiko_3.wav',
              ],
              space: [
                'space/000_0.wav', 'space/001_1.wav', 'space/002_11.wav', 'space/003_12.wav',
                'space/004_13.wav', 'space/005_14.wav', 'space/006_15.wav', 'space/007_16.wav',
                'space/008_17.wav', 'space/009_18.wav', 'space/010_2.wav', 'space/011_3.wav',
                'space/012_4.wav', 'space/013_5.wav', 'space/014_6.wav', 'space/015_7.wav',
                'space/016_8.wav', 'space/017_9.wav',
              ],
              numbers: [
                'numbers/0.wav', 'numbers/1.wav', 'numbers/2.wav', 'numbers/3.wav',
                'numbers/4.wav', 'numbers/5.wav', 'numbers/6.wav', 'numbers/7.wav', 'numbers/8.wav',
              ],
              num: [
                'num/00.wav', 'num/01.wav', 'num/02.wav', 'num/03.wav', 'num/04.wav',
                'num/05.wav', 'num/06.wav', 'num/07.wav', 'num/08.wav', 'num/09.wav',
                'num/10.wav', 'num/11.wav', 'num/12.wav', 'num/13.wav', 'num/14.wav',
                'num/15.wav', 'num/16.wav', 'num/17.wav', 'num/18.wav', 'num/19.wav', 'num/20.wav',
              ],
            },
            `${baseCDN}/Dirt-Samples/`,
            { prebake: true },
          )),
        ]);
        if (typeof aliasBank === 'function') {
          safe(aliasBank(`${baseCDN}/tidal-drum-machines-alias.json`));
        }
      }
    });
    if (typeof initAudio === 'function') {
      try { await initAudio({}); } catch (e) { console.warn('[strudel] initAudio failed', e); }
    }
    return audioCtx;
  })();
  return strudelBoot;
}

async function rebuildAndEvaluate() {
  const blocks = getAllPeers()
    .map(buildPeerBlock)
    .filter(Boolean);

  // Combine all peer blocks as a multi-statement program.  strudel's transpiler
  // converts $: and name: statements to .p() calls that accumulate in pPatterns;
  // applyPatternTransforms then stacks them automatically — no explicit stack()
  // wrapper needed.
  const next = blocks.length === 0 ? null : blocks.join('\n');

  if (next === lastEvaluated) return;
  lastEvaluated = next;

  const { evaluate, hush } = await loadStrudel();
  if (!next) {
    anyPlaying = false;
    try { hush(); } catch (e) { /* ignore */ }
    return;
  }

  try {
    await evaluate(next);
    anyPlaying = true;
  } catch (e) {
    console.warn('[strudel] evaluate failed', e, '\nprogram:', next);
  }
}

// Strudel needs a user-gesture to bootstrap the audio context. The studio UI
// must call this from the Play click handler before anything is enqueued.
export async function bootStrudelOnUserGesture() {
  await ensureStrudel();
}

export async function syncStrudelFromPeers() {
  // Don't auto-boot; rebuild eagerly so the program is fresh when a user does
  // hit Play. If Strudel is already booted, evaluate immediately.
  if (!strudelBoot) return;
  await rebuildAndEvaluate();
}

export async function stopStrudel() {
  if (!strudelBoot) return;
  const { hush } = await loadStrudel();
  try { hush(); } catch (e) { /* ignore */ }
  anyPlaying = false;
  lastEvaluated = null;
}

export function isStrudelPlaying() { return anyPlaying; }

// React to roster changes — re-stack whenever someone's pattern, effects, or
// play state moves.
subscribePeerState((event, payload) => {
  if (event !== 'peer-upsert' && event !== 'peer-leave') return;
  if (strudelBoot) rebuildAndEvaluate();
});

subscribeParticipants((event) => {
  if (event === 'leave') {
    if (strudelBoot) rebuildAndEvaluate();
  }
});

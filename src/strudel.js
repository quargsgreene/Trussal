// Strudel engine for the distributed instrument.
//
// One Cyclist scheduler per browser. Every browser combines the pattern code
// from every peer into a single `stack(...)` program and re-evaluates whenever
// any peer's state changes, so the whole room hears the same mix. Exception:
// in aggregator mode only the LOCAL voice is evaluated (per-human publish
// isolation — see buildPeerBlock); remote humans are heard through the
// aggregator's assembled master instead of local re-evaluation.
//
// Per-peer effect toggles are translated into Strudel-native operators
// (distort / crush / room) applied to that peer's portion of the stack — the
// worklet chain handles mic effects, this handles instrument effects.

import { getStrudelAudioContext, getAggregatorPeer } from './latency-instrument.js';
import { subscribePeerState, getAllPeers } from './peer-state.js';
import { isNetCyclesActive, getActivePattern, getGateLevel } from './audio-net/Metaprogrammer.js';
import { subscribeParticipants, getLocalParticipant } from './participants.js';
import { registerSamplesFromDB } from './user-samples.js';
import { installLiveInput, stopLiveCaptures, beginLiveEpoch, releaseUnusedCaptures } from './live-input.js';
import { rewriteLiveCalls } from './live-input-core.js';
import { installTextCycles, setTextAtoms, stopTextCycles } from './text-cycles.js';
import { hasTextCycles, rewriteTextCalls, keepTextStatements } from './text-cycles-core.js';
import { getMode as getHydraVideoMode, MODE_DIRECT, resetHydraSync } from './hydra-video.js';
import { normalizePeerCode, splitHydraCode } from './hydra-code.js';

export const DEFAULT_PATTERN = `n("<0 1 2 3 4>*8").scale('G4:minor')
  .s("gm_lead_6_voice")
  .clip(sine.range(.2,.8).slow(8))
  .room(2)
  .lpf(perlin.range(200,20000).slow(4))
`;

let strudelMod = null;
let strudelBoot = null;
let lastEvaluated = null;
let anyPlaying = false;
let runPrebake = null; // set once the module is loaded; reusable for rebake-after-delete

// Slider state — keyed by the position-based id injected by the transpiler.
let sliderValues = {};   // id → current float value
let activeSliders = {};  // id → {min, max, step, defaultValue} populated during each eval
let _sliderRef = null;   // core's ref() function, set after Strudel loads

// Transpiler rewrites slider(start, min, max, step) → sliderWithID(id, start, min, max, step).
// This implementation stores the value reactively so patterns update without re-evaluation.
function sliderWithID(id, value, min, max, step) {
  if (min == null) min = 0;
  if (max == null) max = 1;
  const floatVal = parseFloat(value);
  if (!(id in sliderValues)) sliderValues[id] = floatVal;
  activeSliders[id] = { min, max, step: step != null ? step : (max - min) / 100, defaultValue: floatVal };
  return _sliderRef(() => sliderValues[id]);
}

export function updateSliderValue(id, value) {
  sliderValues[id] = parseFloat(value);
}

// Effect-parameter calculation mirrors latency-instrument.js so the Strudel
// instrument mix always has audible effects when toggled on. Network conditions
// modulate intensity beyond the base level for clearly perceptible differences.
function computePeerStrudelParams(peer) {
  const rtt    = typeof peer.rtt    === 'number' ? peer.rtt    : 0;
  const jitter = typeof peer.jitter === 'number' ? peer.jitter : 0;

  let glitchIntensity = 0;
  if (peer.effects && peer.effects.distortion) {
    const base  = 0.15;
    const extra = Math.max(0, Math.min(1 - base, (rtt - 5) / 55 + jitter / 6));
    glitchIntensity = base + extra;
  }

  // Always apply crush when noise is on; jitter determines severity.
  // Lower bit-depth = harsher; 8-bit gives mild grit, 2-bit gives lo-fi crunch.
  let crushBits = 0;
  if (peer.effects && peer.effects.noise) {
    if      (jitter < 1) crushBits = 8;
    else if (jitter < 3) crushBits = 5;
    else                 crushBits = 2;
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

// Split code that has top-level declarations from its trailing expression.
// Finds the last declaration line then returns everything before as preamble
// and everything after (first non-blank line onward) as the expression.
function splitDeclAndExpr(code) {
  const lines = code.split('\n');
  const DECL = /^\s*(let|const|var|function\b|class\b)/;
  let lastDeclLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (DECL.test(lines[i])) lastDeclLine = i;
  }
  if (lastDeclLine === -1) return null;
  let exprStart = -1;
  for (let i = lastDeclLine + 1; i < lines.length; i++) {
    if (lines[i].trim()) { exprStart = i; break; }
  }
  if (exprStart === -1) return null;
  return {
    preamble: lines.slice(0, exprStart).join('\n').trim(),
    expr:     lines.slice(exprStart).join('\n').trim(),
  };
}

const DECL_RE = /^\s*(let|const|var|function\b|class\b)/m;

// A program declares its non-audio capabilities with an `await initX()` line
// before the first blank line — visuals with initHydra, chat text with
// initTextCycles.
//
// The Hydra half of that question is asked through hydra-code.js, because the
// aggregator's mosaic asks the same one of the same text and the two must not
// disagree. Text Cycles is deliberately NOT folded in there: a text peer paints
// into each viewer's own chat panel and publishes no video, so it earns no
// mosaic cell, and teaching the mosaic's membership rule about it would hand
// one out. Same shape of split, different question.
const INIT_TEXT_RE = /^\s*await\s+initTextCycles\s*\(/;

// Split already-normalized code into its Text Cycles preamble and Strudel
// remainder, or null when the block does not declare one. A preamble-only
// block is legal and yields an empty `strudel`, exactly as for Hydra.
function splitTextCyclesCode(code) {
  if (!code || !INIT_TEXT_RE.test(code)) return null;
  const blank = code.match(/\n\n+/);
  if (!blank) return { preamble: code, strudel: '' };
  return {
    preamble: code.slice(0, blank.index).trim(),
    strudel: code.slice(blank.index).trim()
  };
}

// Text Cycles atoms for the program currently being assembled. Literal words
// are minted into grammar-legal tokens (see text-cycles-core.js) and the real
// characters travel here; the counter is shared across peers within one
// rebuild so two performers can never mint the same token.
let textAtoms = {};
let textCounter = { n: 0 };

// Mint one peer's text statements into the shared table and return the code
// with the renderer attached.
function applyTextRewrite(code, peer) {
  const { code: rewritten, atoms } = rewriteTextCalls(code, {
    peer: peer.jitsiId,
    counter: textCounter,
  });
  Object.assign(textAtoms, atoms);
  return rewritten;
}

// Build a labeled Strudel voice string from code that is known to be a Strudel
// pattern (no hydra preamble).  Used by buildPeerBlock for both the plain case
// and the post-preamble section of a hydra peer.
function buildStrudelVoice(code, fx) {
  // Detect labeled-statement syntax ("name: expr" / "$: expr").
  const hasLabels = /^[a-zA-Z_$][a-zA-Z0-9_$]*\s*:/m.test(code);
  if (hasLabels) {
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
      // Declarations are statements — wrapping them in $: (...) is a SyntaxError.
      // Emit at top level so they are in scope for the labeled voices below.
      if (DECL_RE.test(unlabeled)) return `${unlabeled}\n${labeled}`;
      return `$: (${unlabeled})${fx}\n${labeled}`;
    }
    return labeled;
  }

  // If code has top-level variable/function declarations, split preamble from
  // the trailing expression and label only the expression.  Wrapping a declaration
  // inside $: (...) produces a SyntaxError in acorn because declarations are
  // statements, not expressions.
  if (DECL_RE.test(code)) {
    const split = splitDeclAndExpr(code);
    if (split) return `${split.preamble}\n$: (${split.expr})${fx}`;
    // Declarations only, no trailing expression — emit as-is (nothing plays).
    return code;
  }

  return `$: (${code})${fx}`;
}

// Builds the code block for one peer's contribution to the combined program.
// Returns a string of strudel statements (may be multi-line) or null if nothing
// to contribute.
//
// We use strudel's $: anonymous-voice syntax rather than wrapping in (...) so
// that the transpiler can handle labeled statements (name: expr → expr.p('name'))
// and *name: code declarations without a SyntaxError.
//
// Hydra support: if the code starts with `await initHydra()`, the lines up to
// the first blank line are treated as a raw imperative preamble (hydra setup).
// Everything after the blank line is processed as a Strudel pattern voice.
// Users can write hydra-only blocks (no strudel voice after the blank line).
function buildPeerBlock(peer) {
  // Bots play their own Strudel inside their headless browser and reach the room
  // through their Jitsi mic / Jamulus, so their pattern is shown in the studio
  // for display + remote editing only — never folded into each viewer's combined
  // mix, which would play it a second time on top of the bot's incoming audio.
  // Under Net Cycles their incoming audio is slot-gated at the chain instead.
  if (peer.isBot) return null;

  // Net Cycles: the pattern that plays is the one the scheduler last dequeued
  // from this performer's buffer queue, so editor changes land at their next
  // slot rather than immediately.
  const netCycles = isNetCyclesActive();
  const source = netCycles ? (getActivePattern(peer.jitsiId) ?? peer.pattern) : peer.pattern;

  // Trailing noise and *name: widget declarations (buttons, not patterns) are
  // stripped by the shared normalizer — the same one the aggregator's mosaic
  // runs before asking whether this peer is running Hydra.
  let code = normalizePeerCode(source);
  if (!code || !peer.playing) return null;

  // live(): re-emit the device name as a transpiler-proof literal, and for
  // remote peers swap in the silent stub — capture belongs to the authoring
  // browser, but the pattern shape (struct, chained ops) must survive here.
  if (code.includes('live')) {
    code = rewriteLiveCalls(code, { silent: !peer.isLocal });
  }

  // Per-human publish isolation: while a remote aggregator is present, this
  // client's masterStrudelGain IS its outgoing Jitsi track (latency-instrument
  // publishLocalStrudelToRoom), so the program must carry ONLY the local voice —
  // a remote human folded in here would be baked into our published track, and
  // the aggregator's one-participant-per-slot master would play the whole room
  // during our turn. Dropping their audio loses nothing locally: remote humans
  // reach us through the aggregator's master (their chains and the local
  // monitor are muted in aggregator mode anyway). Their hydra preamble still
  // renders below — visuals are per-page and never ride the published track.
  const remoteVoiceExcluded = !peer.isLocal && !!getAggregatorPeer();

  const params = computePeerStrudelParams(peer);
  // Local peer audio effects are applied via the WebAudio strudelFx chain,
  // so skip the Strudel-native DSP wrapper to avoid double-processing.
  let fx = peer.isLocal ? '' : effectChainFor(params);
  // Net Cycles slot gate: a reactive gain the scheduler flips per slot —
  // no re-evaluation needed when a slot opens or closes.
  if (netCycles && peer.jitsiId) fx += `.gain(_ncGate(${JSON.stringify(peer.jitsiId)}))`;

  // Text Cycles: words are painted per-page into each viewer's own chat panel
  // and make no sound, so they never ride the published track — a text voice
  // must therefore survive the aggregator exclusion below that drops a remote
  // peer's audio, otherwise only your own words would ever appear.
  const isText = hasTextCycles(code);

  // Capability preamble, running to the first blank line: Hydra split by the
  // shared rule, so this page and the aggregator's mosaic never disagree about
  // which peers are running Hydra, or Text Cycles split by its own.
  const split = splitHydraCode(code) || splitTextCyclesCode(code);
  if (split) {
    const preamble = split.preamble;
    let strudelCode = split.strudel;
    if (isText) {
      // Excluded remote peer: keep the text statements, drop the audio ones.
      if (remoteVoiceExcluded) strudelCode = keepTextStatements(strudelCode);
      if (strudelCode) strudelCode = applyTextRewrite(strudelCode, peer);
    } else if (remoteVoiceExcluded) {
      return preamble;
    }
    // A preamble-only block has no Strudel voice to build.
    if (!strudelCode) return preamble;
    return `${preamble}\n\n${buildStrudelVoice(strudelCode, fx)}`;
  }

  if (remoteVoiceExcluded) return null;

  // Simple expression pattern: wrap as an anonymous $: voice so multiple peers
  // are collected into pPatterns and stacked by applyPatternTransforms.
  return buildStrudelVoice(code, fx);
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
    const { initStrudel, initAudio, samples, registerSynthSounds, registerZZFXSounds, registerSoundfonts, aliasBank, registerSampleSource } = mod;

    runPrebake = async () => {
      const safe = (p) => Promise.resolve(p).catch((e) => console.warn('[strudel] prebake item failed', e));
      await Promise.all([
        safe(typeof registerSynthSounds === 'function' && registerSynthSounds()),
        safe(typeof registerZZFXSounds === 'function' && registerZZFXSounds()),
        safe(typeof registerSoundfonts === 'function' && registerSoundfonts()),
        safe(typeof registerSampleSource === 'function' && registerSamplesFromDB(registerSampleSource)),
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
    };

    await initStrudel({ audioContext: audioCtx, prebake: runPrebake });
    _sliderRef = mod.ref;
    // _ncGate: reactive per-performer slot gate for Net Cycles (same ref
    // machinery as sliders — pattern events read the current level live).
    const _ncGate = (jitsiId) => _sliderRef(() => getGateLevel(jitsiId));
    // live("device"): rolling-capture sampler of a local audio input;
    // _liveSilent is the stub remote peers' live() calls are rewritten to.
    const { live, _liveSilent } = installLiveInput(mod, audioCtx);
    // Text Cycles: word/typeface/… controls plus initTextCycles(). Silent by
    // construction — the renderer it attaches carries a dominant trigger.
    const textScope = installTextCycles(mod);
    await mod.evalScope({ sliderWithID, _ncGate, live, _liveSilent, ...textScope });
    if (typeof initAudio === 'function') {
      try { await initAudio({ maxPolyphony: 128 }); } catch (e) { console.warn('[strudel] initAudio failed', e); }
    }
    return audioCtx;
  })();
  return strudelBoot;
}

async function rebuildAndEvaluate() {
  // Rebuilt from scratch every pass: tokens are only meaningful for the
  // program they were minted into.
  textAtoms = {};
  textCounter = { n: 0 };

  const blocks = getAllPeers()
    .map(buildPeerBlock)
    .filter(Boolean);

  const rawJoined = blocks.join('\n');

  let next = blocks.length === 0 ? null : rawJoined;

  if (next && getHydraVideoMode() === MODE_DIRECT) {
    // Ensure initHydra() is present so s0/o0/o1 are available in the eval ctx.
    if (!next.includes('initHydra')) {
      next = `await initHydra()\n\n${next}`;
    }

    // Redirect the user's Hydra .out() calls in the preamble to .out(o1) so
    // their visuals land in o1 rather than o0.  The blend step below reads o1
    // (previous frame) and composites it with the live camera (s0) into o0.
    const blankIdx = next.indexOf('\n\n');
    if (blankIdx !== -1) {
      const preamble = next.slice(0, blankIdx)
        .replace(/\.out\s*\(\s*o0\s*\)/g, '.out(o1)')
        .replace(/\.out\s*\(\s*\)/g,      '.out(o1)');
      next = preamble + next.slice(blankIdx);
    }

    // Blend user visuals (o1) with camera (s0); color tint driven by jitter/rtt
    // via window globals updated by hydra-video.js on each peer-state event.
    // Net Cycles echo brightness rides the same tint (window._ncVisual is
    // written by the Effects Service; identity when no effects are chained).
    next += '\nsrc(o1).blend(src(s0),()=>window._hvBlendAmt)'
         +  '.color(()=>window._hvR*((window._ncVisual&&window._ncVisual.brightness)||1),'
         +  '()=>window._hvG*((window._ncVisual&&window._ncVisual.brightness)||1),'
         +  '()=>window._hvB*((window._ncVisual&&window._ncVisual.brightness)||1)).out(o0)';
  }

  if (next === lastEvaluated) return;
  lastEvaluated = next;

  const { evaluate, hush } = await loadStrudel();
  if (!next) {
    anyPlaying = false;
    try { hush(); } catch (e) { /* ignore */ }
    // Nothing is playing, so no live() call can still want its device.
    stopLiveCaptures();
    return;
  }

  activeSliders = {};
  try {
    beginLiveEpoch();
    // Must precede evaluate(): the first haps can trigger before it returns,
    // and a token with no table entry would paint as raw "tc7".
    setTextAtoms(textAtoms);
    await evaluate(next);
    // Every live() in this program has now re-stamped the epoch; whatever
    // didn't is no longer referenced, so release its device.
    releaseUnusedCaptures();
    anyPlaying = true;
    // Tell hydra-video.js the Hydra synth was (re)created so s0 is re-synced
    // on the next frame rather than relying on the stale pre-eval reference.
    resetHydraSync();
    document.dispatchEvent(new CustomEvent('trussal-sliders-updated', {
      detail: Object.entries(activeSliders).map(([id, cfg]) => ({ id, value: sliderValues[id], ...cfg }))
    }));
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
  const { hush, clearHydra } = await loadStrudel();
  try { hush(); } catch (e) { /* ignore */ }
  try { if (typeof clearHydra === 'function') clearHydra(); } catch (e) { /* ignore */ }
  // Release captured devices with the music; the next evaluate that still
  // contains live() restarts its capture.
  stopLiveCaptures();
  // Words already in the chat stay there as history; only new ones stop.
  stopTextCycles();
  anyPlaying = false;
  lastEvaluated = null;
  activeSliders = {};
  document.dispatchEvent(new CustomEvent('trussal-sliders-updated', { detail: [] }));
}

export function isStrudelPlaying() { return anyPlaying; }

// Re-register local IDB samples with the already-loaded Strudel module.
// Call this after uploading new samples so they become available immediately
// without requiring a full page reload.
export async function refreshLocalSamples() {
  const mod = strudelMod;
  if (!mod || typeof mod.registerSampleSource !== 'function') return;
  await registerSamplesFromDB(mod.registerSampleSource).catch(e =>
    console.warn('[strudel] refreshLocalSamples failed', e)
  );
}

// Clear the in-memory sound registry and re-run the full prebake.
// Call this after deleting all user samples from IDB so built-in sounds are
// restored and the deleted user sounds are no longer accessible in patterns.
export async function rebakeStrudel() {
  const mod = strudelMod;
  if (!mod || !runPrebake) return;
  if (typeof mod.resetLoadedSounds === 'function') mod.resetLoadedSounds();
  await runPrebake().catch(e => console.warn('[strudel] rebake failed', e));
}

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

// When the hydra video mode changes, re-evaluate so initHydra() is injected or
// removed from the program as needed.
document.addEventListener('trussal-hydra-mode-change', () => {
  if (strudelBoot) rebuildAndEvaluate();
});

// Aggregator mode changes which peers the local program folds in (remote
// humans' audio voices are excluded while a remote aggregator is present —
// per-human publish isolation, see buildPeerBlock), so re-stack on every flip.
document.addEventListener('trussal-aggregator-mode-change', () => {
  if (strudelBoot) rebuildAndEvaluate();
});

// Net Cycles: rebuild when the mode flips (gates injected/removed) and when
// the scheduler dequeues a buffer whose pattern differs from the live one.
document.addEventListener('trussal-netcycles-mode', () => {
  if (strudelBoot) rebuildAndEvaluate();
});
document.addEventListener('trussal-netcycles-apply', () => {
  if (strudelBoot) rebuildAndEvaluate();
});

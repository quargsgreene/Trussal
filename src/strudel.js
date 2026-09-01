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
import { isJPatternActive, getActivePattern, getGateLevel, isDelayedStreaming, getStreamDelayMs } from './audio-net/Metaprogrammer.js';
import { subscribeParticipants } from './participants.js';
import { registerSamplesFromDB, registerImagesFromDB } from './user-samples.js';
import { rewriteDataRefs, makeDataFn } from './data-ref.js';
import { installLiveCapture, stopLiveCaptures, beginLiveEpoch, releaseUnusedCaptures } from './live-capture.js';
import { rewriteLiveCaptureCalls } from './live-capture-core.js';
import { installTextCycles, setTextAtoms, stopTextCycles } from './text-cycles.js';
import { hasTextCycles, rewriteTextCalls } from './text-cycles-core.js';
import { installCssCycles, setCssAtoms, publishCssSheets, stopCssCycles } from './css-cycles.js';
import { hasCssCycles, rewriteCssCalls, keepSilentStatements } from './css-cycles-core.js';
import { getMode as getHydraVideoMode, MODE_DIRECT, resetHydraSync, ensureCameraBypass } from './hydra-video.js';
import { normalizePeerCode, splitHydraCode, programDeclaresHydra, usesExternalSource } from './hydra-code.js';
import { readDirective } from './program-directive.js';
import { textLog, textLogChanged, textWarn, registerTextProbe, clip } from './text-debug.js';
import { wrapAsVoice } from './strudel-voice.js';
// mondo notation for the personal editor: importing registers `mondo`/`mondolang`
// as transpiler languages; the tag functions go into evalScope below.
import { mondo, mondi, mondolang } from './mondo-notation.js';

export const DEFAULT_PATTERN = `'personal editor'
n("<0 1 2 3 4>*8").scale('G4:minor')
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

// A program declares its non-audio capabilities with an `await initX()` line
// before the first blank line — visuals with initHydra, chat text with
// initTextCycles, page styling with initCss. Any of them may share one
// preamble.
//
// The Hydra half of that question is asked through hydra-code.js, because the
// aggregator's mosaic asks the same one of the same text and the two must not
// disagree. The silent capabilities are deliberately NOT folded in there: a
// text or styling peer paints into each viewer's own page and publishes no
// video, so it earns no mosaic cell, and teaching the mosaic's membership rule
// about them would hand one out. Same shape of split, different question.
//
// Split already-normalized code into its silent-capability preamble and Strudel
// remainder, or null when the block does not declare one. A preamble-only
// block is legal and yields an empty `strudel`, exactly as for Hydra.
//
// The declaration is recognised by hasTextCycles/hasCssCycles THEMSELVES,
// asked of the preamble, rather than by a third regex of this module's own.
// That is not tidiness: buildPeerBlock uses those two predicates to decide a
// block is text (isText) and uses this function to decide whether to rewrite
// it, so when the rules disagree the block is treated as text and never
// rewritten — no minted atoms, no ._tcRender(), hence no renderer, no sound
// and no words, with nothing anywhere saying why. The private regex here was
// anchored to the start of the BLOCK while the predicates anchor to a line, so
// a single comment above `await initTextCycles()` was enough to split them.
function splitSilentCode(code) {
  if (!code) return null;
  const blank = code.match(/\n\n+/);
  // Before the first blank line — the preamble is where a declaration counts,
  // exactly as for Hydra.
  const preamble = blank ? code.slice(0, blank.index) : code;
  if (!hasTextCycles(preamble) && !hasCssCycles(preamble)) return null;
  if (!blank) return { preamble: code, strudel: '' };
  return {
    preamble: preamble.trim(),
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
  // STORAGE POINT 3: the rewrite. `minted: 0` means no literal word() argument
  // was found (an interpolated template, or a statement the scanner did not
  // see as carrying a word), and a result with no ._tcRender() has no renderer
  // attached at all — both paint nothing.
  textLogChanged(`rewrite:${peer.jitsiId ?? 'local'}`, {
    minted: Object.keys(atoms).length,
    words: Object.fromEntries(Object.entries(atoms).map(([t, a]) => [t, a.text])),
    rendererAttached: rewritten.includes('._tcRender()'),
    before: clip(code),
    after: clip(rewritten),
  });
  return rewritten;
}

// CSS Cycles atoms and sheets for the program currently being assembled. Same
// minting scheme as the text table, and the same shared counter reasoning: two
// performers must never mint the same token, because the token is also what
// names the custom properties their rules read.
let cssAtoms = {};
let cssCounter = { n: 0 };
// EVERY peer's sheets, not just ours: this browser evaluates every peer's
// program, so it is this browser that assigns the custom properties their
// installed rules read. Only the SCSS send is local-only.
let cssSheets = [];

function applyCssRewrite(code, peer) {
  const { code: rewritten, atoms, sheets, errors } = rewriteCssCalls(code, {
    peer: peer.jitsiId,
    counter: cssCounter,
  });
  Object.assign(cssAtoms, atoms);
  cssSheets = cssSheets.concat(sheets);
  if (errors.length) console.error('[css-cycles]', errors.join('; '));
  return rewritten;
}

// A bot's contribution to this page's program: its Text/CSS Cycles
// statements, or nothing at all.
//
// A bot's audio arrives as audio (its own headless browser plays it into Jitsi
// or Jamulus), so folding its pattern in here would play it twice. Its WORDS
// and STYLING are the opposite case — both are painted per-page from the
// program and never ride any track, so a bot's words/CSS reach a viewer only
// if that viewer's own program carries them. This is the whole mechanism by
// which a bot's words/styling reach the room: an undeclared (exact-copy)
// cluster keeps its author's word()/css() statements in the bot's announced
// script (a `botConfig(...)` declaration strips them, and the bot's own eval
// never runs them either — see cluster-source.js's
// dropTextStatements/dropCssStatements), and this decides whether the room can
// see them.
function buildBotSilentBlock(peer) {
  // Unlike a human's own live editing, a bot is operator-puppeted via the
  // studio's remote-control path — it never holds a JPattern buffer queue
  // slot the way a performer typing along with the rotation does, so its
  // code always reflects the latest remote-eval edit rather than staging
  // behind the ring's next-turn dequeue (getActivePattern would otherwise
  // replay whatever the ring last picked up, which could be several
  // rotations stale).
  // A bot runs a 'bot editor' buffer; one puppeted with a human's captured
  // editor may still carry that human's 'personal editor' directive. Either is
  // fine; anything else (or none) contributes nothing.
  const botDir = readDirective(peer.pattern).kind;
  if (botDir !== 'bot' && botDir !== 'personal') return null;

  const code = normalizePeerCode(peer.pattern);
  if (!code || !peer.playing || (!hasTextCycles(code) && !hasCssCycles(code))) return null;

  // A bot's own Hydra preamble, if it has one, is never forwarded here — it
  // is per-peer visual state the aggregator's mosaic handles instead, and
  // re-running it inside every OTHER viewer's own program would draw the
  // bot's pattern onto a canvas that isn't its own. Strip it via the shared
  // rule first, exactly as buildPeerBlock does for a human running Hydra
  // alongside Text/CSS Cycles, so a preceding preamble can't hide the
  // capabilities declared after it (the whole reason splitSilentCode alone
  // used to fail here whenever a bot also carried Hydra).
  const hydraSplit = splitHydraCode(code);
  const afterHydra = hydraSplit ? hydraSplit.strudel : code;
  if (!afterHydra || (!hasTextCycles(afterHydra) && !hasCssCycles(afterHydra))) return null;

  // Rewritten over the WHOLE remainder, same as buildPeerBlock — the rewrite
  // mints tokens and attaches the dominant trigger regardless of which
  // statement a declaration happens to share a line group with, so it must
  // run before anything gets split into kept/dropped statements.
  let rewritten = afterHydra;
  if (hasCssCycles(afterHydra)) rewritten = applyCssRewrite(rewritten, peer);
  if (hasTextCycles(afterHydra)) rewritten = applyTextRewrite(rewritten, peer);

  // Audio statements are dropped, not silenced: the bot is already playing them
  // for real, and a muted copy here would still cost a voice in every browser.
  const silentOnly = keepSilentStatements(rewritten);
  // STORAGE POINT 2 (bots): a bot's words/CSS reach the room only through
  // this, because the only page running its program is its own headless
  // Chromium.
  textLogChanged(`peer-block:bot:${peer.jitsiId ?? peer.peerId}`, {
    playing: peer.playing,
    kept: !!silentOnly,
    ...(silentOnly ? {} : { why: 'declares Text/CSS Cycles but nothing silent survived the split' }),
  });
  if (!silentOnly) return null;
  return buildStrudelVoice(silentOnly, '');
}

// Build a labeled Strudel voice string from code that is known to be a Strudel
// pattern (no hydra preamble).  Used by buildPeerBlock for both the plain case
// and the post-preamble section of a hydra peer.
//
// The label-aware wrapping itself lives in strudel-voice.js, shared with the
// bot fleet's variation.js — see that module's doc for why a naive "wrap the
// whole thing in one (...)" or "only handle code before the first label"
// approach breaks the moment a performer's code combines an audio voice with
// a separate $: css(...)/$: word(...) voice.
function buildStrudelVoice(rawCode, fx) {
  // Data packs: "Weather:3" → _data('Weather',3,…) before the transpiler can
  // mini-parse it into a sound:index object. Applied here rather than in
  // buildPeerBlock so it only ever sees Strudel code — a Hydra or Text Cycles
  // preamble has already been split off, and its H("Weather:3") is resolved by
  // hydra-params instead.
  return wrapAsVoice(rewriteDataRefs(rawCode), fx);
}

// --- Delayed Streaming: code-state delay-line --------------------------------
//
// When the aggregator is pre-buffering each performer's off-turn output and
// streaming it on their turn (Delayed Streaming, room-wide toggle), the audio a
// viewer hears during peer P's turn is P's output from `getStreamDelayMs()` ago.
// P's Text/CSS Cycles bubbles and their locally-rendered Hydra preamble are
// built from P's program in every browser, so left alone they would show P's
// CURRENT code while the sound is delayed. This keeps a short per-peer history
// of each peer's (pattern, playing) and hands buildPeerBlock the entry from
// `delay` ms ago, so the whole turn lands together. (The aggregator applies the
// same delay to its published mosaic cell — see aggregator-bot #mosaicPeersView.)
//
// Only remote peers and bots are delayed: the local performer authors live, and
// their own published audio track must stay live (the aggregator does the
// delaying) — delaying it here too would double up. Their own words/styling
// showing live in their own view is a harmless authoring convenience.
const peerCodeLog = new Map(); // peerKey -> [{ t, pattern, playing }], oldest→newest
const PEER_CODE_LOG_MARGIN_MS = 5000;

function peerCodeLogKey(peer) {
  return peer.peerId || peer.jitsiId || null;
}

function recordPeerCode(key, pattern, playing, now, keepMs) {
  let log = peerCodeLog.get(key);
  if (!log) { log = []; peerCodeLog.set(key, log); }
  const last = log[log.length - 1];
  if (!last || last.pattern !== pattern || last.playing !== playing) {
    log.push({ t: now, pattern, playing });
  }
  // Drop entries older than the window, but always keep the last one that is
  // still <= (now - keepMs) so a peer whose code has not changed in a while
  // still resolves to it rather than to nothing.
  const cutoff = now - keepMs - PEER_CODE_LOG_MARGIN_MS;
  let firstKept = 0;
  while (firstKept + 1 < log.length && log[firstKept + 1].t <= cutoff) firstKept++;
  if (firstKept > 0) log.splice(0, firstKept);
}

// The newest history entry at or before `at`. Falls back to the NEWEST entry
// when `at` predates the whole log — a still-warming toggle, or a peer in the
// room less than `delay` — so the voices track live code until the history is
// deep enough to backdate them, matching the aggregator's audio backlog
// underrunning to live over the same window.
function peerCodeAt(key, at) {
  const log = peerCodeLog.get(key);
  if (!log || !log.length) return null;
  let pick = null;
  for (const entry of log) { if (entry.t <= at) pick = entry; else break; }
  return pick || log[log.length - 1];
}

function forgetPeerCode(key) {
  if (key) peerCodeLog.delete(key);
}

// The peer view buildPeerBlock should use this pass: the live peer, except a
// remote peer / bot under warm Delayed Streaming, which gets its (pattern,
// playing) from `delay` ms back. Records the live state into the history as a
// side effect, so this must run once per peer per rebuild.
function delayedPeerView(peer) {
  if (peer.isAggregator) return peer;
  const key = peerCodeLogKey(peer);
  const delay = (key && getAggregatorPeer() && !isJPatternActive()) ? getStreamDelayMs() : 0;
  // Local peer stays live (see the note above); JPattern's own getActivePattern
  // staging (buildPeerBlock) already delays behind the ring, so don't stack.
  if (!delay || peer.isLocal) {
    if (key && !delay) peerCodeLog.delete(key); // stale once the mode is off
    return peer;
  }
  // Record only while the mode is on, so the history starts empty at the flip
  // and warms up over the same span the audio backlog does.
  recordPeerCode(key, peer.pattern, !!peer.playing, Date.now(), delay);
  const past = peerCodeAt(key, Date.now() - delay);
  if (!past || (past.pattern === peer.pattern && past.playing === !!peer.playing)) return peer;
  return { ...peer, pattern: past.pattern, playing: past.playing };
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
  // Under JPattern their incoming audio is slot-gated at the chain instead.
  //
  // Text and CSS Cycles are the one exception, and for the same reason the
  // aggregator exclusion below carves them out: both are painted into each
  // viewer's own page (chat panel, stylesheet) from that viewer's program,
  // and make no sound. A bot's words/styling would otherwise appear NOWHERE —
  // the only page running its program is its own headless Chromium, whose
  // chat panel and stylesheet nobody sees. So keep a bot's silent statements
  // and drop everything else — its audio already arrives as audio.
  if (peer.isBot) return buildBotSilentBlock(peer);

  // JPattern: the pattern that plays is the one the scheduler last dequeued
  // from this performer's buffer queue, so editor changes land at their next
  // slot rather than immediately.
  const jPattern = isJPatternActive();
  const source = jPattern ? (getActivePattern(peer.jitsiId) ?? peer.pattern) : peer.pattern;

  // The directive is required, with no heuristic fallback: a personal editor
  // buffer that does not open with 'personal editor' contributes nothing to
  // the combined program. The local peer is told why through the studio status
  // line (onEvalAndPlay); a remote peer on a stale bundle is dropped quietly.
  if (source && readDirective(source).kind !== 'personal') {
    if (!peer.isLocal) console.warn(`[strudel] peer ${peer.jitsiId ?? peer.peerId} has no 'personal editor' directive — dropped`);
    return null;
  }

  // Trailing noise and *name: widget declarations (buttons, not patterns) are
  // stripped by the shared normalizer — the same one the aggregator's mosaic
  // runs before asking whether this peer is running Hydra.
  let code = normalizePeerCode(source);
  if (!code || !peer.playing) {
    // Text flows only while the performer is playing, the same as audio — so
    // "I pressed nothing and nothing happened" is a state worth naming.
    if (hasTextCycles(code)) {
      textLogChanged(`peer-block:${peer.jitsiId ?? peer.peerId}`, {
        contributes: false,
        playing: peer.playing,
        why: 'declares text but is not playing — press Play; text flows only while the performer does',
      });
    }
    return null;
  }

  // liveCapture(): re-emit the medium and source-name strings as
  // transpiler-proof literals, and for remote peers swap in the silent stub —
  // capture belongs to the authoring browser, but the pattern shape (struct,
  // chained ops) must survive here.
  if (code.includes('liveCapture')) {
    code = rewriteLiveCaptureCalls(code, { silent: !peer.isLocal });
  }

  // Per-human publish isolation: while a remote aggregator is present, this
  // client's masterStrudelGain IS its outgoing Jitsi track (latency-instrument
  // publishLocalStrudelToRoom), so the program must carry ONLY the local voice —
  // a remote human folded in here would be baked into our published track, and
  // the aggregator's one-participant-per-slot master would play the whole room
  // during our turn. Dropping their audio loses nothing locally: remote humans
  // reach us through the aggregator's master (their chains and the local
  // monitor are muted in aggregator mode anyway). Their hydra preamble still
  // renders below — visuals are per-page and never ride the published track —
  // except an External Source preamble, which is dropped below regardless of
  // this flag; see the dropPreamble comment.
  const remoteVoiceExcluded = !peer.isLocal && !!getAggregatorPeer();

  const params = computePeerStrudelParams(peer);
  // Local peer audio effects are applied via the WebAudio strudelFx chain,
  // so skip the Strudel-native DSP wrapper to avoid double-processing.
  let fx = peer.isLocal ? '' : effectChainFor(params);
  // JPattern slot gate: a reactive gain the scheduler flips per slot —
  // no re-evaluation needed when a slot opens or closes.
  if (jPattern && peer.jitsiId) fx += `.gain(_jpGate(${JSON.stringify(peer.jitsiId)}))`;

  // Text Cycles paints per-page into each viewer's own chat panel and CSS
  // Cycles restyles each viewer's own document; neither makes a sound, so
  // neither rides the published track. Both must therefore survive the
  // aggregator exclusion below that drops a remote peer's audio — otherwise
  // you would only ever see your own words and your own styling.
  const isText = hasTextCycles(code);
  const isCss = hasCssCycles(code);

  // Capability preamble, running to the first blank line: Hydra split by the
  // shared rule, so this page and the aggregator's mosaic never disagree about
  // which peers are running Hydra, or the silent capabilities split by their
  // own.
  const hydraSplit = splitHydraCode(code);
  const split = hydraSplit || splitSilentCode(code);
  // STORAGE POINT 2: this peer's contribution to the program, as decided. The
  // one way a text block silently produces nothing is landing here unsplit:
  // isText is true, so the code is text, but with no preamble to split off the
  // rewrite below never runs and the renderer is never attached.
  if (isText && !split) {
    textWarn(`peer-block:${peer.jitsiId ?? peer.peerId}`,
      'declares initTextCycles() but no preamble could be split off, so nothing will be rewritten or rendered',
      { why: 'the declaration must be on its own line before the first blank line, with the patterns after it', code: clip(code) });
  }
  if (split) {
    const preamble = split.preamble;
    // s0-s3 are ONE page-global Hydra object (ensureCameraBypass patches
    // THIS page's own s0-s3 the moment initHydra() runs), so literally
    // executing another peer's initCam/initScreen/initImage/initVideo/init
    // statement here would silently reassign the shared source for every
    // `src(sN)` layer on this page — including the local performer's own —
    // to whichever remote peer's statement happened to run last. That is
    // exactly the hazard usesExternalSource exists to flag for the
    // aggregator's mosaic (which blits instead of re-executing); this combined
    // per-viewer program has no track to blit into a texture, so a remote
    // peer's External Source preamble is dropped instead of run. Their
    // Strudel voice (audio) below is unaffected.
    const dropPreamble = !peer.isLocal && !!hydraSplit && usesExternalSource(code);
    // Strudel's transpiler mini-notation-parses EVERY double-quoted string in
    // the evaluated program — plugin-mini.mjs's isStringWithDoubleQuotes has
    // no notion of which function it is an argument to — so
    // `s0.initImage("folder")` or `img("folder")` would silently receive a
    // parsed Pattern instead of the plain string it expects, and never load
    // anything. A Hydra preamble never needs mini-notation itself (that's
    // what the Strudel voice after the blank line is for), so disable it for
    // the whole preamble via Strudel's own `mini-off`/`mini-on` comment-range
    // convention, rather than asking every performer to remember single
    // quotes for every URL/folder argument.
    const outPreamble = dropPreamble ? '' : (hydraSplit ? `/* mini-off */\n${preamble}\n/* mini-on */` : preamble);
    let strudelCode = split.strudel;
    if (isText || isCss) {
      // Excluded remote peer: keep the silent statements, drop the audio ones.
      if (remoteVoiceExcluded) strudelCode = keepSilentStatements(strudelCode);
      if (isText) {
        textLogChanged(`peer-block:${peer.jitsiId ?? peer.peerId}`, {
          contributes: true,
          isLocal: peer.isLocal,
          remoteVoiceExcluded,
          preamble: clip(preamble, 120),
          statements: clip(strudelCode),
          ...(strudelCode ? {} : { why: remoteVoiceExcluded
            ? 'the aggregator exclusion kept no silent statements — no word() or css() survived'
            : 'the preamble declares text but there are no statements after the blank line' }),
        });
      }
      // CSS first: the text rewrite appends `._tcRender()` on its own line,
      // which would otherwise land between a css() call and its chain.
      if (strudelCode && isCss) strudelCode = applyCssRewrite(strudelCode, peer);
      if (strudelCode && isText) strudelCode = applyTextRewrite(strudelCode, peer);
    } else if (remoteVoiceExcluded) {
      return outPreamble;
    }
    // A preamble-only block has no Strudel voice to build. (When dropPreamble
    // emptied outPreamble, this is also the "nothing left to contribute" case
    // — an External Source Hydra-only block from a remote peer — and the
    // empty string is filtered out by rebuildAndEvaluate's Boolean filter.)
    if (!strudelCode) return outPreamble;
    return outPreamble ? `${outPreamble}\n\n${buildStrudelVoice(strudelCode, fx)}` : buildStrudelVoice(strudelCode, fx);
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
        // Uploaded images, alongside the sounds: this is what makes img()
        // resolve inside a Hydra preamble.
        safe(registerImagesFromDB()),
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

    await initStrudel({ audioContext: audioCtx });
    // runPrebake fetches every CDN sample pack (piano, VCSL, drum machines,
    // Dirt-Samples, …) — tens of MB. Passing it as initStrudel's `prebake`
    // would block on the whole download before evaluate() below can run: on
    // a mobile connection that's a sustained bulk-download burst competing
    // with the meeting's own RTP/STUN traffic for long enough that the JVB's
    // periodic connectivity checks to the client time out and the endpoint
    // gets expired mid-download — every "edit, hit play" reproduces it.
    // Firing it in the background instead lets evaluate() start immediately
    // on whatever defaultPrebake() already registered (synths, ZZFX); each
    // sample pack becomes available as its own registration resolves.
    runPrebake().catch((e) => console.warn('[strudel] prebake failed', e));
    _sliderRef = mod.ref;
    // _jpGate: reactive per-performer slot gate for JPattern (same ref
    // machinery as sliders — pattern events read the current level live).
    const _jpGate = (jitsiId) => _sliderRef(() => getGateLevel(jitsiId));
    // liveCapture(medium, name, detectLocalDevices): rolling-capture sampler of
    // a participant's aggregator output or a local input / the local performer's
    // gesture + cursor input; _liveCaptureSilent is the stub remote peers' calls
    // are rewritten to.
    const { liveCapture, _liveCaptureSilent } = installLiveCapture(mod, audioCtx);
    // Text Cycles: word/typeface/… controls plus initTextCycles(). Silent by
    // construction — the renderer it attaches carries a dominant trigger.
    const textScope = installTextCycles(mod);
    // CSS Cycles: css() plus one `_cc_*` control per CSS property, and
    // initCss(). Silent by construction for the same reason — the renderer it
    // attaches carries a dominant trigger.
    const cssScope = installCssCycles(mod);
    // _data("Name",N): what the "Weather:3" rewrite calls. Falls back to mini
    // notation when the name is not a loaded pack, so a rewritten sound
    // reference behaves exactly as it did before data packs existed.
    const _data = makeDataFn(mod);
    // Wrap Hydra's own initHydra() so s0-s3's .initCam() is patched the
    // MOMENT they exist, before any user code runs. Doing this from
    // hydra-video.js's RAF loop instead loses the race: a preamble's very
    // next line is routinely `s0.initCam()` itself, called synchronously
    // right after `await initHydra()` and well before the next animation
    // frame — patching later leaves that first call hitting the unpatched,
    // getUserMedia-intercepted original.
    const realInitHydra = mod.initHydra;
    const initHydra = async (...args) => {
      const result = await realInitHydra(...args);
      try { ensureCameraBypass(); } catch (e) { console.warn('[strudel] camera bypass failed', e); }
      return result;
    };
    await mod.evalScope({ sliderWithID, _jpGate, liveCapture, _liveCaptureSilent, _data, initHydra, mondo, mondi, mondolang, ...textScope, ...cssScope });
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
  cssAtoms = {};
  cssCounter = { n: 0 };
  cssSheets = [];

  const blocks = getAllPeers()
    .map(delayedPeerView)
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
    // JPattern echo brightness rides the same tint (window._jpVisual is
    // written by the Effects Service; identity when no effects are chained).
    next += '\nsrc(o1).blend(src(s0),()=>window._hvBlendAmt)'
         +  '.color(()=>window._hvR*((window._jpVisual&&window._jpVisual.brightness)||1),'
         +  '()=>window._hvG*((window._jpVisual&&window._jpVisual.brightness)||1),'
         +  '()=>window._hvB*((window._jpVisual&&window._jpVisual.brightness)||1)).out(o0)';
  }

  // Minted tokens (cc0, tc7, …) are positional placeholders assigned by
  // encounter order, not the literal text they stand for — a program that
  // only changed a word's spelling or a css() value's hex code re-mints
  // byte-identical tokens in the same positions, so `next` looks unchanged
  // even though the atom table underneath it just did. Atoms and css sheets
  // are cheap, side-effect-free to republish and are read live at trigger
  // time (resolve() consults the CURRENT table on every hap), so they always
  // run here regardless of the dedup below — only the actual (expensive,
  // pattern-restarting) re-evaluation is skipped when the program text
  // itself did not change. Skipping this would freeze every text/css voice
  // at whatever it first evaluated to: further edits would keep being
  // accepted and sent, but never take visible effect.
  if (next) {
    setTextAtoms(textAtoms);
    setCssAtoms(cssAtoms);
    publishCssSheets(cssSheets);
  }

  if (next === lastEvaluated) return;
  lastEvaluated = next;

  const { evaluate, hush, clearHydra } = await loadStrudel();

  // Take the Hydra canvas down when the program no longer asks for it.
  //
  // initHydra() creates a FULLSCREEN fixed canvas prepended to <body> and
  // thereafter only ever reuses the one already there, so no amount of
  // re-evaluating removes it: a performer who deleted their visuals was left
  // with them covering the room until they pressed Stop, which was the only
  // caller of clearHydra() and takes the audio down with it. Commenting the
  // preamble out is the natural gesture for "no more visuals", and this is
  // what makes it work.
  //
  // In `direct` mode the preamble is injected above, so the program always
  // declares Hydra and this correctly never fires — that mode's whole premise
  // is compositing the camera through Hydra.
  if (!programDeclaresHydra(next)) {
    try {
      if (typeof clearHydra === 'function') clearHydra();
    } catch (e) {
      // Reported, not rethrown: a canvas that would not come down must not
      // also stop the program that is still playing from being evaluated.
      console.error('[strudel] could not clear the Hydra canvas', e);
    }
  }

  if (!next) {
    anyPlaying = false;
    try { hush(); } catch (e) { /* ignore */ }
    // Nothing is playing, so no liveCapture() call can still want its source.
    stopLiveCaptures();
    return;
  }

  activeSliders = {};
  try {
    beginLiveEpoch();
    // STORAGE POINT 5: the program actually handed to Strudel. If the words
    // are here and nothing appears, the failure is downstream — the trigger or
    // the container.
    if (hasTextCycles(next)) {
      textLog('program', {
        atoms: Object.keys(textAtoms).length,
        renderers: (next.match(/\._tcRender\(\)/g) || []).length,
        program: clip(next, 1500),
      });
    }
    await evaluate(next);
    // Every liveCapture() in this program has now re-stamped the epoch;
    // whatever didn't is no longer referenced, so release its source.
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
    // An evaluate that throws takes the WHOLE room's program down, words
    // included, so a text program that never paints is often someone else's
    // syntax error. Say so from this side too.
    if (hasTextCycles(next)) {
      textWarn('program', 'evaluate() threw — no part of this program is running, including its words', {
        error: String(e && e.message || e),
        program: clip(next, 1500),
      });
    }
  }
}

// The program side of __trussalText.state(): who is contributing words, and
// what the last evaluated program looked like. Pulled, so it costs nothing
// until something has gone wrong and someone asks.
registerTextProbe('program', () => ({
  jPatternActive: isJPatternActive(),
  aggregatorPresent: !!getAggregatorPeer(),
  peers: getAllPeers().map((p) => ({
    jitsiId: p.jitsiId,
    roomIndex: p.roomIndex,
    isLocal: !!p.isLocal,
    isBot: p.isBot,
    playing: p.playing,
    declaresText: hasTextCycles(normalizePeerCode(p.pattern)),
  })),
  atoms: Object.keys(textAtoms).length,
  renderers: (String(lastEvaluated ?? '').match(/\._tcRender\(\)/g) || []).length,
  lastEvaluated: clip(lastEvaluated, 1500),
}));

// Strudel needs a user-gesture to bootstrap the audio context. The studio UI
// must call this from the Play click handler before anything is enqueued.
export async function bootStrudelOnUserGesture() {
  await ensureStrudel();
}

export async function stopStrudel() {
  if (!strudelBoot) return;
  const { hush, clearHydra } = await loadStrudel();
  try { hush(); } catch (e) { /* ignore */ }
  try { if (typeof clearHydra === 'function') clearHydra(); } catch (e) { /* ignore */ }
  // Release captured sources with the music; the next evaluate that still
  // contains liveCapture() restarts its capture.
  stopLiveCaptures();
  // Words already in the chat stay there as history; only new ones stop.
  stopTextCycles();
  // Styling does NOT stay: every sheet is pulled and every custom property
  // released, so stopping is always a way back to a usable UI.
  stopCssCycles();
  anyPlaying = false;
  lastEvaluated = null;
  activeSliders = {};
  document.dispatchEvent(new CustomEvent('trussal-sliders-updated', { detail: [] }));
}

// Re-register local IDB samples with the already-loaded Strudel module.
// Call this after uploading new samples so they become available immediately
// without requiring a full page reload.
export async function refreshLocalSamples() {
  const mod = strudelMod;
  if (!mod || typeof mod.registerSampleSource !== 'function') return;
  await registerSamplesFromDB(mod.registerSampleSource).catch(e =>
    console.warn('[strudel] refreshLocalSamples failed', e)
  );
  // Images come from the same upload, so a refresh has to re-mint their URLs
  // too — otherwise a folder dropped in mid-set is playable but not drawable.
  await registerImagesFromDB().catch(e =>
    console.warn('[strudel] refreshing uploaded images failed', e)
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
  // Drop a departed peer's Delayed Streaming code history so it can't be
  // re-used if a fresh peer lands on the same key.
  if (event === 'peer-leave' && payload) forgetPeerCode(payload.peerId || payload.jitsiId);
  if (strudelBoot) rebuildAndEvaluate();
});

// Delayed Streaming: the text/CSS voices (and a remote peer's Hydra preamble)
// are built from each peer's code as it stood getStreamDelayMs() ago
// (delayedPeerView). A live room's metrics ticks re-stack often enough to walk
// that window forward, but a quiet roster might not, so nudge a rebuild once a
// second while the mode is warm. rebuildAndEvaluate dedups on the program text,
// so a tick that changes nothing is cheap.
setInterval(() => {
  if (strudelBoot && getAggregatorPeer() && isDelayedStreaming() && getStreamDelayMs() > 0) {
    rebuildAndEvaluate();
  }
}, 1000);

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

// JPattern: rebuild when the mode flips (gates injected/removed) and when
// the scheduler dequeues a buffer whose pattern differs from the live one.
document.addEventListener('trussal-jpattern-mode', () => {
  if (strudelBoot) rebuildAndEvaluate();
});
document.addEventListener('trussal-jpattern-apply', () => {
  if (strudelBoot) rebuildAndEvaluate();
});

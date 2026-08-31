/**
 * Code that runs INSIDE the bot's Chromium page.
 *
 * These are real function declarations, not code strings: Puppeteer
 * serializes a function passed to page.evaluate()/evaluateOnNewDocument()
 * and runs it in the page, passing arguments structurally. That means
 * Node's parser syntax-checks this file at load time, and per-bot data
 * (the varied script) travels as an argument instead of being spliced into
 * source text — no escaping bugs. They must therefore be self-contained:
 * they reference only page globals (window, document, navigator) and their
 * own parameters, never anything from this module's scope.
 *
 * Architecture: one page does everything. The bot navigates to the Jitsi
 * room; before navigation we install a getUserMedia override that hands
 * Jitsi a video track captured from the Hydra canvas (canvas.captureStream),
 * which is what the spec's --use-fake-device-for-media-stream flow needs to
 * show "the running Hydra pattern" as the bot's camera. The Strudel REPL is
 * then booted in the same page.
 *
 * Audio takes two paths from one source. pageAudioBridge taps Strudel's
 * WebAudio output and fans it out to BOTH (a) the page's default device — the
 * ALSA loopback → Jamulus, the original path — and (b) a MediaStreamDestination
 * that the getUserMedia override hands Jitsi as the bot's "microphone". So the
 * same music reaches Jamulus listeners and, now that the bot joins unmuted,
 * Jitsi listeners too.
 *
 * The gUM-handed "microphone" gets the bot a local audio track, but what the
 * track SENDS is replaced post-join by pageEnsureAudioPublished step 3: a
 * lib-jitsi-meet track effect whose output is the fan, connected directly
 * (mirroring the human client's NodeOutputEffect publish). The gUM tap remains
 * as bootstrap + fallback.
 *
 * Note: the admin page's per-bot code-inspector modal does NOT live here —
 * it is operator-facing UI served by the config API (admin.html), backed by
 * conductor state via GET /api/bots.
 */

/**
 * Audio tap, installed via evaluateOnNewDocument so it exists before Strudel
 * (or anything) creates an AudioContext. WebAudio nodes can't cross contexts
 * and a MediaStreamDestination needs a context, so we wrap the AudioContext
 * constructor: every `new AudioContext()` returns one shared instance whose
 * `.destination` is rerouted through a fan-out gain. The fan feeds both the
 * real hardware output (the ALSA loopback → Jamulus path) and a
 * MediaStreamDestination exposed as window.__trussalMicStream, which the
 * getUserMedia override publishes to Jitsi. The stream is live from page load,
 * so Jitsi's early gUM call gets a real track that starts carrying audio the
 * moment Strudel begins playing into the shared context.
 *
 * Only Strudel's WebAudio reaches the tap — Jitsi plays remote participants
 * through <audio> elements, not this context, so there is no echo back into
 * the conference.
 */
export function pageAudioBridge() {
  const Native = window.AudioContext || window.webkitAudioContext;
  if (!Native || Native.__trussalWrapped) return;

  // Build the shared context + tap LAZILY, on the first `new AudioContext()`,
  // rather than eagerly here. This function runs at document-start (before the
  // page navigates), and a context built then binds to the pre-navigation
  // origin: superdough's later `audioWorklet.addModule(<CDN url>)` silently
  // fails on it, leaving every synth/sample mute with no thrown error.
  // Deferring construction to the first real consumer builds the context
  // post-navigation, so worklet loading — and thus sound — works. Strudel,
  // Jitsi, and the gUM fallback all funnel through `new AudioContext()`, so
  // whoever asks first creates the one shared instance and its output lands on
  // our fan (→ hardware/Jamulus + the Jitsi tap).
  let shared = null;
  function build(args) {
    const ctx = new Native(...args);
    const hardware = ctx.destination; // real device → ALSA loopback → Jamulus
    const tap = ctx.createMediaStreamDestination(); // → Jitsi mic track
    const fan = ctx.createGain();
    fan.connect(hardware);
    fan.connect(tap);
    // superdough's multi-channel output controller reads
    // `audioContext.destination.maxChannelCount` and derives its channel
    // routing (ChannelMerger size, `ch % destination.channelCount`) from it.
    // Our fan is a GainNode and has no maxChannelCount, so that math collapsed
    // to NaN and silently routed every voice nowhere — no error, just silence.
    // Expose the real device's value so the routing resolves to stereo.
    fan.maxChannelCount = hardware.maxChannelCount || 2;
    Object.defineProperty(ctx, 'destination', {
      configurable: true,
      get: () => fan,
    });
    window.__trussalMicStream = tap.stream;
    // The fan carries ALL of this bot's audio (→ Jitsi tap AND → hardware/Jamulus),
    // so zeroing its gain is a complete mute of the bot from both paths. Exposed
    // for the studio's per-bot mute (driven via the peer-state bus → page event).
    window.__trussalFanGain = fan;
    // Output-level meter so metrics can report whether the bot is ACTUALLY making
    // sound. `schedulerStarted` (in pageReadSamples) only says the pattern loop is
    // running — it stays true through every silent-routing failure (superdough's
    // NaN channel math, a suspended context, a wrong-origin worklet), which is
    // exactly how a bot streams silence with no thrown error. Tap the fan's OUTPUT
    // (what feeds the Jitsi track AND the ALSA→Jamulus path) with an AnalyserNode:
    // it is a passive observer, so its own output need not be connected anywhere.
    const meter = ctx.createAnalyser();
    meter.fftSize = 2048;
    fan.connect(meter);
    // Report the PEAK RMS between reads, not one instantaneous sample: a sparse
    // pattern is silent between hits, so a single snapshot would false-report
    // silence. pageReadSamples reads-and-resets this each metrics tick, so a
    // nonzero value means "sound reached the output at some point this window".
    const sumSquares = (buf) => buf.reduce((acc, sample) => acc + sample ** 2, 0);
    const meterBuf = new Float32Array(meter.fftSize);
    let fanRmsPeak = 0;
    window.__trussalReadFanRms = () => { const peak = fanRmsPeak; fanRmsPeak = 0; return peak; };
    setInterval(() => {
      meter.getFloatTimeDomainData(meterBuf);
      const rms = Math.sqrt(sumSquares(meterBuf) / meterBuf.length);
      if (rms > fanRmsPeak) fanRmsPeak = rms;
    }, 200);
    // superdough derives its output channel routing from destination.maxChannelCount
    // (the very math the maxChannelCount fix above feeds); a surprising real-device
    // value is a candidate silence cause, so snapshot it for diag alongside fanRms.
    window.__trussalHardwareMaxChannelCount = hardware.maxChannelCount;
    // Headless bots make no user gesture. A normal bot's AudioContext is resumed
    // by the studio-toggle click; the aggregator boots no studio and clicks
    // nothing, so resume here. Even with --autoplay-policy=no-user-gesture-required
    // this matters: a suspended context runs neither the aggregator's capture
    // ScriptProcessor (no ingest) nor its playback ScriptProcessor (no output) —
    // the whole round trip goes silent. A failed resume means exactly that
    // silence, so log it and throw rather than swallow it: the rejection surfaces
    // as a page error the bot's error reporting picks up (conductor replace policy).
    if (ctx.state === 'suspended') {
      ctx.resume().catch((e) => {
        console.error('[trussal] AudioContext resume failed', e);
        throw e;
      });
    }
    return ctx;
  }

  function Wrapped(...args) { if (!shared) shared = build(args); return shared; }
  Wrapped.prototype = Native.prototype;
  Wrapped.__trussalWrapped = true;
  window.AudioContext = Wrapped;
  window.webkitAudioContext = Wrapped;
}

/**
 * Mark this page as a bot before the Trussal bundle loads, so peer-state.js
 * announces isBot:true in its hello. That lets the studio show + drive + mute
 * the bot's tile, and lets every client's combined-Strudel mix skip the bot
 * (its audio arrives via Jitsi, not the mix). Must run at document-start.
 */
export function pageMarkBot(ownerIndex) {
  window.__trussalIsBot = true;
  // Owner's room index (JPattern): peer-state.js sends it in the hello so
  // the sidecar assigns this bot a cluster index like 1a, 1b, …
  if (typeof ownerIndex === 'string' && ownerIndex) {
    window.__trussalBotOwnerIndex = ownerIndex;
  }
}

/**
 * Mark this page as the room's audio aggregator before the Trussal bundle
 * loads, so peer-state.js announces isAggregator:true in its hello. Every OTHER
 * client then silences all non-aggregator peers locally (latency-instrument),
 * leaving the aggregator's assembled master mix as the sole audio source. Runs
 * alongside pageMarkBot (the aggregator is also a bot). Must run at
 * document-start.
 */
export function pageMarkAggregator() {
  window.__trussalIsAggregator = true;
}

/**
 * Whether THIS aggregator page is the room's ACTIVE aggregator. Only one
 * aggregator may stream the master at a time — two publishing aggregators tap
 * and re-emit each other's mix, so both feed back and collapse to silence. The
 * Trussal bundle elects a single winner (see aggregator-election.js) and
 * exposes it as window.__trussalIsActiveAggregator;
 * the AggregatorBot polls this to gate its ingest/playback so a second
 * aggregator stands down. Before the bundle has loaded the election isn't known
 * yet — default to active so a lone aggregator (the common case) never waits.
 */
export function pageIsActiveAggregator() {
  return typeof window.__trussalIsActiveAggregator === 'function'
    ? !!window.__trussalIsActiveAggregator()
    : true;
}

/**
 * React to operator control from the studio (relayed over the peer-state bus,
 * surfaced by peer-state.js as DOM events):
 *   - trussal-remote-pattern: re-evaluate the bot's Strudel REPL with the edited
 *     code, recombined with the bot's original Hydra preamble unless the edit
 *     brings a preamble of its own.
 *   - trussal-remote-mute: zero/restore the shared audio fan gain, muting the
 *     bot on both the Jitsi and Jamulus paths at once.
 *   - trussal-remote-stop: a room-wide ■ Stop reaching this bot. Same fan gain
 *     as mute, but a SEPARATE gate multiplied in alongside it (applyFanGain)
 *     — this bot's own REPL is a standalone @strudel/repl instance the
 *     Studio's stopStrudel()/CRDT 'stop' broadcast never touches (see
 *     pageStrudelBoot), so this is the only signal that reaches it. Keeping
 *     it independent of the manual mute toggle means a Stop/Apply cycle can
 *     never clobber an operator's own deliberate per-bot mute, and unmuting
 *     one gate never un-stops the other.
 * Installed at document-start; it reads the editor/fan globals lazily at event
 * time, so ordering against pageStrudelBoot / pageAudioBridge doesn't matter.
 *
 * `preamblePatterns` carries the browser's own capability rules as JSON (see
 * INIT_HYDRA_PATTERN / INIT_TEXT_CYCLES_PATTERN). A bot's editor is editable in
 * every medium its human's is, so an edit that opens with `await initHydra(` or
 * `await initTextCycles(` REPLACES the bot's program wholesale — prepending the
 * bot's stored Hydra there would produce two preambles and a dead REPL. An edit
 * that is only Strudel still recombines, so tweaking a bot's audio doesn't
 * silently take away the visual it was given at spawn.
 *
 * `capabilityPatterns` ({word, css, initTextCycles, initCss}, each a
 * {source,flags} descriptor — same JSON-only constraint) is what a pushed edit
 * gets stripped of before this REPL ever sees it. The bot's own REPL is bare
 * vanilla @strudel/repl (see pageStrudelBoot) — word()/css()/their init calls
 * are undefined there, exactly why cluster-source.js's
 * dropTextStatements/dropCssStatements strip the same statements from a bot's
 * GENERATED script before it ever reaches this REPL. A manual edit skipped
 * that step entirely: pasting anything with a text/css voice (likely, since
 * it's naturally copied from a performer's own full-featured editor) threw on
 * evaluate() — silently now that the catch below no longer feeds healthTick,
 * which read as "the audio never follows what I typed." dropCapability below
 * mirrors dropCapabilityParagraphs' paragraph/label-line splitting AND its
 * stack()-sibling-salvage refinement (stripBranchesMatching there): the text
 * being edited here is a bot's own peer.pattern, which is exactly the
 * multi-voice cluster-authored shape that refinement exists for — a
 * performer routinely writes `stack(word("x"), s("bd sd"))` rather than
 * separate `$:` voices, and without the salvage the whole stack(), audio
 * sibling included, was dropped to 'silence' any time a bot's own tile was
 * pushed back unedited (or edited without touching the word()/css() voice).
 */
export function pageRemoteControl(preamblePatterns, capabilityPatterns) {
  const patterns = Array.isArray(preamblePatterns) ? preamblePatterns : [];
  const toRegex = (p) => {
    if (!p || typeof p.source !== 'string') return null;
    try {
      return new RegExp(p.source, p.flags || '');
    } catch (err) {
      // A malformed pattern must not silently disable remote editing.
      if (window.__trussalReportError) window.__trussalReportError(err);
      else console.error('[trussal] bad capability pattern', err);
      return null;
    }
  };
  const declaresOwnPreamble = (code) => patterns.some(({ source, flags }) => {
    const re = toRegex({ source, flags });
    return re ? re.test(code) : false;
  });
  // Mirrors src/hydra-code.js's INIT_HYDRA_RE/splitHydraCode verbatim (can't
  // import either in-page, same reason findStackCall/splitStackArgs below are
  // duplicated). A hardcoded local regex rather than reusing
  // declaresOwnPreamble/toRegex above: `patterns` also carries
  // INIT_TEXT_CYCLES_PATTERN (bot.js passes both — a self-describing Text
  // Cycles edit brings its own preamble too, for declaresOwnPreamble's
  // purposes below), which has no External Source calls to guard and would
  // wrap plain `silence`/Strudel text for nothing. Reusing toRegex would also
  // double-report an operator's malformed capability pattern, once from
  // declaresOwnPreamble's own check and again here.
  const INIT_HYDRA_RE = /^\s*await\s+initHydra\s*\(/;
  const HYDRA_RENDER_RE = /\.out\s*\(/;
  const hydraPreambleEnd = (text) => {
    const blanks = [...text.matchAll(/\n\n+/g)];
    if (!blanks.length) return text.length;
    let cut = blanks[0];
    for (let i = 1; i < blanks.length; i++) {
      const paragraph = text.slice(cut.index + cut[0].length, blanks[i].index);
      if (!HYDRA_RENDER_RE.test(paragraph)) break;
      cut = blanks[i];
    }
    return cut.index;
  };
  // Strudel's transpiler mini-notation-parses EVERY double-quoted string, so
  // a preamble's own s0.initImage("folder")/initVideo("url") needs the same
  // mini-off/mini-on guard pageStrudelBoot applies at boot — whether that
  // preamble is the bot's STORED one, or (the common case: studio.js seeds a
  // bot's remote-edit textarea with its WHOLE announced pattern, preamble
  // included, so a routine edit round-trips one right back here) embedded
  // directly in what was just pushed. No-ops on text with no Hydra preamble
  // of its own. Wrapping only the preamble prefix, not the whole text, is why
  // this can't just wrap unconditionally — the Strudel voice after it
  // legitimately needs mini notation.
  const wrapPreambleMini = (text) => {
    if (!INIT_HYDRA_RE.test(text)) return text;
    const end = hydraPreambleEnd(text);
    return `/* mini-off */\n${text.slice(0, end)}\n/* mini-on */${text.slice(end)}`;
  };

  const cap = capabilityPatterns || {};
  // The leading 'personal editor' / 'bot editor' directive a pushed edit
  // carries (studio seeds the textarea with the bot's whole announced program,
  // directive included). It is a bare string literal the bare REPL has no use
  // for — strip it exactly as the browser's normalizePeerCode does, using the
  // pattern the shared module handed over rather than a re-typed local copy.
  const directiveRe = cap.directive && typeof cap.directive.source === 'string'
    ? toRegex({ source: cap.directive.source, flags: (cap.directive.flags || '') + (String(cap.directive.flags || '').includes('m') ? '' : 'm') })
    : null;
  const stripDirectiveLine = (text) => (directiveRe ? String(text).replace(directiveRe, '') : text);
  const dropPairs = [
    [toRegex(cap.initTextCycles), toRegex(cap.word)],
    [toRegex(cap.initCss), toRegex(cap.css)],
  ].filter(([initRe, callRe]) => initRe && callRe);
  const LABEL_RE = /^\s*(?:\$|[a-zA-Z_$][\w$]*)\s*:/;
  const splitLabelUnits = (text) => {
    const lines = text.split('\n');
    const out = [];
    let cur = [];
    for (const line of lines) {
      if (LABEL_RE.test(line) && cur.length) { out.push(cur.join('\n')); cur = []; }
      cur.push(line);
    }
    if (cur.length) out.push(cur.join('\n'));
    return out;
  };
  // Mirrors cluster-source.js's findStackCall/splitStackArgs/
  // stripBranchesMatching verbatim — can't import it in-page (see the
  // file-level JSON-only note), so it's duplicated here rather than shared.
  const findStackCall = (text) => {
    const match = /(^|[^\w$.])stack\s*\(/.exec(text);
    if (!match) return null;
    const start = match.index + match[1].length;
    const open = text.indexOf('(', start);
    let depth = 0;
    let quote = null;
    for (let i = open; i < text.length; i++) {
      const ch = text[i];
      if (quote) {
        if (ch === '\\') { i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') {
        depth--;
        if (depth === 0) return { start, close: i, argsText: text.slice(open + 1, i) };
      }
    }
    return null; // unbalanced — leave the statement to the whole-statement fallback
  };
  const splitStackArgs = (argsText) => {
    const args = [];
    let depth = 0;
    let quote = null;
    let cur = '';
    for (let i = 0; i < argsText.length; i++) {
      const ch = argsText[i];
      if (quote) {
        cur += ch;
        if (ch === '\\') { cur += argsText[i + 1] ?? ''; i++; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') { quote = ch; cur += ch; continue; }
      if (ch === '(' || ch === '[' || ch === '{') { depth++; cur += ch; continue; }
      if (ch === ')' || ch === ']' || ch === '}') { depth--; cur += ch; continue; }
      if (ch === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
      cur += ch;
    }
    if (cur.trim() !== '') args.push(cur);
    return args;
  };
  const stripBranchesMatching = (text, callRe) => {
    const call = findStackCall(text);
    if (!call) return null;
    const survivors = splitStackArgs(call.argsText)
      .filter((arg) => !callRe.test(arg))
      .map((arg) => arg.trim())
      .filter(Boolean);
    if (!survivors.length) return null;
    const rebuilt = `stack(\n  ${survivors.join(',\n  ')}\n)`;
    return text.slice(0, call.start) + rebuilt + text.slice(call.close + 1);
  };
  const dropCapability = (src, initRe, callRe) => {
    if (!initRe.test(src) && !callRe.test(src)) return src;
    const dropChunk = (chunk) => {
      const stripped = stripBranchesMatching(chunk, callRe);
      if (stripped !== null) return stripped;
      // No stack() to salvage a sibling from: drop the whole chunk only if IT
      // is what declares or calls this capability.
      if (initRe.test(chunk) || callRe.test(chunk)) return null;
      return chunk;
    };
    const kept = src.split(/\n\n+/).map((paragraph) => {
      if (!paragraph.trim()) return null;
      const survivors = splitLabelUnits(paragraph)
        .map(dropChunk)
        .filter((c) => c !== null);
      return survivors.length ? survivors.join('\n') : null;
    }).filter((p) => p !== null);
    return kept.join('\n\n').trim();
  };
  // Strip BEFORE joining with the stored hydra preamble, not after: that join
  // is a bare ';\n' rather than a blank line, so a paragraph/label split run
  // on the already-combined text could merge the hydra preamble into a
  // dropped unit whenever the pushed audio has no blank-line separation of
  // its own from a leading word()/css() statement.
  const forBotRepl = (pushed) => {
    let out = pushed;
    for (const [initRe, callRe] of dropPairs) out = dropCapability(out, initRe, callRe);
    return out.trim() ? out : 'silence';
  };

  document.addEventListener('trussal-remote-pattern', async (e) => {
    const raw = e && e.detail && e.detail.code;
    if (typeof raw !== 'string') return;
    const pushed = stripDirectiveLine(raw);
    const editor = window.__trussalStrudelEditor;
    const ed = editor && editor.editor;
    const hydra = window.__trussalHydra || '';
    // The bot announces its WHOLE program (preamble, blank line, Strudel) so
    // the aggregator can give it a mosaic cell, which means what an operator
    // edits in the studio is that whole program — prepending the stored
    // preamble to it would evaluate two of them.
    const ownPreamble = declaresOwnPreamble(pushed);
    const playable = forBotRepl(pushed);
    // wrapPreambleMini no-ops on text with no HYDRA preamble of its own (a
    // Text-Cycles-only self-describing edit still takes the `ownPreamble`
    // branch below but has nothing for it to wrap), so this covers both
    // shapes uniformly: `playable` when the push carries its own preamble
    // (the common case — see the comment above), `hydra` when it doesn't and
    // the stored one is prepended instead.
    const code = ownPreamble
      ? wrapPreambleMini(playable)
      : (hydra ? `${wrapPreambleMini(hydra)};\n${playable}` : playable);
    // Once an edit brings its own preamble, the pushed text is the whole
    // program and the spawn-time Hydra is no longer part of it. Forget it, so a
    // later audio-only edit doesn't resurrect a visual the operator replaced.
    if (ownPreamble) window.__trussalHydra = '';
    try {
      // pageStrudelBoot runs this same registration once before its FIRST
      // evaluate(), and its own comment documents exactly why a re-eval needs
      // it too: a synth/sample this REPL hasn't loaded yet fails PER-TRIGGER
      // inside Strudel's own trigger code — no thrown error, the scheduler
      // still starts, fanRms just stays 0 for that voice (confirmed live:
      // s("sine")→s("supersaw") went silent until loadWorklets() ran). The
      // spawn-time registration only ever covers what the bot's ORIGINAL
      // script happened to name; an edit naming anything else — a different
      // synth, a sample bank not in the owner's registered set — hits this
      // exact gap. All of these are idempotent against what boot already
      // registered, so re-calling them on every edit is safe.
      const loadWorklets = window.loadWorklets || (window.strudel && window.strudel.loadWorklets);
      const registerSynths = window.registerSynthSounds || (window.strudel && window.strudel.registerSynthSounds);
      const registerZzfx = window.registerZZFXSounds || (window.strudel && window.strudel.registerZZFXSounds);
      const registerFonts = window.registerSoundfonts || (window.strudel && window.strudel.registerSoundfonts);
      await Promise.all([
        typeof loadWorklets === 'function' ? loadWorklets() : null,
        typeof registerSynths === 'function' ? registerSynths() : null,
        typeof registerZzfx === 'function' ? registerZzfx() : null,
        typeof registerFonts === 'function' ? registerFonts() : null,
      ]).catch((err) => console.error('[trussal] re-registering synth capabilities before remote eval failed', err));
      const registerSample = window.registerSampleSource || (window.strudel && window.strudel.registerSampleSource);
      if (typeof registerSample === 'function') {
        const banks = window.__trussalSamples || {};
        for (const [bank, urls] of Object.entries(banks)) {
          if (Array.isArray(urls) && urls.length) {
            try { registerSample(bank, urls, { prebake: false }); } catch (err) {
              console.error('[trussal] re-registering sample bank before remote eval failed', bank, err);
            }
          }
        }
      }
      if (ed && typeof ed.setCode === 'function') {
        ed.setCode(code);
        if (typeof ed.evaluate === 'function') await ed.evaluate();
      } else if (editor && typeof editor.setAttribute === 'function') {
        editor.setAttribute('code', code);
        if (ed && typeof ed.evaluate === 'function') await ed.evaluate();
      }
    } catch (err) {
      // Deliberately NOT window.__trussalReportError: that array feeds
      // healthTick's "bot executed syntactically incorrect code → terminate
      // and replace" policy (see pageStrudelBoot), meant for a broken SPAWN
      // script — a fleet-generation bug worth killing the bot over. An
      // operator's live edit throwing (routine — the bot's REPL is bare
      // vanilla @strudel/repl with no Trussal capabilities registered, so
      // anything using word()/css()/botConfig()/data-pack refs/etc. throws)
      // is not that: reporting it there got the bot replaced within one
      // healthTick (5s), silently discarding the edit and restoring the
      // fleet-generated script — reading as "pasted code immediately
      // reverts" with the edit never actually rejected, just erased.
      console.error('[trussal] remote pattern eval failed', err);
    }
  });
  // Two independent boolean gates multiplied into one gain value, so muting
  // and stopping never fight each other regardless of order or combination.
  let __trussalMuteGate = 1;
  let __trussalStopGate = 1;
  const applyFanGain = () => {
    const fan = window.__trussalFanGain;
    if (fan && fan.gain) { try { fan.gain.value = __trussalMuteGate * __trussalStopGate; } catch (_) {} }
  };
  document.addEventListener('trussal-remote-mute', (e) => {
    __trussalMuteGate = (e && e.detail && e.detail.muted) ? 0 : 1;
    applyFanGain();
  });
  document.addEventListener('trussal-remote-stop', (e) => {
    __trussalStopGate = (e && e.detail && e.detail.stopped) ? 0 : 1;
    applyFanGain();
  });
  // The bot's owner turning its tile on or off. A regular bot joins muted
  // (videoMuted: true), exactly like a human joins with startWithVideoMuted —
  // so the very same single conf.muteVideo() call a human's own toolbar
  // camera button makes is enough here too: lib-jitsi-meet acquires the
  // (canvas-backed, via pageGumOverride) track on the first unmute and just
  // flips the existing track's mute state on every toggle after that. No
  // bespoke publish/fallback path, and no separate on/off code shapes to
  // drift out of sync with each other.
  document.addEventListener('trussal-remote-video', async (e) => {
    const on = !!(e && e.detail && e.detail.videoOn);
    try {
      const conf = window.APP && window.APP.conference;
      if (!conf || typeof conf.muteVideo !== 'function') return;
      const withGum = window.__trussalWithGumForJitsi || ((fn) => fn());
      await withGum(async () => {
        await conf.muteVideo(!on);
        // conf.muteVideo() resolving does not mean the gUM call it can
        // trigger has actually fired yet — pageInstallVideoPublisher's own
        // poll loop exists for the exact same gap (its comment there has the
        // full reasoning). Only relevant when turning ON: muting never
        // acquires a track, so there is nothing to wait for.
        if (on) {
          const room = () => conf._room || conf.room;
          const localTrack = () => {
            try { const r = room(); return r && r.getLocalVideoTrack && r.getLocalVideoTrack(); }
            catch (_) { return null; }
          };
          for (let i = 0; i < 20 && !localTrack(); i++) await new Promise((res) => setTimeout(res, 150));
        }
      });
    } catch (err) {
      if (window.__trussalReportError) window.__trussalReportError(err);
      else console.error('[trussal] bot video toggle failed', err);
    }
  });
}

/**
 * Force `preserveDrawingBuffer: true` on every WebGL context, installed via
 * evaluateOnNewDocument so it is in place before Strudel's initHydra() creates
 * the Hydra canvas. Hydra builds its WebGL context with the default
 * preserveDrawingBuffer: false, and captureStream() of such a canvas yields
 * black/empty frames (the drawing buffer is cleared after each composite) — so
 * the bot published a live video track that carried no frames. Preserving the
 * buffer makes the canvas capturable.
 */
export function pageForcePreserveDrawingBuffer() {
  const proto = HTMLCanvasElement.prototype;
  const orig = proto.getContext;
  if (!orig || orig.__trussalWrapped) return;
  const wrapped = function (type, attrs) {
    if (type === 'webgl' || type === 'webgl2' || type === 'experimental-webgl') {
      return orig.call(this, type, Object.assign({}, attrs, { preserveDrawingBuffer: true }));
    }
    return orig.call(this, type, attrs);
  };
  wrapped.__trussalWrapped = true;
  proto.getContext = wrapped;
}

/**
 * getUserMedia override, installed via evaluateOnNewDocument so it exists
 * before Jitsi's first device enumeration. Video requests resolve to a
 * FIXED-size canvas that mirrors the Hydra/mosaic output (see
 * ensurePublishCanvas below — never the source canvas directly); audio
 * requests resolve to the Strudel tap from pageAudioBridge (falling back to
 * silence if the bridge is unavailable).
 *
 * videoHeight matches the SAME default (360, 16:9) published-video.js uses
 * for human clients' compositor, so a bot's tile is the same size as a
 * human's unless the deployment overrides JITSI_VIDEO_HEIGHT.
 */
export function pageGumOverride(captureFps = 15, videoHeight = 360) {
  const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  const pubHeight = Math.max(2, Math.round(videoHeight));
  const pubWidth = Math.round((pubHeight * 16) / 9 / 2) * 2;

  function hydraCanvas() {
    // The aggregator publishes its composited mosaic, never a single Hydra
    // canvas — and its per-cell canvases are each as large as the output, so
    // the largest-canvas fallback below would pick an arbitrary cell. Match
    // the mosaic first; on a regular bot (no mosaic installed) this misses and
    // the Strudel REPL's own initHydra() canvas wins as before.
    const mosaic = document.querySelector('canvas#trussal-mosaic-out');
    if (mosaic) return mosaic;
    // initHydra() in the Strudel REPL creates a canvas; prefer one it tagged,
    // fall back to the largest canvas in the page.
    const tagged = document.querySelector('canvas#hydra-canvas, canvas.hydra-canvas');
    if (tagged) return tagged;
    const all = [...document.querySelectorAll('canvas')];
    return all.sort((a, b) => b.width * b.height - a.width * a.height)[0] || null;
  }

  function waitForCanvas() {
    return new Promise((resolve) => {
      // Bounded: an audio-only bot (no Hydra preamble at all) never gets a
      // #hydra-canvas, and neither does a mosaic-less regular bot before
      // pageStrudelBoot's initHydra() has run yet. Resolving anyway once the
      // deadline passes just means ensurePublishCanvas() starts capturing a
      // black canvas — drawPublishFrame's own rAF loop re-checks
      // hydraCanvas() every frame after that regardless, so nothing is lost
      // by not waiting forever; an unbounded wait, by contrast, would hang
      // this whole async function forever, which — now that a caller can be
      // running inside the __trussalGumForJitsi bracket below — would leave
      // that counter stuck incremented for the rest of the page's life.
      const deadline = Date.now() + 10000;
      const tick = () => {
        const c = hydraCanvas();
        if (c || Date.now() > deadline) resolve(c); else setTimeout(tick, 250);
      };
      tick();
    });
  }

  // Shared by every page-side caller that publishes THIS bot's own tile
  // (pageInstallVideoPublisher, pageRemoteControl's video toggle): marks the
  // gUM their own call triggers as "ours" so the video branch below hands
  // back the mirrored canvas instead of treating it as a copied preamble's
  // own s0-s3 External Source call. A counter, not a boolean: two overlapping
  // legitimate calls (e.g. two video-toggle events in quick succession) must
  // not have one's completion clear the marker while the other's own
  // internal gUM is still in flight — that would misroute the still-pending
  // one to the real fake-device camera, publishing it to the room raw.
  window.__trussalGumForJitsi = window.__trussalGumForJitsi || 0;
  window.__trussalWithGumForJitsi = async function withGumForJitsi(fn) {
    window.__trussalGumForJitsi++;
    try {
      return await fn();
    } finally {
      window.__trussalGumForJitsi = Math.max(0, window.__trussalGumForJitsi - 1);
    }
  };

  // A copied preamble's own s0-s3 External Source call (initCam/initScreen)
  // has no camera or screen of its own to satisfy. The aggregator's mosaic
  // answers the exact same situation by blitting the ORIGINATING peer's own
  // published video track instead of trying to reproduce it locally
  // (src/hydra-code.js's usesExternalSource — the same rule bots/src/bot/
  // index.js used to decide THIS bot needs inbound video at all, since a
  // regular bot otherwise joins with channelLastN=0). Do the same here:
  // window.__trussalBotOwnerIndex (pageMarkBot) names the spawning human's
  // JPattern room-index token; window.__trussalJitsiIdForRoomIndex is the
  // Trussal bundle's own reverse lookup (src/index.js) — this bot's page
  // navigated to the same Jitsi room URL a human does, so the full bundle,
  // roomMapper included, is already running here alongside the bare REPL.
  async function ownerVideoStream() {
    const ownerIndex = window.__trussalBotOwnerIndex;
    const resolveJitsiId = window.__trussalJitsiIdForRoomIndex;
    if (!ownerIndex || typeof resolveJitsiId !== 'function') return null;
    const jitsiId = resolveJitsiId(ownerIndex);
    if (!jitsiId) return null;

    // JVB only forwards a remote participant's video to a receiver that has
    // asked for it — normally driven by jitsi-meet's own tile-grid
    // visibility, which this page never mounts. Same fix the aggregator's
    // mosaic needed (2f17129/d8bb978): ask explicitly, and keep re-asserting
    // it on every retry tick since lib-jitsi-meet no-ops an unchanged
    // constraints object, so a call that raced the bridge channel not being
    // ready yet just gets retried for free.
    const ensureReceiverConstraints = (room) => {
      try {
        if (typeof room.setReceiverConstraints === 'function') {
          room.setReceiverConstraints({ defaultConstraints: { maxHeight: 360 }, lastN: -1 });
        } else if (typeof room.setReceiverVideoConstraint === 'function') {
          room.setReceiverVideoConstraint(360);
        }
      } catch (e) {
        console.error('[trussal] owner video: receiver constraints failed', e);
      }
    };

    // Bounded: the owner may not have published video yet (still joining,
    // their own video toggled off) by the moment this preamble's initCam()
    // fires. Poll rather than give up on the first miss — same reasoning as
    // waitForCanvas above — and fall through to the caller's own fallback
    // once the deadline passes rather than hang forever.
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const conf = window.APP && window.APP.conference;
      const room = conf && (conf._room || conf.room);
      if (room && typeof room.getParticipants === 'function') {
        ensureReceiverConstraints(room);
        const participant = room.getParticipants().find((p) => p.getId() === jitsiId);
        const track = participant && typeof participant.getTracks === 'function'
          ? participant.getTracks().find((t) => t.getType() === 'video')
          : null;
        const stream = track && typeof track.getOriginalStream === 'function'
          ? track.getOriginalStream()
          : null;
        if (stream && stream.getVideoTracks().length) return stream;
      }
      await new Promise((res) => setTimeout(res, 500));
    }
    return null;
  }

  function silentAudioTrack() {
    const ctx = new AudioContext();
    const dst = ctx.createMediaStreamDestination();
    ctx.createGain().connect(dst); // zero-input gain node = silence
    return dst.stream.getAudioTracks()[0];
  }

  // strudel-fork's getDrawContext() resizes #hydra-canvas to
  // window.innerWidth/innerHeight on every `resize` event, so publishing it
  // directly makes a bot's video track change resolution mid-call — every
  // viewer's grid then resizes that tile. Human clients never hit this
  // because published-video.js composites through a fixed canvas instead of
  // publishing #hydra-canvas raw; mirror that here so a bot's published
  // resolution never changes after the track is created.
  let publishCanvas = null;
  let publishCtx = null;

  function ensurePublishCanvas() {
    if (publishCanvas) return publishCanvas;
    publishCanvas = document.createElement('canvas');
    publishCanvas.width = pubWidth;
    publishCanvas.height = pubHeight;
    // A detached (never-appended) canvas is not guaranteed to actually
    // produce captureStream() frames — same reasoning as published-video.js's
    // ensureCanvas. Kept out of sight but composited: off-screen, not
    // display:none.
    publishCanvas.style.cssText = 'position:fixed;left:-20000px;top:0;pointer-events:none;';
    (document.body || document.documentElement).appendChild(publishCanvas);
    publishCtx = publishCanvas.getContext('2d');
    drawPublishFrame();
    return publishCanvas;
  }

  function drawPublishFrame() {
    requestAnimationFrame(drawPublishFrame);
    const source = hydraCanvas();
    publishCtx.fillStyle = '#000';
    publishCtx.fillRect(0, 0, pubWidth, pubHeight);
    if (!source || !source.width || !source.height) return;
    const scale = Math.min(pubWidth / source.width, pubHeight / source.height);
    const w = source.width * scale;
    const h = source.height * scale;
    try {
      publishCtx.drawImage(source, (pubWidth - w) / 2, (pubHeight - h) / 2, w, h);
    } catch (e) {
      // A source canvas mid-teardown throws; the next frame picks up the new one.
      console.error('[trussal] could not draw the bot\'s source canvas', e);
    }
  }

  navigator.mediaDevices.getUserMedia = async (constraints = {}) => {
    const stream = new MediaStream();
    if (constraints.video) {
      // Two different callers ask for `video` here: jitsi-meet publishing
      // THIS bot's own tile (wants the mirrored canvas below — see
      // pageInstallVideoPublisher/pageRemoteControl's video toggle, which
      // route their own calls through __trussalWithGumForJitsi above), and a
      // copied preamble's own s0-s3 .initCam() (hydra-source.js calling
      // straight into this same global, same as it does in a real browser).
      // Handing the second one the self-mirrored canvas is a feedback loop:
      // the canvas starts black, and black fed back into itself stays black
      // forever — the bot's own s0 has nothing else to draw. Treat any
      // unbracketed video request as an External Source: give it the
      // spawning human's own published video (ownerVideoStream — the same
      // blit the aggregator's mosaic does for a camera-fed cell), falling
      // back to Chromium's real --use-fake-device-for-media-stream camera
      // only if that peer has no video to blit (never published, or the
      // bot has no resolvable owner at all — e.g. `random: "full"`, which
      // replaces the human's code outright and was never a copy of anyone's
      // camera use to begin with). Only the video half is redirected this
      // way — audio (below) always goes through our own tap regardless, so
      // a request bundling both never loses its mic half to this branch.
      if (!(window.__trussalGumForJitsi > 0)) {
        const owned = await ownerVideoStream();
        if (owned) {
          for (const t of owned.getVideoTracks()) stream.addTrack(t);
        } else {
          for (const t of (await realGUM({ ...constraints, audio: false })).getVideoTracks()) stream.addTrack(t);
        }
      } else {
        await waitForCanvas();
        // captureFps is a bandwidth guard: 15 fps halves encode + uplink cost
        // vs 30 with little visual loss for slow-evolving Hydra patterns.
        for (const t of ensurePublishCanvas().captureStream(captureFps).getVideoTracks()) stream.addTrack(t);
      }
    }
    if (constraints.audio) {
      const mic = window.__trussalMicStream;
      const tapTrack = mic && mic.getAudioTracks()[0];
      stream.addTrack(tapTrack || silentAudioTrack());
    }
    return stream.getTracks().length ? stream : realGUM(constraints);
  };

  // Hydra's s0.initScreen() reaches straight for getDisplayMedia
  // (lib/screenmedia.js) — a completely different API this override never
  // touched. A headless bot has no real desktop to share; an unpatched call
  // just rejects in this environment (screenmedia.js swallows the error) and
  // leaves that source permanently black. Same fallback chain as initCam:
  // the owner's own published video first (whatever they are actually
  // showing — this page cannot tell initScreen apart from initCam any more
  // than the aggregator's mosaic can), then the synthetic camera.
  navigator.mediaDevices.getDisplayMedia = async () => (await ownerVideoStream()) || realGUM({ video: true });
}

/**
 * After the bot has joined, make sure its Strudel-tap audio is actually
 * published as a live, unmuted local track. Setting startWithAudioMuted=false
 * is not enough on its own — lib-jitsi-meet does not always create an initial
 * audio track headlessly — so we drive the jitsi-meet API directly: ask it to
 * unmute (which acquires a track via our gUM → tap), and if that leaves no
 * track, create one explicitly and hand it to the conference.
 */
export async function pageEnsureAudioPublished() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const APP = globalThis.APP;
    const conf = APP && APP.conference;
    if (!conf) return;
    const room = () => conf._room || conf.room;
    const localTrack = () => {
      try {
        const r = room();
        return r && r.getLocalAudioTrack && r.getLocalAudioTrack();
      } catch (e) {
        console.error('[trussal] getLocalAudioTrack failed', e);
        throw e;
      }
    };

    // The published track is only ever as live as window.__trussalMicStream (the
    // fan tap in pageAudioBridge). A normal bot's Strudel boot creates the shared
    // AudioContext before we get here, so that tap already exists. The aggregator
    // boots no Strudel, and nothing else has built the context yet at this point,
    // so the gUM override below would find no tap and fall back to a permanently
    // silent track — the bot would publish silence forever. Build the shared
    // context now (pageAudioBridge wraps the constructor, so this creates the fan
    // + __trussalMicStream). No-op for a normal bot: its context already exists.
    // A failure here means the bot can only ever publish silence, so log + throw.
    if (!window.__trussalMicStream) {
      try {
        new (window.AudioContext || window.webkitAudioContext)();
      } catch (e) {
        console.error('[trussal] failed to build shared AudioContext for mic tap', e);
        throw e;
      }
    }

    // 1) Ask jitsi-meet to unmute; if it had no/muted track this triggers a
    //    gUM (→ our tap) and publishes it.
    if (typeof conf.muteAudio === 'function') {
      try { await conf.muteAudio(false); } catch (e) {}
      await sleep(1500);
    }

    // 2) Make sure the PUBLISHED track is the live fan tap, not a silent
    //    fallback. Jitsi's join-time gUM can fire before the shared AudioContext
    //    exists; at that instant window.__trussalMicStream is undefined, so the
    //    gUM override hands out silentAudioTrack(). That silent track gets
    //    published and — because a track now EXISTS — the old `!localTrack()`
    //    guard skipped this step, so the bot streamed silence forever even after
    //    the fan came alive (fanRms>0, yet JVB discards every packet as silence).
    //    Rebind whenever the current local track is absent OR is not the tap's
    //    MediaStreamTrack; createLocalTracks(['audio']) runs through our gUM
    //    override → the now-live tap. Idempotent: a healthy bot already publishing
    //    the tap satisfies publishingTap and skips the rebind.
    const tapTrack = window.__trussalMicStream && window.__trussalMicStream.getAudioTracks()[0];
    const current = localTrack();
    const currentMst = current && typeof current.getTrack === 'function' ? current.getTrack() : null;
    const publishingTap = Boolean(tapTrack && currentMst && currentMst === tapTrack);
    // A track already carrying the direct-tap effect (step 3) is publishing
    // correctly even though its MediaStreamTrack is the effect's output, not the
    // gUM tap — rebinding it would replace the effect-carrying track with a fresh
    // effect-less one and undo step 3 on every later call (the aggregator retries
    // this function).
    const directTapLive = Boolean(window.__trussalDirectTapEffect && current
      && window.__trussalDirectTapEffect.track === current);
    if (!publishingTap && !directTapLive && window.JitsiMeetJS && typeof window.JitsiMeetJS.createLocalTracks === 'function') {
      try {
        const tracks = await window.JitsiMeetJS.createLocalTracks({ devices: ['audio'] });
        const at = tracks && tracks[0];
        if (at) {
          if (typeof conf.useAudioStream === 'function') await conf.useAudioStream(at);
          else { const r = room(); if (r && r.addTrack) await r.addTrack(at); }
        }
      } catch (e) {}
    }

    // 3) Tap Strudel DIRECTLY onto the published track via lib-jitsi-meet's
    //    track-effect API — the same mechanism the human client's aggregator-mode
    //    publish uses (NodeOutputEffect in src/latency-instrument.js), the one
    //    publish path proven live to carry Strudel audibly. The minimal repro
    //    behind 12d2e74 showed the raw WebAudio→PeerConnection path carries the
    //    worklet audio in every bot condition, so the silence lives in how
    //    lib-jitsi-meet treats a gUM-handed "microphone" track; setEffect hands
    //    the library a stream through its own supported pipeline instead, and the
    //    library re-wires the sender itself across P2P/JVB flips and
    //    renegotiations. The fan is the tap point: all of superdough's output
    //    lands on it (destination override in pageAudioBridge), it feeds fanRms,
    //    and zeroing it still mutes this path and Jamulus together.
    const fan = window.__trussalFanGain;
    if (!fan) {
      // The shared-context build above guarantees the fan; missing means
      // pageAudioBridge never installed — the bot can only publish the raw gUM
      // track, so surface it.
      const err = new Error('direct Strudel tap: fan gain missing (pageAudioBridge not installed?)');
      console.error('[trussal]', err);
      throw err;
    }

    // Attach (or re-attach) the direct tap to whatever track is published.
    // Resolves true when the given track carries the effect afterwards.
    async function attachDirectTap(publishedTrack) {
      const attached = window.__trussalDirectTapEffect;
      if (attached && attached.track === publishedTrack) return true; // already live
      if (typeof publishedTrack.setEffect !== 'function') {
        console.error('[trussal] direct Strudel tap: local track has no setEffect API');
        return false;
      }
      // Re-attaching to a NEW track (post-rebind or post-renegotiation): drop
      // the old effect's fan connection so the fan doesn't accumulate dangling
      // destinations.
      if (attached && attached.effect && typeof attached.effect.stopEffect === 'function') {
        try { attached.effect.stopEffect(); } catch (_) {}
      }
      const dest = fan.context.createMediaStreamDestination();
      const effect = {
        isEnabled: () => true,
        // The mic stream argument is ignored — the effect's output is exactly the
        // fan (Strudel), mirroring NodeOutputEffect. Duplicate connect() calls
        // between the same nodes are ignored per the WebAudio spec, so a
        // stop/start cycle (jitsi mute flips) is safe.
        startEffect() { fan.connect(dest); return dest.stream; },
        stopEffect() { try { fan.disconnect(dest); } catch (_) {} },
      };
      await publishedTrack.setEffect(effect);
      window.__trussalDirectTapEffect = { track: publishedTrack, effect };
      return true;
    }

    // Watchdog: a renegotiation (the P2P↔JVB flip when the room crosses 2→3
    // participants, a device change) can replace the published JitsiLocalTrack;
    // the effect then rides the dead old object and the bot is back on the
    // known-silent gUM path — for the aggregator that silences the master and
    // mutes the whole room (its mic tile shows the slash a silent track earns).
    // Re-assert the tap whenever the current track stops being the one the
    // effect is attached to. Page-side (not a Node loop) so it works identically
    // for player bots and the aggregator; installed once, BEFORE the first
    // attach attempt, so even a throwing first attach self-heals.
    if (!window.__trussalDirectTapWatchdog) {
      window.__trussalDirectTapWatchdog = setInterval(() => {
        if (window.__trussalDirectTapAttaching) return; // re-attach still in flight
        const current = localTrack();
        const attached = window.__trussalDirectTapEffect;
        if (!current || (attached && attached.track === current)) return;
        console.warn('[trussal] direct Strudel tap: published track changed — re-attaching');
        window.__trussalDirectTapAttaching = true;
        attachDirectTap(current)
          .catch((e) => console.error('[trussal] direct tap re-attach failed', e))
          .finally(() => { window.__trussalDirectTapAttaching = false; });
      }, 1000);
    }

    const publishedTrack = localTrack();
    if (!publishedTrack) {
      // muteAudio + createLocalTracks both failed to produce a track — that IS
      // the silent-bot bug, so log it (the aggregator's caller retries, and the
      // watchdog above attaches the tap the moment a track appears).
      console.error('[trussal] direct Strudel tap: no local audio track to attach to');
      return;
    }
    try {
      await attachDirectTap(publishedTrack);
    } catch (e) {
      // A failed attach leaves the bot on the gUM tap path — the known-silent
      // one — so surface it loudly (the outer catch re-throws to the Node side);
      // the watchdog keeps retrying behind it.
      console.error('[trussal] direct Strudel tap setEffect failed', e);
      throw e;
    }
  } catch (e) {
    // Don't swallow: the inner steps (getLocalAudioTrack, the shared-context
    // build) log + throw on failure, and this is where those land. Re-throw so
    // the failure reaches the caller's .catch instead of dying silently here —
    // a silently-failed publish is exactly the "bot streams silence" bug.
    console.error('[trussal] pageEnsureAudioPublished failed', e);
    throw e;
  }
}

/**
 * Install the video publisher as a page global, at document-start.
 *
 * Publishing has to be reachable from INSIDE the page, not just from Node:
 * bots now join dark, and their owner turning the tile on arrives as a
 * peer-state DOM event that pageRemoteControl handles in-page. Node still
 * drives it too (the aggregator publishes its mosaic at startup), so both
 * callers share this one implementation rather than each carrying a copy.
 */
export function pageInstallVideoPublisher() {
  if (window.__trussalEnsureVideoPublished) return;

  /**
   * Make sure the page's canvas is actually published as a live video track
   * (the bot's "camera": its Hydra canvas, or the aggregator's mosaic).
   * startWithVideoMuted=false is not enough headlessly — lib-jitsi-meet never
   * requests the camera on its own (gUM is only ever called for audio), so the
   * canvas stream from the gUM override is never published and the tile stays
   * blank. Drive jitsi-meet directly: ask it to unmute video (which triggers a
   * gUM → our canvas override), falling back to creating the track explicitly.
   */
  window.__trussalEnsureVideoPublished = async function ensureVideoPublished() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const APP = globalThis.APP;
    const conf = APP && APP.conference;
    if (!conf) return;
    const room = () => conf._room || conf.room;
    const localTrack = () => { try { const r = room(); return r && r.getLocalVideoTrack && r.getLocalVideoTrack(); } catch (e) { return null; } };

    // Already publishing — nothing to do. Without this, a toggle landing
    // while a track is already live (e.g. a second click, or this same call
    // re-entering) falls through to step 2 and creates a SECOND track on top
    // of the first, forcing jitsi-meet to replace one SSRC with another —
    // visible to every viewer as the tile dropping to its avatar placeholder
    // and back (the "expands then contracts" glitch).
    if (localTrack()) return;

    // Marks this function's own internal gUM as publishing the bot's OWN
    // tile (see pageGumOverride) rather than a copied preamble's own s0-s3
    // External Source call.
    const withGum = window.__trussalWithGumForJitsi || ((fn) => fn());
    await withGum(async () => {
      // 1) Ask jitsi-meet to unmute video; if it had no/muted track this
      //    triggers a gUM (→ our Hydra canvas stream) and publishes it. Poll
      //    for the resulting track rather than a fixed sleep: a wait shorter
      //    than the real renegotiation lets step 2 fire while step 1's
      //    publish is still in flight, which is the same double-track race
      //    described above.
      if (typeof conf.muteVideo === 'function') {
        try { await conf.muteVideo(false); } catch (e) {console.error("Failed to start video")}
        for (let i = 0; i < 20 && !localTrack(); i++) await sleep(150);
      }

      // 2) Fallback: explicitly create the video track and attach it.
      //    createLocalTracks(['video']) runs through our gUM override → canvas.
      if (!localTrack() && window.JitsiMeetJS && typeof window.JitsiMeetJS.createLocalTracks === 'function') {
        try {
          const tracks = await window.JitsiMeetJS.createLocalTracks({ devices: ['video'] });
          const vt = tracks;
          if (vt) {
            if (typeof conf.useVideoStream === 'function') await conf.useVideoStream(vt);
            else { const r = room(); if (r && r.addTrack) await r.addTrack(vt); }
          }
        } catch (e) {console.error(e)}
      }
    });
  } catch (e) {console.error(e)}
  };
}

/**
 * Node-side entry: publish the page's canvas as a video track. Thin, because
 * the implementation is the page global above — the in-page toggle path calls
 * the very same function, so a fix to one can never miss the other.
 */
export async function pageEnsureVideoPublished() {
  if (typeof window.__trussalEnsureVideoPublished !== 'function') {
    console.error('[trussal] video publisher not installed — pageInstallVideoPublisher must run at document-start');
    return;
  }
  return window.__trussalEnsureVideoPublished();
}

/**
 * Boots the Strudel REPL (web build from the CDN) inside the current page
 * and evaluates the bot's varied code (passed as the argument — Puppeteer
 * delivers it structurally). Runtime evaluation errors are pushed to
 * window.__trussalReportError, which the Node side polls and forwards to
 * the conductor — that is the trigger for the "bot executed syntactically
 * incorrect code → terminate and replace" policy when an error slips past
 * static validation.
 */
export async function pageStrudelBoot({ strudel, hydra, announceStrudel, samples }) {
  window.__trussalErrors = window.__trussalErrors || [];
  window.__trussalReportError = (e) => window.__trussalErrors.push(String((e && e.stack) || e));
  // The owner's shared sample banks, registered under the SAME folder names
  // their own editor uses so `s("mykit")` means one thing across the room. Kept
  // on window because registration has to happen after the REPL defines
  // registerSampleSource but before the bot's code is evaluated — a pattern
  // naming a bank Strudel doesn't know yet just plays nothing.
  window.__trussalSamples = samples && typeof samples === 'object' ? samples : {};
  // A bot whose captured source is PURE Text/CSS Cycles (no audio pattern at
  // all — the documented "silent by construction" shape those capabilities
  // are built for) has both stripped from `strudel` by cluster-source.js's
  // dropTextStatements/dropCssStatements, leaving it empty. Evaluating empty
  // code registers no pattern, so `repl.scheduler.started` below never flips
  // true and this function throws BEFORE reaching the announce call — the
  // words/styling never reach the room, since that announce call is the only
  // way they get there (see buildBotSilentBlock in strudel.js). `silence` is a
  // real, always-valid
  // Strudel pattern, so substituting it here lets the scheduler start
  // normally without producing any audio.
  const strudelSafe = strudel.trim() ? strudel : 'silence';
  // Strudel's transpiler mini-notation-parses EVERY double-quoted string in
  // the evaluated program, with no notion of which function it is an
  // argument to — so `s0.initImage("folder")` or `s0.initVideo("url")` would
  // silently receive a parsed Pattern instead of the plain string Hydra
  // expects, and never load anything (same bug src/strudel.js's buildPeerBlock
  // fixes for the browser's own combined program). A Hydra preamble never
  // needs mini notation itself, so disable it for the whole preamble via
  // Strudel's own `mini-off`/`mini-on` comment-range convention rather than
  // asking every performer to remember single quotes for every URL argument.
  const hydraSafe = hydra.trim() ? `/* mini-off */\n${hydra}\n/* mini-on */` : hydra;
  // The ';' is load-bearing: hydra ends in an expression and the strudel
  // wrapper starts with '(' — joined by bare newline, ASI reads it as a
  // call: `out(o0)(stack(...))`, which throws inside Strudel's own error
  // handling ("no pattern yet") where our reporter can't see it.
  const code = `${hydraSafe};\n${strudelSafe}`;
  // What gets ANNOUNCED to peer-state (so other viewers can extract a
  // word()/css() voice via buildBotSilentBlock) differs from what THIS REPL
  // evaluates whenever an undeclared (exact-copy) cluster kept one — this REPL
  // is a separate, vanilla @strudel/repl instance that never gets Trussal's
  // installTextCycles/installCssCycles, so it can only ever run the
  // capability-free `strudel`, never the announced one.
  const announcedStrudel = typeof announceStrudel === 'string' ? announceStrudel : strudel;
  try {
    if (!customElements.get('strudel-editor')) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://unpkg.com/@strudel/repl@latest';
        s.onload = resolve;
        s.onerror = () => reject(new Error('strudel repl load failed'));
        document.head.appendChild(s);
      });
    }
    const editor = document.createElement('strudel-editor');
    editor.style.position = 'fixed';
    editor.style.left = '-10000px'; // present in DOM (required to run), invisible to the video feed
    editor.setAttribute('code', code);
    document.body.appendChild(editor);
    // Expose the editor + the Hydra preamble so pageRemoteControl can re-evaluate
    // the REPL with an operator's edited pattern (recombined with this Hydra).
    window.__trussalStrudelEditor = editor;
    window.__trussalHydra = hydra;
    await customElements.whenDefined('strudel-editor');
    // Poll until the web component has mounted its editor object — a fixed
    // sleep races the CDN load and leaves the REPL showing "no pattern yet".
    const deadline = Date.now() + 30000;
    while (!editor.editor && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    const ed = editor.editor;
    if (!ed) throw new Error('strudel editor failed to mount within 30s');

    // Load the bot's OWN AudioWorklet processors and register its synth/
    // noise palette BEFORE the first evaluation, exactly as strudel.js's
    // ensureStrudel() does for a human's browser (loadWorklets, then
    // registerSynthSounds/registerZZFXSounds/registerSoundfonts, alongside
    // registerSampleSource below).
    //
    // loadWorklets is the load-bearing one, confirmed live: an advanced
    // synth (e.g. s("supersaw")) is implemented as a named AudioWorkletNode
    // (superdough/worklets.mjs's registerProcessor('supersaw-oscillator',
    // ...)), and that processor only exists in an AudioContext that has run
    // `audioContext.audioWorklet.addModule(...)` on it — which is exactly
    // what loadWorklets does, and what @strudel/repl's own bootstrap never
    // calls for its bare REPL's context. Without it every hap naming such a
    // synth fails PER-TRIGGER inside Strudel's own trigger code: no thrown
    // error (evaluate() resolves, the scheduler starts, nothing reaches
    // window.__trussalErrors) — just that one voice never making a sound,
    // confirmed via a live room where a bot edited from s("sine") (fine) to
    // s("supersaw") (silent) read fanRms 0 until loadWorklets() ran.
    // registerSynthSounds/ZZFX/Soundfonts cover the REST of a human's sound
    // palette the same way — a copy of a human's own code (the whole point
    // of random:"params" and manual bot edits) can name any of them.
    try {
      const loadWorklets = window.loadWorklets
        || (window.strudel && window.strudel.loadWorklets);
      const registerSynths = window.registerSynthSounds
        || (window.strudel && window.strudel.registerSynthSounds);
      const registerZzfx = window.registerZZFXSounds
        || (window.strudel && window.strudel.registerZZFXSounds);
      const registerFonts = window.registerSoundfonts
        || (window.strudel && window.strudel.registerSoundfonts);
      await Promise.all([
        typeof loadWorklets === 'function' ? loadWorklets() : null,
        typeof registerSynths === 'function' ? registerSynths() : null,
        typeof registerZzfx === 'function' ? registerZzfx() : null,
        typeof registerFonts === 'function' ? registerFonts() : null,
      ]);
    } catch (err) {
      window.__trussalReportError(err);
    }

    // Register the owner's shared banks BEFORE the first evaluation, or the
    // opening cycle of any pattern naming one plays silence. prebake:false
    // matches how the browser registers a performer's own uploads, so the two
    // resolve identically. A failure here is reported, not thrown: the bot
    // should still play whatever does not depend on samples.
    try {
      const register = window.registerSampleSource
        || (window.strudel && window.strudel.registerSampleSource);
      const banks = window.__trussalSamples || {};
      if (typeof register === 'function') {
        for (const [bank, urls] of Object.entries(banks)) {
          if (Array.isArray(urls) && urls.length) register(bank, urls, { prebake: false });
        }
      } else if (Object.keys(banks).length) {
        throw new Error('strudel exposed no registerSampleSource; shared samples unavailable');
      }
    } catch (err) {
      window.__trussalReportError(err);
    }

    // StrudelMirror exposes evaluate(); older builds nest it under .repl.
    if (typeof ed.evaluate === 'function') await ed.evaluate();
    else if (ed.repl && typeof ed.repl.evaluate === 'function') await ed.repl.evaluate(code);
    else throw new Error('strudel editor has no evaluate API');
    // Strudel swallows runtime eval errors into its own UI; the scheduler
    // not running afterwards is the reliable signal that evaluation failed.
    // Reporting it routes through the conductor's replace policy (spec:
    // bots executing broken code are terminated and replaced).
    await new Promise((r) => setTimeout(r, 2000));
    const repl = editor.editor && editor.editor.repl;
    if (!(repl && repl.scheduler && repl.scheduler.started)) {
      throw new Error('pattern did not start after evaluation (likely a runtime eval error)');
    }
    // Publish the (editable) Strudel pattern onto the Trussal peer-state bus so
    // it shows in every studio. The bundle exposes this once it has connected;
    // poll briefly since the Trussal app boots independently of this REPL.
    const announceDeadline = Date.now() + 10000;
    while (typeof window.__trussalAnnounceLocalPattern !== 'function' && Date.now() < announceDeadline) {
      await new Promise((r) => setTimeout(r, 250));
    }
    if (typeof window.__trussalAnnounceLocalPattern === 'function') {
      // Announce the WHOLE program — Hydra preamble, blank line, Strudel — not
      // just the Strudel half.
      //
      // A bot runs both (see `code` above), but announcing only the audio left
      // `peer.pattern` with no preamble, and the aggregator's mosaic decides
      // who earns a cell by asking exactly that text whether it declares Hydra
      // (MosaicCells.mosaicCellsForPeers). So a bot never earned a cell, and
      // every ring turn that fell to one published a black frame while its
      // audio played — visuals are meant to take their turn through the
      // aggregator whether the participant is a bot or not.
      //
      // The blank line is load-bearing: it is where hydra-code.js splits the
      // preamble from the Strudel remainder. This does not reach any human's
      // combined program — strudel.js drops bot peers outright
      // (buildPeerBlock) so their audio is not played twice; only a parroted
      // word()/css() voice is extracted from it, by buildBotSilentBlock.
      //
      // announcedStrudel, not the `strudel` this REPL evaluated: they differ
      // exactly when an undeclared (exact-copy) cluster kept a voice this REPL
      // can't run (see pageStrudelBoot's top).
      const announced = hydra ? `${hydra}\n\n${announcedStrudel}` : announcedStrudel;
      try { window.__trussalAnnounceLocalPattern(announced); } catch (err) {
        window.__trussalReportError(err);
      }
    }
  } catch (e) {
    window.__trussalReportError(e);
  }
}

/**
 * Aggregator ingest tap, installed via evaluateOnNewDocument so it is in place
 * before Jitsi renders any remote participant. It enumerates the conference's
 * remote participants (APP.conference._room.getParticipants()) and taps each
 * one's audio JitsiTrack stream into a ScriptProcessor, accumulating that peer's
 * PCM into a page-side store keyed by the peer's ENDPOINT id (member.getId()).
 * The Node side drains it (via pageDrainParticipantAudio) into the AggregatorBot's
 * per-participant ring buffers — the "clients -> individual buffer queues" hop.
 *
 * Why the member API, not <audio> element ids: this deployment labels remote
 * audio elements with generic ids (remoteAudio_remote-audio-N) that all collapse
 * to one unresolvable key, so element-id parsing captured at most one peer. The
 * lib-jitsi-meet participant/track model is authoritative — a remote audio track's
 * owner IS the real endpoint id, which the room-index resolver knows.
 *
 * Each buffer is identified by the peer's JPattern room-index token (0 for the
 * first human, 0a/0b/… for that human's bots, 1 for the next human, …). The tap
 * stores under the endpoint id and resolves to the token at drain time via
 * window.__trussalRoomIndexForJitsiId (exposed by the Trussal bundle) — so buffers
 * are only ever keyed by room index, and a peer whose index the sidecar hasn't
 * announced yet is held (capped) until it resolves.
 *
 * Self-contained per the module contract: it touches only page globals and its
 * own closures. Taps the STREAM (createMediaStreamSource, which can SHARE a
 * stream), so it coexists with the Trussal bundle's own per-peer tap of the same
 * stream (latency-instrument.js) rather than colliding with it.
 *
 * The same 1s tick also detects DEPARTURES, via two signals (whichever fires
 * first wins — see scan()): (1) window.__trussalRoomIndexForJitsiId losing a
 * jitsiId it had previously resolved — driven by the peer-state bus's
 * peer-leave broadcast, itself a WebSocket close, which fires on an explicit
 * leave/tab-close far faster than Jitsi's own ICE-timeout-driven participant
 * list ever does; and (2) the getParticipants() roster diff as a backstop for
 * an id the resolver never got a token for. The Node side drains the result
 * (via pageDrainParticipantLeaves) and feeds each into
 * AggregatorBot.removeParticipant, which compacts that participant's ring slot
 * so the rotation never leaves a silent gap where they used to be.
 *
 * Ring membership is additionally gated on PLAY STATE
 * (window.__trussalPeerIsPlaying, backed by the peer-state bus's playing
 * flag): a peer merely present in the conference publishes silence, so
 * drain() discards (never delivers) captures from anyone not playing — a
 * joined-but-not-yet-playing peer never claims a turn. Pressing play
 * (re)registers them the moment fresh audio arrives.
 *
 * A play->stop transition is deliberately NOT routed through markDeparted /
 * leftQueue — it used to be (see git history), and the shared path was the
 * bug: under an always-on JPattern metaprogram (the production default —
 * see MetaprogrammerParser.buildDefaultProgram), AggregatorBot.
 * removeParticipant's mode-aware depart() treats every arrival at leftQueue
 * as "gone, might come back" and GHOSTS the still-listed token — looping its
 * last few seconds of pre-stop audio forever, which is the opposite of what
 * an intentional Stop asks for. A genuine departure SHOULD ghost (the room
 * shouldn't go silent on a network blip); an intentional Stop should not — so
 * a stop now only frees playingOnce (markStopped) and lets drain()'s existing
 * playing-gate above starve that peer's live RingBuffer to empty, which
 * readAndAssembleMasterBuffer already renders as clean, un-ghosted silence
 * (the `!currentRingBuffer` / departed===false branch) with no ring-topology
 * change of its own. The Node side (AggregatorBot.#handleStoppedParticipants)
 * still calls removeParticipant for a stop when NO metaprogram is in force,
 * matching the original join-order-mode behaviour this queue split from.
 *
 * drain() is ALSO gated on current ROSTER MEMBERSHIP (scan()'s lastSeen
 * snapshot), because the departure gate above lags a hangup: the Jitsi
 * presence leave arrives before the sidecar peer-leave, and in that window
 * the departed peer's tap emits one final tail frame that would otherwise be
 * delivered and re-register the slot the leave just compacted — permanently,
 * since markDeparted has already consumed every leave signal. The roster gate
 * discards that tail.
 */
export function pageAggregatorCapture() {
  if (window.__trussalAggCapture) return;
  const store = new Map();            // endpoint jitsiId -> number[] of accumulated mono PCM
  const tappedTracks = new WeakSet(); // remote audio JitsiTracks already wired
  const FRAME = 2048;
  const MAX_BACKLOG = FRAME * 64;     // cap page-side buffering if Node never drains
  // jitsiId -> { src, proc, sink }, so a departure can tear the tap down.
  // Without this, nothing external references a departed peer's
  // MediaStreamAudioSourceNode/ScriptProcessorNode/GainNode once the
  // JitsiTrack is gone, but the graph is still CONNECTED and therefore stays
  // alive and running per spec — it keeps firing onaudioprocess (silently
  // refilling `store` under the departed jitsiId, up to MAX_BACKLOG) and
  // burning CPU for the rest of the page's life.
  //
  // Deliberately does NOT store/close the AudioContext: pageAudioBridge
  // wraps window.AudioContext into a page-wide SINGLETON (every `new
  // AudioContext()` anywhere on the page — including here — returns the same
  // shared instance, used for the mic stream, pageMasterPlayer's output, and
  // every OTHER participant's tap too). Closing it for one departed peer
  // silences the entire page. Only the per-participant NODES are this
  // participant's own; only they get torn down.
  const taps = new Map();
  // jitsiId -> consecutive scans it has had a tap but was absent from
  // currentIds. Cleared the moment they reappear; see the scan() sweep below.
  const missingTapScans = new Map();
  // ~3s at the 1s scan cadence — enough to absorb a single glitchy
  // room.getParticipants() read without leaving a real leak unbounded for long.
  const TAP_TEARDOWN_GRACE_SCANS = 3;

  function teardownTap(jitsiId) {
    const tap = taps.get(jitsiId);
    if (!tap) return;
    taps.delete(jitsiId);
    const { src, proc, sink } = tap;
    proc.onaudioprocess = null; // stop delivering frames before disconnecting
    try { src.disconnect(); } catch (e) { console.error(`[trussal] aggregator capture: src.disconnect failed for ${jitsiId}: ${e.message}`); }
    try { proc.disconnect(); } catch (e) { console.error(`[trussal] aggregator capture: proc.disconnect failed for ${jitsiId}: ${e.message}`); }
    try { sink.disconnect(); } catch (e) { console.error(`[trussal] aggregator capture: sink.disconnect failed for ${jitsiId}: ${e.message}`); }
  }

  function tapTrack(jitsiTrack, jitsiId) {
    if (tappedTracks.has(jitsiTrack)) return;
    // The track's MediaStream is the WebRTC audio. Tap the STREAM
    // (createMediaStreamSource) — the element-source API yields SILENCE for a
    // WebRTC <audio> in Chrome, and a MediaStreamSource can SHARE a stream, so this
    // coexists with the Trussal bundle's own per-peer tap (latency-instrument.js).
    // Prefer the JitsiTrack's own stream; fall back to wrapping its bare
    // MediaStreamTrack (whichever actually carries the audio track). If neither is
    // ready yet, return WITHOUT marking tapped so the 1s rescan retries.
    let stream = jitsiTrack.getOriginalStream();
    if (!stream || !stream.getAudioTracks().length) {
      const mediaStreamTrack = jitsiTrack.getTrack();
      if (mediaStreamTrack) stream = new MediaStream([mediaStreamTrack]);
    }
    if (!stream || !stream.getAudioTracks().length) return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) throw new Error('aggregator capture: AudioContext is unavailable');
    // A stale tap under this same jitsiId (e.g. its track was replaced rather
    // than removed) would otherwise be orphaned the same way a departure
    // would — tear it down before wiring the replacement.
    teardownTap(jitsiId);
    const ctx = new AudioContext();
    let src;
    try { src = ctx.createMediaStreamSource(stream); } catch (e) { tappedTracks.add(jitsiTrack); return; }
    const proc = ctx.createScriptProcessor(FRAME, 1, 1);
    proc.onaudioprocess = (ev) => {
      const inp = ev.inputBuffer.getChannelData(0);
      let arr = store.get(jitsiId);
      if (!arr) { arr = []; store.set(jitsiId, arr); }
      if (arr.length < MAX_BACKLOG) for (let i = 0; i < inp.length; i++) arr.push(inp[i]);
    };
    // A zero-gain sink keeps the ScriptProcessor pulling without re-emitting the
    // peer's audio to the device a second time.
    const sink = ctx.createGain();
    sink.gain.value = 0;
    src.connect(proc);
    proc.connect(sink);
    sink.connect(ctx.destination);
    taps.set(jitsiId, { src, proc, sink });
    tappedTracks.add(jitsiTrack);
  }

  // Endpoint ids present as of the previous scan (doubles as drain()'s roster
  // gate: a capture from an id no longer in it is a departed peer's stale
  // tail and is discarded, never delivered), ids that have resolved a
  // room-index token at least once (the prerequisite for the fast resolver-
  // regression check below — an id that has NEVER resolved yet must not be
  // mistaken for a departure), ids observed PLAYING at least once (the same
  // prerequisite for the play-state check below), the queue of ids that have
  // left since the last drainLeaves() — the leave-detection state a departed
  // participant's ring slot needs to be compacted on the Node side
  // (AggregatorBot.removeParticipant) instead of left as a silent gap — and
  // the separate queue of ids that have merely STOPPED playing since the last
  // drainStopped(): these must not share leftQueue (see the module doc above
  // for why routing a stop through removeParticipant's ghost path defeated
  // intentional Stop).
  let lastSeen = new Set();
  const resolvedOnce = new Set();
  const playingOnce = new Set();
  const leftQueue = [];
  const stoppedQueue = [];

  // NOTE: markDeparted must not tear down the audio tap itself — see the
  // roster-diff sweep in scan() for that.
  function markDeparted(jitsiId) {
    leftQueue.push(jitsiId);
    store.delete(jitsiId);
    lastSeen.delete(jitsiId);
    resolvedOnce.delete(jitsiId);
    playingOnce.delete(jitsiId);
  }

  // The play-state fast path below calls this for a peer who is still fully
  // present (just not playing) — deliberately lighter than markDeparted: it
  // does NOT touch lastSeen or resolvedOnce, since this peer hasn't actually
  // left (lastSeen is rebuilt from the live roster moments later in this same
  // scan() tick anyway, and resolvedOnce should stay live so Fast path #1
  // keeps working for them the instant they do leave for real). It also does
  // NOT tear down the audio tap — tapTrack's WeakSet guard means their
  // unchanged JitsiTrack is never re-tapped, so that would be permanent, and
  // they'd never be heard from again after resuming.
  function markStopped(jitsiId) {
    stoppedQueue.push(jitsiId);
    store.delete(jitsiId);
    playingOnce.delete(jitsiId);
  }

  // Enumerate remote participants (the authoritative source — getParticipants()
  // excludes self) and tap each one's audio tracks, keyed by the member's endpoint
  // id. The room-not-ready guard returns quietly during startup; once ready the
  // lib-jitsi-meet accessors are called directly, so an unexpected API shape throws
  // loudly rather than silently capturing nothing — and a throw here does NOT wedge
  // the loop (setInterval keeps firing; unresolved/idle members drop out at drain).
  function scan() {
    const resolve = window.__trussalRoomIndexForJitsiId;
    const resolverReady = typeof resolve === 'function';
    const isPlaying = window.__trussalPeerIsPlaying;
    const playingReady = typeof isPlaying === 'function';

    // Fast path #1: an id that has previously resolved a room-index token but
    // no longer does has left via the sidecar's peer-leave broadcast (see
    // syncMapperFromPeerEvent in index.js, which unregisters the jitsiId the
    // instant the peer-state WebSocket closes). Checked first and independent
    // of getParticipants() below, since Jitsi's own roster can take many
    // seconds (ICE disconnect timeout) to notice the same departure.
    if (resolverReady) {
      [...resolvedOnce].filter((jitsiId) => resolve(jitsiId) == null).forEach(markDeparted);
    }

    // Fast path #2: an id that WAS playing but has stopped is queued via
    // markStopped, NOT markDeparted — see the module doc above for why a stop
    // must not enter removeParticipant's ghost path. The drain() gate below
    // is this check's other half: it keeps a non-playing peer's captures from
    // reaching the Node side at all, so their live RingBuffer starves to
    // empty on its own (clean, un-ghosted silence) without any ring-topology
    // change here.
    if (playingReady) {
      [...playingOnce].filter((jitsiId) => !isPlaying(jitsiId)).forEach(markStopped);
    }

    const conf = globalThis.APP && globalThis.APP.conference;
    const room = conf && conf._room;
    if (!room || typeof room.getParticipants !== 'function') return; // conference not ready yet
    const participants = room.getParticipants().filter((participant) => participant.getId());
    const currentIds = new Set(participants.map((participant) => participant.getId()));
    // Backstop: catches a departure the resolver never saw resolved in the
    // first place (e.g. the peer-state mapping never landed for this id).
    [...lastSeen].filter((jitsiId) => !currentIds.has(jitsiId)).forEach(markDeparted);
    lastSeen = currentIds;
    // Tear down any tap whose jitsiId has been ABSENT from the authoritative
    // Jitsi roster for several CONSECUTIVE scans — deliberately independent of
    // markDeparted/the fast paths above, which free a peer's turn on a mere
    // play/stop or a resolver blip while they're still actually in the room.
    // A single-tick absence is NOT trusted on its own: room.getParticipants()
    // can be transiently incomplete (documented elsewhere in this codebase as
    // "ICE-slow"), especially around a burst of joins, and teardownTap is
    // IRREVERSIBLE — tapTrack's WeakSet guard means a still-present peer's
    // unchanged JitsiTrack is never re-tapped, so one bad sample would
    // permanently silence them. Requiring a short run of consecutive misses
    // (missingTapScans) absorbs that glitch while still bounding the leak to a
    // few seconds instead of "forever".
    [...taps.keys()].forEach((jitsiId) => {
      if (currentIds.has(jitsiId)) { missingTapScans.delete(jitsiId); return; }
      const misses = (missingTapScans.get(jitsiId) || 0) + 1;
      if (misses < TAP_TEARDOWN_GRACE_SCANS) { missingTapScans.set(jitsiId, misses); return; }
      missingTapScans.delete(jitsiId);
      teardownTap(jitsiId);
    });
    if (resolverReady) {
      [...currentIds].filter((jitsiId) => resolve(jitsiId) != null).forEach((jitsiId) => resolvedOnce.add(jitsiId));
    }
    if (playingReady) {
      [...currentIds].filter((jitsiId) => isPlaying(jitsiId)).forEach((jitsiId) => playingOnce.add(jitsiId));
    }
    participants
      .flatMap((participant) => participant.getTracks()
        .filter((track) => track.getType() === 'audio')
        .map((track) => ({ track, jitsiId: participant.getId() })))
      .forEach(({ track, jitsiId }) => tapTrack(track, jitsiId));
  }
  setInterval(scan, 1000); // peers/tracks appear as they join
  scan();

  window.__trussalAggCapture = {
    drain() {
      const resolve = window.__trussalRoomIndexForJitsiId;
      const isPlaying = window.__trussalPeerIsPlaying;
      const playingReady = typeof isPlaying === 'function';
      const out = [];
      for (const [jitsiId, arr] of store) {
        if (!arr.length) continue;
        // A peer no longer in the Jitsi roster delivers nothing: on an in-app
        // hangup the Jitsi presence leave lands BEFORE the sidecar peer-leave
        // (the tab stays open, so the peer-state WS closes ~a second later),
        // and during that lag the playing/resolver gates below are still open
        // while this peer's ScriptProcessor emits one last tail frame. That
        // tail used to re-register the ring slot the leave had just compacted
        // — permanently, because markDeparted has already consumed every leave
        // signal, so nothing ever fired again. lastSeen is scan()'s current
        // roster snapshot; the same scan that detects the departure rebuilds
        // it without the leaver, so the tail is discarded here instead of
        // delivered. A present peer is unaffected: scan() re-adds it every
        // second, and captures only exist for peers a scan has already seen
        // (tapTrack runs after the roster read).
        if (!lastSeen.has(jitsiId)) { arr.length = 0; continue; }
        // A peer that is not currently PLAYING delivers nothing: its captured
        // PCM (silence — the published track carries only Strudel output) is
        // DISCARDED, not held, so a peer who joined but never pressed play
        // can't register a ring slot on the Node side, a stopped peer can't
        // re-register the slot scan() just compacted, and pressing play later
        // streams fresh audio rather than a backlog of stale silence.
        if (playingReady && !isPlaying(jitsiId)) { arr.length = 0; continue; }
        const token = typeof resolve === 'function' ? resolve(jitsiId) : null;
        if (token == null) continue; // room index not announced yet — keep buffering
        // Carry the jitsiId (the endpoint id) alongside the resolved token so the
        // aggregator can pin the source -> token mapping ONCE for the whole meeting,
        // rather than re-resolving it on every drain.
        out.push({ jitsiId: String(jitsiId), token: String(token), samples: arr.splice(0) });
      }
      return out;
    },
    // Endpoint ids that have left the conference since the last call (cleared on
    // read, like drain()). The Node side feeds each into removeParticipant so a
    // departed participant's slot is compacted out of the rotation immediately
    // instead of lingering as a silent turn.
    drainLeaves() {
      return leftQueue.splice(0);
    },
    // Endpoint ids that have merely STOPPED playing (still in the conference)
    // since the last call. Kept separate from drainLeaves() — see the module
    // doc above — because feeding these into removeParticipant would ghost
    // them under an active metaprogram instead of letting them go quietly
    // silent.
    drainStopped() {
      return stoppedQueue.splice(0);
    },
    // Localizes an empty drain to a stage: participantCount 0 -> no remote peers;
    // store empty -> no audio tapped from any member (no audio track / capture
    // failing); store has keys but resolved null -> jitsiId↔roomIndex not announced
    // yet. Full member/track/element correlation lives in pageAggregatorTrackMapDiag.
    diag() {
      const storeSizes = {};
      for (const [jid, arr] of store) storeSizes[jid] = arr.length;
      const resolverType = typeof window.__trussalRoomIndexForJitsiId;
      const resolved = {};
      if (resolverType === 'function') {
        for (const jid of store.keys()) {
          try { resolved[jid] = window.__trussalRoomIndexForJitsiId(jid); }
          catch (e) { resolved[jid] = `ERR:${e && e.message}`; }
        }
      }
      let participantCount = null;
      const conf = globalThis.APP && globalThis.APP.conference;
      const room = conf && conf._room;
      if (room && typeof room.getParticipants === 'function') participantCount = room.getParticipants().length;
      return { store: storeSizes, resolverType, resolved, participantCount };
    },
  };
}

/** Drain the accumulated per-participant PCM the aggregator tap has captured. */
export function pageDrainParticipantAudio() {
  return (window.__trussalAggCapture && window.__trussalAggCapture.drain()) || [];
}

/** Drain the endpoint ids that have left the conference since the last call. */
export function pageDrainParticipantLeaves() {
  return (window.__trussalAggCapture && window.__trussalAggCapture.drainLeaves()) || [];
}

/** Drain the endpoint ids that have merely stopped playing since the last call. */
export function pageDrainParticipantStopped() {
  return (window.__trussalAggCapture && window.__trussalAggCapture.drainStopped()) || [];
}

/** Snapshot of the capture tap's state, for diagnosing an empty drain. */
export function pageAggregatorCaptureDiag() {
  return (window.__trussalAggCapture && window.__trussalAggCapture.diag()) || null;
}

/**
 * Track→member mapping probe for the capture redesign. The element-id tap keys on
 * `remoteAudio_<jitsiId>`, but this deployment labels remote audio elements with
 * generic ids (remoteAudio_remote-audio-N) that collapse to one unresolvable key.
 * This dumps the AUTHORITATIVE mapping straight from lib-jitsi-meet: every remote
 * participant's real endpoint id, what the room-index resolver returns for it, and
 * each of its audio JitsiTracks' underlying MediaStreamTrack/stream id + owner id —
 * then every <audio> element with the track ids on its srcObject. Correlating an
 * element's srcObject track ids against a member's track ids tells us whether we
 * can tap by TRACK IDENTITY (member id resolves to a room index) instead of parsing
 * element ids. Read-only, defensive across API shapes; throws on unreadable tracks
 * (a corrupt member must not be silently reported as having none).
 */
export function pageAggregatorTrackMapDiag() {
  const appConference = globalThis.APP && globalThis.APP.conference;
  const room = appConference && appConference._room; // lib-jitsi-meet JitsiConference (underscore-convention, reachable)
  const resolverType = typeof window.__trussalRoomIndexForJitsiId;
  const resolveRoomIndex = (id) => {
    if (resolverType !== 'function') return undefined;
    try { return window.__trussalRoomIndexForJitsiId(id); }
    catch (e) { return `ERR:${e && e.message}`; }
  };

  // Priority-ordered conference surfaces that can enumerate participants; the
  // first whose method exists wins, and its `conf` key doubles as the label.
  const participantSources = [
    { conf: 'room', ok: room && typeof room.getParticipants === 'function', list: () => room.getParticipants() },
    { conf: 'wrapper', ok: appConference && typeof appConference.listMembers === 'function', list: () => appConference.listMembers() },
  ];
  const source = participantSources.find((candidate) => candidate.ok) || { conf: 'none', list: () => [] };
  const participants = source.list();

  const members = participants.map((participant) => {
    const id = typeof participant.getId === 'function' ? participant.getId() : (participant._id || null);
    let tracks = [];
    try {
      if (typeof participant.getTracks === 'function') tracks = participant.getTracks();
      else if (typeof participant.getTracksByMediaType === 'function') tracks = participant.getTracksByMediaType('audio');
    } catch (e) {
      // Corrupted/unreadable tracks are a hard failure for the mapping — surface
      // it (with the member id) rather than silently reporting a member with none.
      throw new Error(`track-map: cannot read tracks for member ${id}: ${e && e.message}`);
    }
    const audioTracks = tracks
      .filter((track) => typeof track.getType !== 'function' || track.getType() === 'audio')
      .map((track) => {
        const mediaStreamTrack = typeof track.getTrack === 'function' ? track.getTrack() : null;
        const stream = typeof track.getOriginalStream === 'function' ? track.getOriginalStream() : null;
        const audioTrackInfo = {
          ownerId: typeof track.getParticipantId === 'function' ? track.getParticipantId() : null,
          trackId: mediaStreamTrack ? mediaStreamTrack.id : null,
          streamId: stream ? stream.id : null,
          muted: typeof track.isMuted === 'function' ? track.isMuted() : null,
        };
        return audioTrackInfo;
      });
    const memberEntry = { id, roomIndex: resolveRoomIndex(id), tracks: audioTracks };
    return memberEntry;
  });

  const audioElements = [...document.querySelectorAll('audio')]
    .filter((el) => el.srcObject)
    .map((el) => {
      const audioElementEntry = {
        id: el.id || '(none)',
        streamId: el.srcObject.id,
        trackIds: (typeof el.srcObject.getAudioTracks === 'function' ? el.srcObject.getAudioTracks() : []).map((audioTrack) => audioTrack.id),
      };
      return audioElementEntry;
    });

  return { conf: source.conf, resolverType, members, audioElements };
}

/**
 * Aggregator playback sink — the return leg of the round trip, mirror of
 * pageAggregatorCapture. The Node side hands assembled master-mix PCM to
 * enqueue(); a ScriptProcessor streams it out through the SHARED AudioContext's
 * destination, which pageAudioBridge has rerouted to the fan → the
 * MediaStreamDestination that is the bot's published "microphone". So the
 * assembled master reaches every other client. When the queue is starved
 * (nothing assembled yet) it emits silence, keeping the track live so the bot
 * can just keep checking for new data.
 *
 * Self-contained per the module contract: only page globals and its own
 * closures. It reuses the one shared AudioContext (pageAudioBridge wraps the
 * constructor so `new AudioContext()` returns that instance), so its output
 * lands on the same fan as everything else — no second output device.
 *
 * Chunk queue rather than a flat sample array: the audio callback consumes the
 * head chunk through an offset cursor, so enqueue is O(added) and playback never
 * pays the O(n) cost of shifting a large sample array every frame. Past
 * MAX_CHUNKS the oldest chunk is dropped, so a slow Node drain bounds added
 * latency instead of growing the page heap without limit. enqueue() and the
 * ScriptProcessor callback both run on the page's main thread (the legacy
 * ScriptProcessor is not a worklet), so they never touch the queue concurrently.
 */
export function pageMasterPlayer() {
  if (window.__trussalMasterPlayer) return;
  const FRAME = 2048;
  const MAX_CHUNKS = 256;
  const chunks = [];   // Array<Float32Array> waiting to be emitted
  let head = 0;        // read offset into chunks[0]
  let ctx = null, proc = null, busOut = null;
  // Master-bus effects (`# room wcl …`, `# noise …`, `# crush …`, `# echo …`):
  // applied HERE, on the one mix every client hears, rather than in each
  // browser. Node computes the pure params (src/audio-net/av-effects/Room.js
  // roomParams, Noise.js noiseParams, Crush.js crushParams, Echo.js
  // echoParams) and pushes them via setRoom()/setNoise()/setCrush()/setEcho();
  // the graphs below mirror those modules' create*Node — the page-script
  // contract forbids imports, so the construction is inlined.
  let room = null;         // { input, output, combs: [{delay, fb}], lp1, lp2, all: [...] }
  let noise = null;        // { input, output, level, voices: [{color, src, gain}], all: [...] }
  let crush = null;        // { input, output, shaper, lp, bits, all: [...] }
  let echo = null;         // { input, output, delay, fb, wet, limiter, all: [...] }
  let pendingRoom = null;  // params pushed before the ctx existed
  let pendingNoise = null;
  let pendingCrush = null;
  let pendingEcho = null;

  function ensure() {
    if (ctx) return;
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch (e) {
      console.error('[trussal] master player could not open an AudioContext', e);
      return;
    }
    proc = ctx.createScriptProcessor(FRAME, 1, 1);
    proc.onaudioprocess = (ev) => {
      const out = ev.outputBuffer.getChannelData(0);
      for (let i = 0; i < out.length; i++) {
        if (!chunks.length) { out[i] = 0; continue; } // starved -> silence
        out[i] = chunks[0][head++];
        if (head >= chunks[0].length) { chunks.shift(); head = 0; }
      }
    };
    // proc -> busOut -> fan -> MediaStreamDestination (this bot's mic ->
    // every other client) + hardware. busOut is the master insert point:
    // relink() re-routes it through whichever effects exist without touching
    // proc.
    busOut = ctx.createGain();
    proc.connect(busOut);
    busOut.connect(ctx.destination);
    if (pendingCrush) { const p = pendingCrush; pendingCrush = null; setCrush(p); }
    if (pendingEcho) { const p = pendingEcho; pendingEcho = null; setEcho(p); }
    if (pendingRoom) { const p = pendingRoom; pendingRoom = null; setRoom(p); }
    if (pendingNoise) { const p = pendingNoise; pendingNoise = null; setNoise(p); }
  }

  // busOut -> crush? -> echo? -> room? -> noise? -> destination. The order is
  // fixed rather than read from the written chain, and each position is a
  // musical decision:
  //   crush first — the quantizer degrades the SOURCE material, which is what
  //     it is for; run last it would grind the reverb tail into a wash and
  //     lose the grit.
  //   echo next — the repeats carry the crushed signal, the way a lo-fi delay
  //     does, and each repeat is one identical quantization rather than a
  //     progressively re-crushed one (the shaper sits outside the feedback
  //     loop).
  //   room after both — the space contains the repeats instead of the
  //     repeats smearing an already-reverberant signal.
  //   noise last — it is additive and belongs ON the mix, so running it after
  //     the reverb keeps the bed dry instead of feeding it through the tail.
  // Called after any build/teardown; a params-only update touches no edges
  // and does not re-link.
  function relink() {
    // Every node that can be a link in the chain drops its outgoing edge
    // first. Clearing busOut alone is not enough: whichever effect used to be
    // last still holds its edge to the destination, so inserting another one
    // behind it would leave the old path live and the mix would reach the fan
    // twice. Each of these has exactly one outgoing edge — the chain link —
    // so a blanket disconnect() is the whole of it.
    // Each disconnect is guarded on its own: a throw here would otherwise
    // abort before the reconnection below, leaving busOut attached to nothing
    // and the bot publishing silence with no path back.
    [busOut, crush && crush.output, echo && echo.output,
      room && room.output, noise && noise.output].forEach((n) => {
      if (!n) return;
      try {
        n.disconnect();
      } catch (e) {
        console.error('[trussal] master path: disconnecting a chain link failed', e);
      }
    });
    let hd = busOut;
    if (crush) { hd.connect(crush.input); hd = crush.output; }
    if (echo) { hd.connect(echo.input); hd = echo.output; }
    if (room) { hd.connect(room.input); hd = room.output; }
    if (noise) { hd.connect(noise.input); hd = noise.output; }
    hd.connect(ctx.destination);
  }

  // Disconnect a torn-down effect's nodes. Logs and continues per node: one
  // failure must not strand the rest still wired into the master path.
  function unwire(label, nodes) {
    nodes.forEach((n, i) => {
      if (!n) return;
      try {
        n.disconnect();
      } catch (e) {
        console.error(`[trussal] master ${label}: disconnecting node ${i} failed`, e);
      }
    });
  }

  function buildRoom(params) {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const wet = ctx.createGain();
    wet.gain.value = params.wetGain;
    input.connect(output); // dry path
    const combs = params.combDelaysS.map((d, i) => {
      const delay = ctx.createDelay(Math.max(1, d * 2));
      delay.delayTime.value = d;
      const fb = ctx.createGain();
      fb.gain.value = params.combFeedbacks[i];
      input.connect(delay);
      delay.connect(fb);
      fb.connect(delay);
      return { delay, fb };
    });
    const combSum = ctx.createGain();
    combSum.gain.value = 1 / combs.length;
    combs.forEach((c) => c.delay.connect(combSum));
    // Allpass stages run in SERIES (see Room.js): advancing `hd` per stage is
    // what chains them. Without it every stage taps combSum in parallel, only
    // the last reaches the lowpass, and the rest are dead recirculating loops.
    let hd = combSum;
    const allpasses = params.allpassDelaysS.map((d) => {
      const delay = ctx.createDelay(1);
      delay.delayTime.value = d;
      const fb = ctx.createGain();
      fb.gain.value = 0.5;
      hd.connect(delay);
      delay.connect(fb);
      fb.connect(delay);
      hd = delay;
      return delay;
    });
    const lp1 = ctx.createBiquadFilter();
    const lp2 = ctx.createBiquadFilter();
    lp1.type = lp2.type = 'lowpass';
    lp1.frequency.value = lp2.frequency.value = params.cutoffHz;
    hd.connect(lp1);
    lp1.connect(lp2);
    lp2.connect(wet);
    wet.connect(output);
    return {
      input, output, wet, combs, lp1, lp2,
      all: [input, output, wet, combSum, lp1, lp2,
        ...combs.map((c) => c.delay), ...combs.map((c) => c.fb), ...allpasses],
    };
  }

  // Three level-matched generators (see Noise.js: brown/pink/white, each
  // normalized to white's RMS) mixed by params.mix and scaled by params.gain.
  // All three run for the node's lifetime, so a spectrum sweep crossfades
  // rather than rebuilding a buffer mid-stream.
  function buildNoise(params) {
    const input = ctx.createGain();
    const output = ctx.createGain();
    input.connect(output); // additive: the assembled mix passes through
    const level = ctx.createGain();
    level.gain.value = params.gain;
    level.connect(output);

    const len = Math.max(1, Math.floor(ctx.sampleRate * 2));
    const voices = ['brown', 'pink', 'white'].map((color) => {
      const buf = ctx.createBuffer(1, len, ctx.sampleRate);
      const ch = buf.getChannelData(0);
      if (color === 'white') {
        for (let i = 0; i < ch.length; i++) ch[i] = Math.random() * 2 - 1;
      } else if (color === 'pink') {
        let b0 = 0, b1 = 0, b2 = 0;
        for (let i = 0; i < ch.length; i++) {
          const w = Math.random() * 2 - 1;
          b0 = 0.99765 * b0 + w * 0.0990460;
          b1 = 0.96300 * b1 + w * 0.2965164;
          b2 = 0.57000 * b2 + w * 1.0526913;
          ch[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
        }
      } else {
        let last = 0;
        for (let i = 0; i < ch.length; i++) {
          const w = Math.random() * 2 - 1;
          last = (last + 0.02 * w) / 1.02;
          ch[i] = last * 3.5;
        }
      }
      // 0.2 is Noise.js's NOISE_RMS (the brown generator's own level). It is
      // duplicated here rather than imported, so bot.test.js compares these
      // buffers against the module's generators to catch the two drifting.
      let sum = 0;
      for (let i = 0; i < ch.length; i++) sum += ch[i] * ch[i];
      const rms = Math.sqrt(sum / (ch.length || 1));
      if (rms > 0) {
        const scale = 0.2 / rms;
        for (let i = 0; i < ch.length; i++) ch[i] *= scale;
      }
      const gain = ctx.createGain();
      gain.gain.value = (params.mix && params.mix[color]) || 0;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.loop = true;
      src.connect(gain);
      gain.connect(level);
      src.start();
      return { color, src, gain };
    });

    return {
      input, output, level, voices,
      all: [input, output, level, ...voices.map((v) => v.src), ...voices.map((v) => v.gain)],
    };
  }

  function setNoise(params) {
    if (!ctx) { pendingNoise = params; return; }
    if (!params) {
      if (!noise) return;
      noise.voices.forEach((v) => {
        try {
          v.src.stop();
        } catch (e) {
          console.error(`[trussal] master noise: stopping the ${v.color} generator failed`, e);
        }
      });
      const dead = noise;
      noise = null;
      relink();
      unwire('noise', dead.all);
      return;
    }
    if (!noise) {
      noise = buildNoise(params);
      relink();
      return;
    }
    noise.level.gain.value = params.gain;
    noise.voices.forEach((v) => { v.gain.gain.value = (params.mix && params.mix[v.color]) || 0; });
  }

  function setRoom(params) {
    if (!ctx) { pendingRoom = params; return; }
    if (!params) {
      if (!room) return;
      const dead = room;
      room = null;
      relink();
      unwire('room', dead.all);
      return;
    }
    if (!room) {
      room = buildRoom(params);
      relink();
      return;
    }
    room.combs.forEach((c, i) => {
      c.delay.delayTime.value = Math.min(params.combDelaysS[i], 1.99);
      c.fb.gain.value = params.combFeedbacks[i];
    });
    room.wet.gain.value = params.wetGain;
    room.lp1.frequency.value = params.cutoffHz;
    room.lp2.frequency.value = params.cutoffHz;
  }

  // makeCrushCurve's quantization ladder (see Crush.js): 2^bits steps across
  // [-1, 1]. The length duplicates that module's default rather than importing
  // it; bot.test.js compares the two arrays to catch the copies drifting.
  const CRUSH_CURVE_LENGTH = 2048;
  function crushCurve(bitDepth) {
    const steps = Math.max(2, Math.round(Math.pow(2, bitDepth)));
    const curve = new Float32Array(CRUSH_CURVE_LENGTH);
    for (let i = 0; i < CRUSH_CURVE_LENGTH; i++) {
      const x = (i * 2) / (CRUSH_CURVE_LENGTH - 1) - 1;
      curve[i] = Math.round((x + 1) / 2 * (steps - 1)) / (steps - 1) * 2 - 1;
    }
    return curve;
  }

  // Bit-depth reduction as a waveshaper, sample-rate reduction as a lowpass at
  // the decimated Nyquist — the same graph-only approximation
  // createCrushNode makes, which keeps a second ScriptProcessor off a path
  // that already carries one. Fully wet: there is no dry leg to blend, since a
  // quantizer summed with its own input is just a quieter quantizer.
  function buildCrush(params) {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const shaper = ctx.createWaveShaper();
    shaper.curve = crushCurve(params.bitDepth);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = ctx.sampleRate / 2 / params.srDivisor;
    input.connect(shaper);
    shaper.connect(lp);
    lp.connect(output);
    return { input, output, shaper, lp, bits: params.bitDepth, all: [input, output, shaper, lp] };
  }

  function setCrush(params) {
    if (!ctx) { pendingCrush = params; return; }
    if (!params) {
      if (!crush) return;
      const dead = crush;
      crush = null;
      relink();
      unwire('crush', dead.all);
      return;
    }
    if (!crush) {
      crush = buildCrush(params);
      relink();
      return;
    }
    // Rebuilding the curve allocates a 2048-float array, and with patterned
    // arguments this runs on every pattern tick rather than only on a metrics
    // change — so skip it when the depth has not actually moved.
    if (params.bitDepth !== crush.bits) {
      crush.shaper.curve = crushCurve(params.bitDepth);
      crush.bits = params.bitDepth;
    }
    crush.lp.frequency.value = ctx.sampleRate / 2 / params.srDivisor;
  }

  // Echo.js's ECHO_MAX_DELAY_S, LIMITER_THRESHOLD_DB and GAIN_RAMP_S. The
  // delay ceiling is a real memory decision rather than just a clamp: a
  // DelayNode allocates maxDelayTime x sampleRate of buffer at construction.
  const ECHO_MAX_DELAY_S = 20;
  const ECHO_LIMITER_THRESHOLD_DB = -1.0;
  const ECHO_GAIN_RAMP_S = 0.02;

  function buildEcho(params) {
    const input = ctx.createGain();
    const output = ctx.createGain();
    const delay = ctx.createDelay(ECHO_MAX_DELAY_S);
    delay.delayTime.value = params.delayS;
    const fb = ctx.createGain();
    fb.gain.value = params.feedback;
    const wet = ctx.createGain();
    wet.gain.value = params.wetGain;
    // Wet-path limiter (see Echo.js): the echo's gain is the performer's to
    // set and is deliberately not clamped, so the repeats bring their own
    // wall. The dry signal reaches the output untouched.
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = ECHO_LIMITER_THRESHOLD_DB;
    input.connect(output);        // dry
    input.connect(delay);
    delay.connect(fb);
    fb.connect(delay);            // feedback loop
    delay.connect(wet);
    wet.connect(limiter);
    limiter.connect(output);      // wet, at the echo's own gain
    return {
      input, output, delay, fb, wet, limiter,
      all: [input, output, delay, fb, wet, limiter],
    };
  }

  // Patterned arguments step at cycle boundaries rather than drifting with the
  // metrics, so an instant jump on the wet or feedback gain is an audible
  // click on every step; a ramp this short is inaudible as a glide but removes
  // the discontinuity. Never schedules a ramp to where the parameter already
  // sits, because the pattern tick re-derives 20x/s and most updates carry the
  // value already in force.
  function rampGain(param, target) {
    if (param.value === target) return;
    const now = ctx.currentTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(param.value, now);
    param.linearRampToValueAtTime(target, now + ECHO_GAIN_RAMP_S);
  }

  function setEcho(params) {
    if (!ctx) { pendingEcho = params; return; }
    if (!params) {
      if (!echo) return;
      const dead = echo;
      echo = null;
      relink();
      // unwire breaks the feedback loop as well as the chain link — left
      // connected, a delay->fb->delay ring keeps recirculating whatever was in
      // it after the effect is gone.
      unwire('echo', dead.all);
      return;
    }
    if (!echo) {
      echo = buildEcho(params);
      relink();
      return;
    }
    // delayTime is left to JUMP: ramping it sweeps the read pointer, which is
    // a pitch bend rather than a crossfade, and the point of a re-timed echo
    // is that it re-times.
    if (echo.delay.delayTime.value !== params.delayS) echo.delay.delayTime.value = params.delayS;
    rampGain(echo.fb.gain, params.feedback);
    rampGain(echo.wet.gain, params.wetGain);
  }

  function queued() {
    let n = -head;
    for (const c of chunks) n += c.length;
    return n < 0 ? 0 : n;
  }

  window.__trussalMasterPlayer = {
    enqueue(samples) {
      ensure();
      if (!samples || !samples.length) return queued();
      // Overflow: drop the oldest (currently-playing) chunk and reset the
      // cursor. Only bites when Node has run far ahead of real-time playback.
      if (chunks.length >= MAX_CHUNKS) { chunks.shift(); head = 0; }
      chunks.push(Float32Array.from(samples));
      return queued();
    },
    queued,
    setRoom,
    setNoise,
    setCrush,
    setEcho,
  };
}

/** Push assembled master-mix PCM (a plain Array) into the page playback sink. */
export function pageEnqueueMaster(samples) {
  const p = window.__trussalMasterPlayer;
  return (p && typeof p.enqueue === 'function') ? p.enqueue(samples) : 0;
}

/**
 * Apply (or clear, with null) the master-bus room reverb. `params` is the
 * pure roomParams() output computed Node-side from the applied metaprogram
 * and the room's worst-case metrics (aggregator-bot.js #syncMasterRoom).
 */
export function pageSetMasterRoom(params) {
  const p = window.__trussalMasterPlayer;
  if (p && typeof p.setRoom === 'function') p.setRoom(params || null);
}

/**
 * Apply (or clear, with null) the master-bus noise bed. `params` is the pure
 * noiseParams() output computed Node-side from the applied metaprogram, the
 * room's worst-case metrics and the current cycle (aggregator-bot.js
 * #syncMasterNoise) — the cycle matters because noise is the one effect whose
 * arguments may be `<…>` patterns.
 */
export function pageSetMasterNoise(params) {
  const p = window.__trussalMasterPlayer;
  if (p && typeof p.setNoise === 'function') p.setNoise(params || null);
}

/**
 * Apply (or clear, with null) the master-bus bit crusher. `params` is the pure
 * crushParams() output computed Node-side from the applied metaprogram, the
 * room's worst-case metrics and the current cycle POSITION
 * (aggregator-bot.js #syncMasterCrush) — a fractional position, because crush
 * accepts `[…]` subdivisions as well as `<…>` alternation.
 */
export function pageSetMasterCrush(params) {
  const p = window.__trussalMasterPlayer;
  if (p && typeof p.setCrush === 'function') p.setCrush(params || null);
}

/**
 * Apply (or clear, with null) the master-bus feedback delay. `params` is the
 * pure echoParams() output computed Node-side (aggregator-bot.js
 * #syncMasterEcho). Echo needs the cycle LENGTH as well as the position: its
 * delay is written in cycles, so it re-times whenever the metrics move the
 * grid.
 */
export function pageSetMasterEcho(params) {
  const p = window.__trussalMasterPlayer;
  if (p && typeof p.setEcho === 'function') p.setEcho(params || null);
}

/**
 * Surface a short aggregator status line in the Trussal studio overlay from the
 * Node side, as a single find-or-create `.ts-agg-status` child of the peer
 * detail card (`.ts-detail`): repeated calls only rewrite its text, so it is
 * never reattached (duplicated). A no-op until the overlay has mounted (the
 * bare aggregator page never opens the studio). Self-contained per the module
 * contract — touches only the DOM.
 */
export function pageReportStudioStatus(text) {
  const detail = document.querySelector('.ts-detail');
  if (!detail) return;
  let statusEl = detail.querySelector('.ts-agg-status');
  if (!statusEl) {
    statusEl = document.createElement('div');
    statusEl.className = 'ts-agg-status';
    detail.append(statusEl);
  }
  statusEl.textContent = String(text);
}

/**
 * rAF-based fps sampler. window.__trussalFps always holds the frame count
 * of the last full 1 s window; the Node-side metrics loop reads it.
 */
export function pageFpsSampler() {
  let frames = 0;
  window.__trussalFps = 0;
  setInterval(() => { window.__trussalFps = frames; frames = 0; }, 1000);
  const loop = () => { frames++; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
}

/** Read the page-side samples the Node metrics loop consumes. */
export function pageReadSamples() {
  // diag fields exist to debug "bot joined but shows no pattern" from the
  // admin API without shelling into containers: how many canvases exist
  // (Hydra creates one), whether the Strudel editor mounted, and whether
  // its scheduler is actually started (= pattern audibly playing).
  const editor = document.querySelector('strudel-editor');
  const repl = editor && editor.editor && editor.editor.repl;
  const fan = window.__trussalFanGain;
  const readFanRms = window.__trussalReadFanRms;
  const jitsiJoined = Boolean(globalThis.APP && globalThis.APP.conference
    && globalThis.APP.conference.isJoined && globalThis.APP.conference.isJoined());
  // Whether the bot is genuinely AUDIBLE, not just "playing": fanRms>0 means sound
  // reached the fan (→ Jitsi track → aggregator) this window; ==0 while
  // schedulerStarted is true is the silent-bot signature (see the meter in
  // pageAudioBridge). The channel counts diagnose superdough's multichannel
  // routing — the maxChannelCount math is the known silence cause. Null before the
  // shared context exists (e.g. an aggregator that has not built it yet).
  const audio = {
    fanRms: typeof readFanRms === 'function' ? readFanRms() : null,
    // A muted bot (or a mute/unmute message applied out of order) reads
    // fanRms==0 with schedulerStarted true too — this distinguishes "gain is
    // zeroed" from "the pattern itself produces nothing" without either one
    // masquerading as the other in the admin API.
    fanGainValue: fan ? fan.gain.value : null,
    fanChannelCount: fan ? fan.channelCount : null,
    fanMaxChannelCount: fan ? fan.maxChannelCount : null,
    hardwareMaxChannelCount: window.__trussalHardwareMaxChannelCount ?? null,
    // Whether the setEffect direct tap (pageEnsureAudioPublished step 3) is
    // attached — the publish path that bypasses the gUM-handed mic track.
    directTap: Boolean(window.__trussalDirectTapEffect),
    // Whether the re-attach watchdog is installed (survives track replacement
    // across renegotiations, e.g. the P2P↔JVB flip).
    directTapWatchdog: Boolean(window.__trussalDirectTapWatchdog),
  };
  const samples = {
    fps: window.__trussalFps ?? 0,
    errors: (window.__trussalErrors || []).splice(0),
    diag: {
      canvases: document.querySelectorAll('canvas').length,
      strudelMounted: Boolean(editor && editor.editor),
      schedulerStarted: Boolean(repl && repl.scheduler && repl.scheduler.started),
      jitsiJoined,
      audio,
    },
  };
  return samples;
}

/**
 * The aggregator's video: every Hydra participant's output tiled into one
 * published frame.
 *
 * The aggregator publishes ONE video track, so the mosaic cannot be N canvases
 * on a page — it is N canvases COMPOSITED into a single output canvas, and it
 * is that output canvas the gUM override hands to Jitsi. The per-peer canvases
 * are still real DOM nodes (created when a peer starts running Hydra, removed
 * when they stop), which is what makes the page inspectable: a screenshot of
 * the container shows exactly what each cell is drawing.
 *
 * Only the participant whose turn it is renders. Everyone else's cell is
 * black, and their Hydra instance is not ticked at all — no rAF, no GPU. A
 * paused instance costs a live WebGL context and nothing else, which is what
 * keeps a large room inside Chromium's ~16-context ceiling. Hydra patterns are
 * written against a clock (`() => time`), so an instance resumes looking
 * continuous rather than restarting.
 *
 * Two kinds of cell, decided Node-side (src/hydra-code.js mosaicCellSource):
 *   - 'reexecute': the preamble runs here, in its own Hydra instance. The
 *     common case.
 *   - 'blit': the code reads the camera (`src(s0)`), which this page hasn't
 *     got. That performer's own browser already renders it against their real
 *     camera and publishes the result, so the cell draws their incoming video
 *     track instead of trying to reproduce it.
 *
 * Installed at document-start: the output canvas must exist before Jitsi's
 * first device enumeration, or the gUM override waits for a canvas that does
 * not exist yet and the join hangs.
 */
export function pageMosaic(options = {}) {
  if (window.__trussalMosaic) return;
  const {
    width = 1280,
    height = 720,
    hydraSrc = 'https://unpkg.com/hydra-synth',
  } = options || {};

  // The published frame. Black from the moment it exists, so the aggregator
  // has something to publish from the instant the meeting begins — before any
  // participant has written a line of Hydra.
  const out = document.createElement('canvas');
  out.id = 'trussal-mosaic-out';
  out.width = width;
  out.height = height;
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, width, height);

  // Per-peer canvases live here, and so does the output canvas. Off to the
  // side rather than display:none — a display:none canvas is not guaranteed to
  // be composited, and we need Hydra's WebGL output to be readable by
  // drawImage.
  const container = document.createElement('div');
  container.id = 'trussal-mosaic';
  container.style.cssText =
    'position:fixed;left:-20000px;top:0;width:' + width + 'px;height:' + height + 'px;';
  // The output canvas MUST be in the document: the gUM override finds it with
  // document.querySelector, which cannot match a detached node. Left detached,
  // that lookup falls through to "largest canvas in the page" — which is no
  // canvas at all before anyone runs Hydra (so the join hangs waiting for one)
  // and an arbitrary CELL canvas afterwards (so the aggregator publishes one
  // participant full-frame instead of the mosaic).
  container.appendChild(out);
  const attach = () => (document.body || document.documentElement).appendChild(container);
  if (document.body) attach();
  else document.addEventListener('DOMContentLoaded', attach, { once: true });

  let cells = [];           // [{ token, jitsiId, source, preamble }] from Node
  let slots = [];           // grid position -> token | null
  let activeToken = null;   // whose turn it is
  let enabled = true;       // `# mosaic`; false = only the streaming cell
  let layout = [];          // [{ token, index, rect }] computed Node-side
  // Where the room is on its cycle grid, for `H(...)` parameters. Node pushes
  // an anchor at each cycle boundary — "cycle N begins `inSeconds` from now,
  // and a cycle lasts `seconds`" — and the page interpolates between pushes so
  // a parameter moves smoothly at frame rate instead of stepping once a cycle.
  let cycleAnchor = null;   // { cycle, seconds, atMs }
  const instances = new Map();   // token -> { canvas, hydra, video, error }
  const errors = [];

  function noteError(where, e) {
    const msg = `[trussal] mosaic ${where}: ${e && e.message ? e.message : e}`;
    console.error(msg, e);
    errors.push(msg);
    if (errors.length > 32) errors.shift();
  }

  // --- hydra-synth, loaded once and shared by every instance -----------------

  let hydraLoading = null;
  function loadHydra() {
    if (window.Hydra) return Promise.resolve(window.Hydra);
    if (hydraLoading) return hydraLoading;
    hydraLoading = import(/* webpackIgnore: true */ hydraSrc)
      .then((mod) => window.Hydra || (mod && (mod.default || mod.Hydra)))
      .then((ctor) => {
        if (!ctor) throw new Error('hydra-synth loaded but exposed no constructor');
        window.Hydra = ctor;
        return ctor;
      })
      .catch((e) => {
        hydraLoading = null; // let a later cell retry rather than wedging
        noteError('hydra-synth load', e);
        throw e;
      });
    return hydraLoading;
  }

  // The preamble's own `await initHydra(...)` is the marker that made this
  // Hydra code in the first place; it would build the page-wide singleton this
  // renderer exists to avoid, so it is stripped and the instance we already
  // made stands in for it.
  function stripInitHydra(preamble) {
    return String(preamble || '').replace(/^\s*await\s+initHydra\s*\([^)]*\)\s*;?/, '');
  }

  // The room's position in fractional cycles, interpolated from the last
  // anchor Node pushed. Before the first anchor there is no grid to read, so
  // parameters sit at cycle 0 rather than racing on a clock of their own.
  function cyclePos() {
    if (!cycleAnchor || !(cycleAnchor.seconds > 0)) return 0;
    const elapsed = (performance.now() - cycleAnchor.atMs) / 1000;
    return cycleAnchor.cycle + elapsed / cycleAnchor.seconds;
  }

  // Run a peer's preamble against THEIR synth rather than page globals. `with`
  // is what makes an unmodified `osc(10).out()` resolve to this instance —
  // new Function bodies are sloppy-mode, so it is available here.
  //
  // Three layers, and the order is load-bearing:
  //   1. Strudel's exports, so `H(saw.range(0,2))` can resolve `saw` at all;
  //   2. this cell's Hydra synth, which must win the names both libraries
  //      define (`shape`, `speed`, `noise`) — this is Hydra code;
  //   3. our `H`, which must win over @strudel/hydra's, since that one reads a
  //      scheduler clock this page has not got.
  // A PROXY, not a copy. Hydra mutates `synth.time` (and `mouse`, `bpm`) on
  // every tick, so a snapshot would freeze the very values patterns animate
  // on — `osc(60, 0.1, () => time)` would render one still frame for ever.
  // `has` is what `with` consults to decide whether an identifier belongs to
  // the scope, so it must answer false for everything the layers don't hold,
  // or `console`/`Math`/`Promise` inside a preamble would resolve to
  // undefined instead of reaching the real global scope.
  function preambleScope(inst, H) {
    const params = window.__trussalHydraParams;
    const strudelScope = (params && params.patternScope()) || null;
    const synth = inst.synth;
    return new Proxy(Object.create(null), {
      has(_t, key) {
        if (key === Symbol.unscopables) return false;
        return key === 'H' || key in synth || !!(strudelScope && key in strudelScope);
      },
      get(_t, key) {
        if (key === Symbol.unscopables) return undefined;
        if (key === 'H') return H;
        // Hydra wins the names both libraries define (`shape`, `speed`,
        // `noise`): this is Hydra code.
        if (key in synth) return synth[key];
        return strudelScope ? strudelScope[key] : undefined;
      },
      set(_t, key, value) {
        synth[key] = value;
        return true;
      },
    });
  }

  function runPreamble(inst, preamble) {
    const body = stripInitHydra(preamble);
    if (!body.trim()) return;
    const params = window.__trussalHydraParams;
    // Ours must win over @strudel/hydra's H, which reads a scheduler clock
    // this page has not got.
    const H = params
      ? params.makeH(cyclePos)
      : (spec) => () => (typeof spec === 'number' ? spec : 0);
    /* eslint-disable-next-line no-new-func */
    const run = new Function('scope', `with (scope) { return (async () => {\n${body}\n})(); }`);
    return Promise.resolve(run(preambleScope(inst, H)));
  }

  // A cell whose preamble uses `H(...)` must not be evaluated before the
  // pattern machinery is there, or its parameters bind to the fallback for the
  // life of the instance. Cells without H never wait.
  function whenParamsReady(needed) {
    if (!needed) return Promise.resolve();
    const deadline = performance.now() + 20000;
    return new Promise((resolve) => {
      const tick = () => {
        const params = window.__trussalHydraParams;
        if (params) { params.whenReady.then(resolve, resolve); return; }
        if (performance.now() > deadline) {
          noteError('pattern params', new Error('Strudel pattern machinery never appeared'));
          resolve();
          return;
        }
        setTimeout(tick, 250);
      };
      tick();
    });
  }

  function ensureInstance(cell) {
    const existing = instances.get(cell.token);
    if (existing && existing.preamble === cell.preamble && existing.source === cell.source) return;
    destroyInstance(cell.token);

    const entry = { canvas: null, hydra: null, video: null, source: cell.source, preamble: cell.preamble };
    instances.set(cell.token, entry);

    if (cell.source === 'blit') {
      // A hidden <video> fed from that participant's published track. Built
      // from the JitsiTrack's own MediaStream rather than by hunting Jitsi's
      // DOM, whose remote element ids are generic in this deployment (see
      // pageAggregatorTrackMapDiag).
      const video = document.createElement('video');
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.dataset.trussalToken = cell.token;
      container.appendChild(video);
      entry.video = video;
      attachRemoteVideo(entry, cell.jitsiId);
      return;
    }

    const canvas = document.createElement('canvas');
    canvas.className = 'trussal-mosaic-cell';
    canvas.dataset.trussalToken = cell.token;
    // Cell pixels, not frame pixels: sized to the largest cell it could be
    // asked to fill, then scaled down by drawImage. Re-sizing a live Hydra
    // instance mid-performance would reset its WebGL state.
    canvas.width = width;
    canvas.height = height;
    container.appendChild(canvas);
    entry.canvas = canvas;

    Promise.all([loadHydra(), whenParamsReady(cell.usesPatternParams)])
      .then(([Hydra]) => {
        if (instances.get(cell.token) !== entry) return; // superseded while loading
        entry.hydra = new Hydra({
          canvas,
          makeGlobal: false,      // no page globals — N synths coexist
          detectAudio: false,
          autoLoop: false,        // WE decide when a cell advances
          width,
          height,
        });
        return runPreamble(entry.hydra, cell.preamble);
      })
      .catch((e) => {
        entry.error = e && e.message ? e.message : String(e);
        noteError(`cell ${cell.token}`, e);
      });
  }

  // JVB only forwards a remote participant's video to a receiver that has
  // asked for it — normally jitsi-meet's own React UI does this implicitly,
  // driven by which tiles are actually visible on screen. This page never
  // mounts that grid at all (it composites its own mosaic canvas instead), so
  // that signal never fires and every blit `<video>` sits forever at
  // `readyState 0` / a natively-muted track: srcObject assigns cleanly, but
  // no frame ever arrives. Ask explicitly, for everyone, since the mosaic
  // always wants every Hydra-running peer's real video and never fewer.
  // Cheap to call repeatedly — lib-jitsi-meet no-ops an unchanged constraints
  // object — so every retry tick just re-asserts it rather than tracking
  // whether the first call actually landed.
  function ensureReceiverConstraints(room) {
    try {
      if (typeof room.setReceiverConstraints === 'function') {
        room.setReceiverConstraints({ defaultConstraints: { maxHeight: 360 }, lastN: -1 });
      } else if (typeof room.setReceiverVideoConstraint === 'function') {
        room.setReceiverVideoConstraint(360);
      }
    } catch (e) {
      noteError('receiver constraints', e);
    }
  }

  function attachRemoteVideo(entry, jitsiId) {
    try {
      const room = window.APP && window.APP.conference && window.APP.conference._room;
      if (!room || typeof room.getParticipants !== 'function') return;
      ensureReceiverConstraints(room);
      const participant = room.getParticipants().find((p) => p.getId() === jitsiId);
      if (!participant || typeof participant.getTracks !== 'function') return;
      const track = participant.getTracks().find((t) => t.getType() === 'video');
      if (!track) return;
      const stream = typeof track.getOriginalStream === 'function' ? track.getOriginalStream() : null;
      if (!stream) return;
      entry.video.srcObject = stream;
      const play = entry.video.play();
      if (play && typeof play.catch === 'function') play.catch(() => {});
    } catch (e) {
      noteError('attach remote video', e);
    }
  }

  function destroyInstance(token) {
    const entry = instances.get(token);
    if (!entry) return;
    instances.delete(token);
    if (entry.hydra) {
      try { entry.hydra.synth.hush(); } catch (e) { noteError(`hush ${token}`, e); }
      // Release the WebGL context EXPLICITLY rather than waiting for the
      // detached canvas to be collected. Chromium allows ~16 live contexts
      // per page and drops the oldest when that is exceeded — in a room where
      // performers start and stop Hydra, GC timing would decide whether a
      // returning cell gets a context or silently renders nothing.
      try {
        const gl = entry.canvas.getContext('webgl') || entry.canvas.getContext('webgl2');
        const lose = gl && gl.getExtension('WEBGL_lose_context');
        if (lose) lose.loseContext();
      } catch (e) { noteError(`release context ${token}`, e); }
    }
    if (entry.video) {
      try { entry.video.pause(); entry.video.srcObject = null; } catch (e) { noteError(`detach ${token}`, e); }
      entry.video.remove();
    }
    if (entry.canvas) entry.canvas.remove();
  }

  // --- compositing -----------------------------------------------------------

  let lastTick = 0;

  function sourceCanvasFor(token) {
    const entry = instances.get(token);
    if (!entry) return null;
    if (entry.video) return entry.video.readyState >= 2 ? entry.video : null;
    return entry.hydra ? entry.canvas : null;
  }

  // `target` is the published canvas's context when no frame effect is in
  // force, and the scene buffer's when one is — the cells are drawn the same
  // way either side of that choice.
  function drawCell(token, rect, target) {
    const src = sourceCanvasFor(token);
    if (!src) return;
    try {
      (target || ctx).drawImage(src, rect.x, rect.y, rect.w, rect.h);
    } catch (e) {
      noteError(`draw ${token}`, e);
    }
  }

  // --- frame effects ---------------------------------------------------------
  //
  // The video counterpart of the `#` chain, computed Node-side by
  // av-effects/VideoState.js and pushed here. Applied in the master path's
  // order — crush, echo, room, noise — so the image degrades the way the mix
  // does: decimate the source, carry that through the repeats, blur what the
  // repeats produced, then lay the grain on top.

  let videoFx = null;        // { blurPx, blurWet, pixelBlock, grain, crossfadeS, crossfadeGain }
  let work = null;           // the scene, when effects need it off-canvas first
  let small = null;          // pixelation buffer
  let fade = null;           // the outgoing turn's last frame, for the crossfade
  let fadeStartedAt = 0;
  let grainTile = null;
  let grainTileAt = 0;

  const fxActive = () => !!videoFx && (
    (videoFx.blurPx > 0 && videoFx.blurWet > 0)
    || videoFx.pixelBlock > 1
    || videoFx.grain > 0
    || (videoFx.crossfadeS > 0 && videoFx.crossfadeGain > 0)
  );

  function buffer(existing, w, h) {
    const c = existing || document.createElement('canvas');
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    return c;
  }

  // Monochrome grain, regenerated a few times a second so it shimmers rather
  // than sitting as a fixed dirty overlay. One small tile, drawn repeatedly —
  // per-pixel noise over a whole frame every tick would cost more than every
  // other effect here combined.
  function grainPattern(now) {
    if (grainTile && now - grainTileAt < 80) return grainTile;
    const size = 128;
    grainTile = buffer(grainTile, size, size);
    const g = grainTile.getContext('2d');
    const img = g.createImageData(size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const v = (Math.random() * 255) | 0;
      img.data[i] = img.data[i + 1] = img.data[i + 2] = v;
      img.data[i + 3] = 255;
    }
    g.putImageData(img, 0, 0);
    grainTileAt = now;
    return grainTile;
  }

  // Draw whichever cells are lit into `target`, which is either the published
  // canvas (no effects) or the scene buffer (effects).
  function drawScene(target) {
    const c = target.getContext('2d');
    c.fillStyle = '#000';
    c.fillRect(0, 0, width, height);
    if (!enabled) {
      // `# mosaic false`: whoever is streaming, full frame. Nothing else.
      if (activeToken != null) drawCell(activeToken, { x: 0, y: 0, w: width, h: height }, c);
      return;
    }
    for (const cell of layout) {
      if (cell.token !== activeToken) continue; // every other cell stays black
      drawCell(cell.token, cell.rect, c);
    }
  }

  function frame(now) {
    requestAnimationFrame(frame);
    const dt = lastTick ? now - lastTick : 16;
    lastTick = now;

    // Advance ONLY the streaming participant. Everyone else holds still
    // behind a black cell.
    const live = instances.get(activeToken);
    if (live && live.hydra) {
      try { live.hydra.tick(dt); } catch (e) { noteError(`tick ${activeToken}`, e); }
    }

    if (!fxActive()) {
      drawScene(out);
      return;
    }

    work = buffer(work, width, height);
    drawScene(work);
    let source = work;

    // crush — spatial decimation. Draw small, then back up with smoothing
    // off, which is what makes it read as blocks rather than as a soft image.
    if (videoFx.pixelBlock > 1) {
      const sw = Math.max(1, Math.round(width / videoFx.pixelBlock));
      const sh = Math.max(1, Math.round(height / videoFx.pixelBlock));
      small = buffer(small, sw, sh);
      const sc = small.getContext('2d');
      sc.imageSmoothingEnabled = false;
      sc.drawImage(source, 0, 0, sw, sh);
      const wc = work.getContext('2d');
      wc.imageSmoothingEnabled = false;
      wc.clearRect(0, 0, width, height);
      wc.drawImage(small, 0, 0, sw, sh, 0, 0, width, height);
      wc.imageSmoothingEnabled = true;
      source = work;
    }

    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    ctx.filter = 'none';
    ctx.globalAlpha = 1;
    ctx.drawImage(source, 0, 0);

    // echo — the outgoing turn lingers over the incoming one. The snapshot is
    // taken at the turn boundary (setActive), so only ONE Hydra instance is
    // ever ticking: fading two live cells would mean two live WebGL contexts
    // per transition, against Chromium's ~16-context ceiling.
    if (fade && videoFx.crossfadeS > 0 && videoFx.crossfadeGain > 0) {
      const elapsed = (now - fadeStartedAt) / 1000;
      if (elapsed >= videoFx.crossfadeS) {
        fade = null;
      } else {
        ctx.globalAlpha = videoFx.crossfadeGain * (1 - elapsed / videoFx.crossfadeS);
        ctx.drawImage(fade, 0, 0);
        ctx.globalAlpha = 1;
      }
    }

    // room — a blurred copy mixed over the dry frame at the wet balance, so
    // the image softens as the tail lengthens rather than simply going soft.
    if (videoFx.blurPx > 0 && videoFx.blurWet > 0) {
      ctx.filter = `blur(${videoFx.blurPx.toFixed(2)}px)`;
      ctx.globalAlpha = videoFx.blurWet;
      ctx.drawImage(source, 0, 0);
      ctx.filter = 'none';
      ctx.globalAlpha = 1;
    }

    // noise — the bed, last, because it is additive and belongs on the image
    // rather than inside the blur.
    if (videoFx.grain > 0) {
      const tile = grainPattern(now);
      const pattern = ctx.createPattern(tile, 'repeat');
      if (pattern) {
        ctx.globalAlpha = videoFx.grain;
        ctx.globalCompositeOperation = 'overlay';
        ctx.fillStyle = pattern;
        ctx.fillRect(0, 0, width, height);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = 1;
      }
    }
  }
  requestAnimationFrame(frame);

  window.__trussalMosaic = {
    // Node pushes the full cell list whenever it changes; the page reconciles
    // instances against it. Layout (which slot each token holds) is computed
    // Node-side too, so the arrangement is decided in one testable place.
    setCells(nextCells, nextSlots, nextLayout) {
      cells = Array.isArray(nextCells) ? nextCells : [];
      slots = Array.isArray(nextSlots) ? nextSlots : [];
      layout = Array.isArray(nextLayout) ? nextLayout : [];
      const wanted = new Set(cells.map((c) => c.token));
      for (const token of [...instances.keys()]) {
        if (!wanted.has(token)) destroyInstance(token);
      }
      for (const cell of cells) ensureInstance(cell);
    },
    setActive(token) {
      const next = token == null ? null : String(token);
      // The turn boundary is where `# echo`'s crossfade starts, and the only
      // moment the outgoing performer's last frame still exists — the next
      // tick advances a different cell and this one stops being drawn. Hold a
      // copy rather than keeping its Hydra instance ticking: a fade between
      // two LIVE cells would need two WebGL contexts per transition, and the
      // whole reason only the active cell renders is Chromium's ~16-context
      // ceiling.
      if (next !== activeToken && videoFx && videoFx.crossfadeS > 0 && videoFx.crossfadeGain > 0) {
        try {
          fade = buffer(fade, width, height);
          const f = fade.getContext('2d');
          f.clearRect(0, 0, width, height);
          f.drawImage(out, 0, 0);
          fadeStartedAt = performance.now();
        } catch (e) {
          fade = null;
          noteError('crossfade snapshot', e);
        }
      }
      activeToken = next;
    },
    // The `#` chain's video counterpart, recomputed Node-side whenever the
    // metrics, the cycle or a patterned argument moves. Null clears it.
    setVideo(state) {
      videoFx = state || null;
      if (!videoFx || !(videoFx.crossfadeS > 0)) fade = null;
    },
    setEnabled(on) {
      enabled = !!on;
    },
    // The cycle grid `H(...)` parameters are sampled against. `inSeconds` is
    // how far ahead of the push the boundary falls — the scheduler emits cycle
    // events with a lookahead, so the boundary is usually still in the future.
    setCycle({ cycle, seconds, inSeconds = 0 } = {}) {
      if (!(seconds > 0) || !Number.isFinite(cycle)) return;
      cycleAnchor = { cycle, seconds, atMs: performance.now() + inSeconds * 1000 };
    },
    // A blit cell's track may arrive after the cell does (the peer toggles
    // video on later), so retry attachment for any blit cell still without a
    // stream. Called on the same cadence as the roster scan.
    //
    // Re-asserting the receiver constraints here too (not just inside
    // attachRemoteVideo) matters because a cell can have `srcObject` set —
    // and so never reach attachRemoteVideo again — while its track sits
    // natively muted at readyState 0 forever: assigning srcObject doesn't
    // depend on JVB actually forwarding frames, so a constraints call that
    // arrived too early (before the bridge channel was ready) would
    // otherwise never get retried for an already-"attached" cell.
    retryAttachments() {
      const room = window.APP && window.APP.conference && window.APP.conference._room;
      if (room && cells.some((c) => c.source === 'blit')) ensureReceiverConstraints(room);
      for (const cell of cells) {
        if (cell.source !== 'blit') continue;
        const entry = instances.get(cell.token);
        if (entry && entry.video && !entry.video.srcObject) attachRemoteVideo(entry, cell.jitsiId);
      }
    },
    diag() {
      return {
        enabled,
        activeToken,
        slots,
        cyclePos: cyclePos(),
        patternApi: Boolean(window.__trussalHydraParams),
        cells: cells.map((c) => ({ token: c.token, source: c.source })),
        instances: [...instances.entries()].map(([token, e]) => ({
          token,
          kind: e.video ? 'blit' : 'hydra',
          ready: Boolean(e.hydra) || Boolean(e.video && e.video.srcObject),
          error: e.error || null,
        })),
        errors: errors.slice(),
      };
    },
  };

  setInterval(() => window.__trussalMosaic.retryAttachments(), 1000);
}

/** Push the current mosaic cells + layout into the page. */
export function pageSetMosaicCells(payload) {
  const m = window.__trussalMosaic;
  if (!m) return false;
  m.setCells(payload.cells || [], payload.slots || [], payload.layout || []);
  return true;
}

/** Tell the mosaic whose turn it is (null = a rest: every cell black). */
export function pageSetMosaicActive(token) {
  const m = window.__trussalMosaic;
  if (!m) return false;
  m.setActive(token);
  return true;
}

/**
 * The `#` chain's video counterpart for the published frame — blur, pixel
 * block, grain and the per-turn crossfade, computed by
 * av-effects/VideoState.js. Null restores an untouched frame.
 */
export function pageSetMosaicVideo(state) {
  const m = window.__trussalMosaic;
  if (!m) return false;
  m.setVideo(state);
  return true;
}

/** Anchor the mosaic's cycle clock, which `H(...)` parameters are read off. */
export function pageSetMosaicCycle(anchor) {
  const m = window.__trussalMosaic;
  if (!m) return false;
  m.setCycle(anchor);
  return true;
}

/** Apply `# mosaic`: true tiles the room, false shows only the streamer. */
export function pageSetMosaicEnabled(on) {
  const m = window.__trussalMosaic;
  if (!m) return false;
  m.setEnabled(on);
  return true;
}

/** Mosaic state, for diagnosing a black or wrong-looking published frame. */
export function pageMosaicDiag() {
  return (window.__trussalMosaic && window.__trussalMosaic.diag()) || null;
}

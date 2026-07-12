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
    const fan = ctx.createGain();
    fan.connect(hardware);
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
    // LAUNDER the fan's output through a ScriptProcessor before the published tap.
    // superdough's AudioWorklet output does NOT survive publication into a
    // MediaStreamDestination in headless Chrome — confirmed live: a native
    // OscillatorNode into the same published tap was audible while superdough was
    // not, and the UNPUBLISHED normTap fed by the same worklet carried full audio.
    // A ScriptProcessor re-emits the audio from a main-thread buffer — a native node
    // output, exactly like the oscillator and the aggregator's pageMasterPlayer — and
    // the published tap renders that. Its 2 input channels down-mix superdough's
    // multichannel fan output to clean stereo. (NOTE: outboundAudio.audioLevel and
    // tapRmsNative read 0 even for audible audio on these tracks — false zeros;
    // verify by ear or the aggregator's capture peak, not those.)
    const laundry = ctx.createScriptProcessor(1024, 2, 2);
    // DIAGNOSTIC: does onaudioprocess FIRE (laundryCalls climbing), and does the
    // worklet audio reach the SP INPUT (laundryInPeak>0)? laundryCalls==0 => the SP
    // is not pulled; calls>0 & inPeak==0 => worklet output doesn't reach a
    // ScriptProcessor input (unlike a GainNode); calls>0 & inPeak>0 but the room is
    // silent => the SP OUTPUT itself doesn't publish.
    window.__trussalLaundryCalls = 0;
    window.__trussalLaundryInPeak = 0;
    laundry.onaudioprocess = (event) => {
      const { inputBuffer, outputBuffer } = event;
      let peak = 0;
      for (let channel = 0; channel < outputBuffer.numberOfChannels; channel++) {
        const source = inputBuffer.getChannelData(Math.min(channel, inputBuffer.numberOfChannels - 1));
        for (let i = 0; i < source.length; i++) { const a = Math.abs(source[i]); if (a > peak) peak = a; }
        outputBuffer.getChannelData(channel).set(source);
      }
      window.__trussalLaundryCalls += 1;
      if (peak > window.__trussalLaundryInPeak) window.__trussalLaundryInPeak = peak;
    };
    fan.connect(laundry);
    const tap = ctx.createMediaStreamDestination(); // → Jitsi mic track
    // Feed the published tap via a GainNode, NOT the ScriptProcessor directly. Both
    // sources confirmed to publish reach the tap through a GainNode (the native
    // oscillator was osc→gain→tap; the aggregator is masterSP→fan(gain)→tap), while
    // the SP wired straight to the tap fired and had the full worklet audio at its
    // input (laundryCalls>0, laundryInPeak~0.88) yet published silence.
    const tapGain = ctx.createGain();
    laundry.connect(tapGain);
    tapGain.connect(tap);
    // A ScriptProcessor only fires onaudioprocess while connected (transitively) to a
    // rendered sink; it feeds tap (a MediaStreamDestination sink), but route it
    // additionally through a MUTED gain to the hardware destination as insurance.
    const laundryPull = ctx.createGain();
    laundryPull.gain.value = 0;
    laundry.connect(laundryPull);
    laundryPull.connect(hardware);
    window.__trussalMicStream = tap.stream;
    // contentHint='music' disables WebRTC's speech-oriented send processing (noise
    // suppression / AGC / Opus DTX) that can gate synthetic, non-voice audio like
    // superdough's synths to silence once the track is published — while a human
    // voice (the aggregator's mix) passes. Harmless if that processing isn't the cause.
    try {
      tap.stream.getAudioTracks().forEach((audioTrack) => { audioTrack.contentHint = 'music'; });
    } catch (e) {
      console.error('[trussal] setting audio contentHint failed', e);
    }
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
    // NOTE: do NOT meter tap.stream with a SAME-ctx createMediaStreamSource — that
    // loopback silences the tap's actual output (incl. what the encoder sends), not
    // just its own reading (the same-ctx-loopback gotcha). Use the cross-ctx probe
    // below instead. (An earlier same-ctx tapRms meter here was silencing the fix.)
    // DIAGNOSTIC (artifact-free): meter tap.stream from a SEPARATE native context.
    // The same-ctx tapMeter above is unreliable (the same-ctx-loopback silence
    // gotcha), so a cross-context source reads the tap's TRUE output. Native is the
    // pre-wrap constructor, so this sidesteps the singleton. If this is >0 while the
    // room hears silence, the break is in the WebRTC encode/publish, not fan→tap.
    try {
      const probeCtx = new Native();
      if (probeCtx.state === 'suspended') probeCtx.resume().catch(() => {});
      const probeMeter = probeCtx.createAnalyser();
      probeMeter.fftSize = 2048;
      probeCtx.createMediaStreamSource(tap.stream).connect(probeMeter);
      const probeBuf = new Float32Array(probeMeter.fftSize);
      let tapNativePeak = 0;
      window.__trussalReadTapRmsNative = () => { const peak = tapNativePeak; tapNativePeak = 0; return peak; };
      setInterval(() => {
        probeMeter.getFloatTimeDomainData(probeBuf);
        const rms = Math.sqrt(sumSquares(probeBuf) / probeBuf.length);
        if (rms > tapNativePeak) tapNativePeak = rms;
      }, 200);
    } catch (e) { console.error('[trussal] native tap meter setup failed', e); }
    // CONFIRMATION PROBE (non-intrusive): tests the PROPOSED fix in a parallel,
    // NON-published path. Hypothesis: superdough emits a channel layout the plain
    // MediaStreamDestination `tap` drops (the analyser sums it → fanRms>0, but the
    // tap captures silence → tapRmsNative==0). Feed the fan through an
    // explicit-stereo gain (speakers down-mix of ALL channels) into a SEPARATE tap
    // and meter it cross-context. If normTapRms>0 while tapRmsNative==0, the layout
    // IS the cause and the stereo-normalize fix works — proven without changing the
    // published path (probeTap is never published, so no test tone leaks).
    try {
      const normGain = ctx.createGain();
      normGain.channelCountMode = 'explicit';
      normGain.channelCount = 2;
      normGain.channelInterpretation = 'speakers';
      const normTap = ctx.createMediaStreamDestination();
      fan.connect(normGain);
      normGain.connect(normTap);
      window.__trussalChannelDiag = {
        fanChannelCountMode: fan.channelCountMode,
        fanChannelInterpretation: fan.channelInterpretation,
        tapChannelCount: tap.channelCount,
        tapChannelCountMode: tap.channelCountMode,
        tapChannelInterpretation: tap.channelInterpretation,
        tapTrackChannels: (() => {
          try { const s = tap.stream.getAudioTracks()[0].getSettings(); return s && s.channelCount != null ? s.channelCount : null; }
          catch (e) { return null; }
        })(),
      };
      const normCtx = new Native();
      if (normCtx.state === 'suspended') normCtx.resume().catch(() => {});
      const normMeter = normCtx.createAnalyser();
      normMeter.fftSize = 2048;
      normCtx.createMediaStreamSource(normTap.stream).connect(normMeter);
      const normBuf = new Float32Array(normMeter.fftSize);
      let normPeak = 0;
      window.__trussalReadNormTapRms = () => { const peak = normPeak; normPeak = 0; return peak; };
      setInterval(() => {
        normMeter.getFloatTimeDomainData(normBuf);
        const rms = Math.sqrt(sumSquares(normBuf) / normBuf.length);
        if (rms > normPeak) normPeak = rms;
      }, 200);
    } catch (e) { console.error('[trussal] norm tap probe setup failed', e); }
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
  // Owner's room index (Net Cycles): peer-state.js sends it in the hello so
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
 * Trussal bundle elects a single winner (lowest room index; see
 * aggregator-election.js) and exposes it as window.__trussalIsActiveAggregator;
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
 *     pattern, recombined with the bot's original Hydra preamble.
 *   - trussal-remote-mute: zero/restore the shared audio fan gain, muting the
 *     bot on both the Jitsi and Jamulus paths at once.
 * Installed at document-start; it reads the editor/fan globals lazily at event
 * time, so ordering against pageStrudelBoot / pageAudioBridge doesn't matter.
 */
export function pageRemoteControl() {
  document.addEventListener('trussal-remote-pattern', async (e) => {
    const strudel = e && e.detail && e.detail.code;
    if (typeof strudel !== 'string') return;
    const editor = window.__trussalStrudelEditor;
    const ed = editor && editor.editor;
    const hydra = window.__trussalHydra || '';
    const code = hydra ? `${hydra};\n${strudel}` : strudel;
    try {
      if (ed && typeof ed.setCode === 'function') {
        ed.setCode(code);
        if (typeof ed.evaluate === 'function') await ed.evaluate();
      } else if (editor && typeof editor.setAttribute === 'function') {
        editor.setAttribute('code', code);
        if (ed && typeof ed.evaluate === 'function') await ed.evaluate();
      }
    } catch (err) {
      if (window.__trussalReportError) window.__trussalReportError(err);
    }
  });
  document.addEventListener('trussal-remote-mute', (e) => {
    const muted = !!(e && e.detail && e.detail.muted);
    const fan = window.__trussalFanGain;
    if (fan && fan.gain) { try { fan.gain.value = muted ? 0 : 1; } catch (_) {} }
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
 * before Jitsi's first device enumeration. Video requests resolve to the
 * Hydra canvas stream (polling until initHydra() has created the canvas);
 * audio requests resolve to the Strudel tap from pageAudioBridge (falling
 * back to silence if the bridge is unavailable).
 */
export function pageGumOverride(captureFps = 15) {
  const realGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);

  function hydraCanvas() {
    // initHydra() in the Strudel REPL creates a canvas; prefer one it tagged,
    // fall back to the largest canvas in the page.
    const tagged = document.querySelector('canvas#hydra-canvas, canvas.hydra-canvas');
    if (tagged) return tagged;
    const all = [...document.querySelectorAll('canvas')];
    return all.sort((a, b) => b.width * b.height - a.width * a.height)[0] || null;
  }

  function waitForCanvas() {
    return new Promise((resolve) => {
      const tick = () => {
        const c = hydraCanvas();
        if (c) resolve(c); else setTimeout(tick, 250);
      };
      tick();
    });
  }

  function silentAudioTrack() {
    const ctx = new AudioContext();
    const dst = ctx.createMediaStreamDestination();
    ctx.createGain().connect(dst); // zero-input gain node = silence
    return dst.stream.getAudioTracks()[0];
  }

  navigator.mediaDevices.getUserMedia = async (constraints = {}) => {
    const stream = new MediaStream();
    if (constraints.video) {
      const canvas = await waitForCanvas();
      // captureFps is a bandwidth guard: 15 fps halves encode + uplink cost
      // vs 30 with little visual loss for slow-evolving Hydra patterns.
      for (const t of canvas.captureStream(captureFps).getVideoTracks()) stream.addTrack(t);
    }
    if (constraints.audio) {
      const mic = window.__trussalMicStream;
      const tapTrack = mic && mic.getAudioTracks()[0];
      stream.addTrack(tapTrack || silentAudioTrack());
    }
    return stream.getTracks().length ? stream : realGUM(constraints);
  };
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
    // Single accessor for lib-jitsi-meet's live JitsiConference (its own `_room`
    // field). Isolated here so the external underscore name appears once; every
    // caller in this function goes through it. (Page fns are injected via
    // page.evaluate and can't share a module-level helper.)
    const getConferenceRoom = () => conf._room;
    const localTrack = () => {
      try {
        const conferenceRoom = getConferenceRoom();
        return conferenceRoom && conferenceRoom.getLocalAudioTrack && conferenceRoom.getLocalAudioTrack();
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
    // DIAGNOSTIC: record the rebind decision + outcome so pageReadSamples can
    // surface WHY a bot stays silent (published track never becomes the tap).
    const pub = {
      hadTapTrack: Boolean(tapTrack),
      publishingTapBefore: publishingTap,
      rebindAttempted: false,
      rebindMethod: null,
      publishedIsTapAfter: null,
      rebindError: null,
    };
    window.__trussalAudioPublish = pub;
    if (!publishingTap && window.JitsiMeetJS && typeof window.JitsiMeetJS.createLocalTracks === 'function') {
      pub.rebindAttempted = true;
      try {
        const tracks = await window.JitsiMeetJS.createLocalTracks({ devices: ['audio'] });
        const at = tracks && tracks[0];
        if (!at) {
          pub.rebindMethod = 'no-track-created';
        } else {
          if (typeof conf.useAudioStream === 'function') { pub.rebindMethod = 'useAudioStream'; await conf.useAudioStream(at); }
          else { const conferenceRoom = getConferenceRoom(); if (conferenceRoom && conferenceRoom.addTrack) { pub.rebindMethod = 'addTrack'; await conferenceRoom.addTrack(at); } else { pub.rebindMethod = 'no-attach-api'; } }
          // Did the swap actually make the tap the published track?
          const after = localTrack();
          const afterMst = after && typeof after.getTrack === 'function' ? after.getTrack() : null;
          const newTap = window.__trussalMicStream && window.__trussalMicStream.getAudioTracks()[0];
          pub.publishedIsTapAfter = Boolean(newTap && afterMst && afterMst === newTap);
        }
      } catch (e) {
        // Do NOT swallow: an error here is exactly the silent-bot failure. Record +
        // log so the diag and container logs surface it. DIAGNOSTIC build: log but
        // don't throw — throwing trips the conductor replace policy and churns the
        // bot before we can read the diag. Restore log+throw once the cause is fixed.
        pub.rebindError = String((e && e.message) || e);
        console.error('[trussal] audio rebind failed', e);
      }
    }

    // DIAGNOSTIC: poll the bot's OWN RTCPeerConnection for the outbound audio
    // media-source level — the ENCODER's view of the published track, free of any
    // WebAudio measurement artifact (mirrors NetStats.js peerConnections access).
    // audioLevel>0 => real audio reaches the encoder; ==0 => the published track is
    // silent at the source. Poll (not one-shot): the PC/source appears after join.
    if (!window.__trussalOutboundProbe) {
      window.__trussalOutboundProbe = true;
      const readOutbound = async () => {
        try {
          const conferenceRoom = getConferenceRoom();
          const pcMap = conferenceRoom && conferenceRoom.rtc && conferenceRoom.rtc.peerConnections;
          const peerConnections = [...((pcMap && ((pcMap.values && pcMap.values()) || pcMap)) || [])]
            .map((tpc) => tpc && tpc.peerconnection)
            .filter((pc) => pc && typeof pc.getStats === 'function');
          const reports = await Promise.all(peerConnections.map((pc) => pc.getStats()));
          const audioSources = reports.flatMap((report) => [...report.values()]
            .filter((stat) => stat.type === 'media-source' && stat.kind === 'audio')
            .map((stat) => ({ audioLevel: stat.audioLevel ?? null, totalAudioEnergy: stat.totalAudioEnergy ?? null })));
          // Last match wins (mirrors the prior overwrite); null-ish when no source yet.
          window.__trussalOutboundAudio = audioSources.at(-1) || { audioLevel: null, totalAudioEnergy: null, note: 'no audio media-source' };
        } catch (e) {
          window.__trussalOutboundAudio = { error: String((e && e.message) || e) };
        }
      };
      setInterval(readOutbound, 1000);
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
 * After the bot has joined, make sure its Hydra canvas is actually published as
 * a live video track (the bot's "camera"). Like audio, startWithVideoMuted=false
 * is not enough headlessly — lib-jitsi-meet never requests the camera on its own
 * (gUM is only ever called for audio), so the Hydra canvas stream from the gUM
 * override is never published and the bot's tile stays blank. Drive jitsi-meet
 * directly: ask it to unmute video (which triggers a gUM → our canvas override),
 * falling back to creating the track explicitly.
 */
export async function pageEnsureVideoPublished() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const APP = globalThis.APP;
    const conf = APP && APP.conference;
    if (!conf) return;
    const room = () => conf._room || conf.room;
    const localTrack = () => { try { const r = room(); return r && r.getLocalVideoTrack && r.getLocalVideoTrack(); } catch (e) { return null; } };

    // 1) Ask jitsi-meet to unmute video; if it had no/muted track this triggers
    //    a gUM (→ our Hydra canvas stream) and publishes it.
    if (typeof conf.muteVideo === 'function') {
      try { await conf.muteVideo(false); } catch (e) {}
      await sleep(1500);
    }

    // 2) Fallback: explicitly create the video track and attach it.
    //    createLocalTracks(['video']) runs through our gUM override → canvas.
    if (!localTrack() && window.JitsiMeetJS && typeof window.JitsiMeetJS.createLocalTracks === 'function') {
      try {
        const tracks = await window.JitsiMeetJS.createLocalTracks({ devices: ['video'] });
        const vt = tracks && tracks[0];
        if (vt) {
          if (typeof conf.useVideoStream === 'function') await conf.useVideoStream(vt);
          else { const r = room(); if (r && r.addTrack) await r.addTrack(vt); }
        }
      } catch (e) {}
    }
  } catch (e) {}
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
export async function pageStrudelBoot({ strudel, hydra }) {
  window.__trussalErrors = window.__trussalErrors || [];
  window.__trussalReportError = (e) => window.__trussalErrors.push(String((e && e.stack) || e));
  // The ';' is load-bearing: hydra ends in an expression and the strudel
  // wrapper starts with '(' — joined by bare newline, ASI reads it as a
  // call: `out(o0)(stack(...))`, which throws inside Strudel's own error
  // handling ("no pattern yet") where our reporter can't see it.
  const code = `${hydra};\n${strudel}`;
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
      try { window.__trussalAnnounceLocalPattern(strudel); } catch (_) {}
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
 * Each buffer is identified by the peer's Net Cycles room-index token (0 for the
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
 */
export function pageAggregatorCapture() {
  if (window.__trussalAggCapture) return;
  const store = new Map();            // endpoint jitsiId -> number[] of accumulated mono PCM
  const tappedTracks = new WeakSet(); // remote audio JitsiTracks already wired
  const FRAME = 2048;
  const MAX_BACKLOG = FRAME * 64;     // cap page-side buffering if Node never drains

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
    tappedTracks.add(jitsiTrack);
  }

  // Enumerate remote participants (the authoritative source — getParticipants()
  // excludes self) and tap each one's audio tracks, keyed by the member's endpoint
  // id. The room-not-ready guard returns quietly during startup; once ready the
  // lib-jitsi-meet accessors are called directly, so an unexpected API shape throws
  // loudly rather than silently capturing nothing — and a throw here does NOT wedge
  // the loop (setInterval keeps firing; unresolved/idle members drop out at drain).
  function scan() {
    const conf = globalThis.APP && globalThis.APP.conference;
    const room = conf && conf._room;
    if (!room || typeof room.getParticipants !== 'function') return; // conference not ready yet
    room.getParticipants()
      .filter((participant) => participant.getId())
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
      const out = [];
      for (const [jitsiId, arr] of store) {
        if (!arr.length) continue;
        const token = typeof resolve === 'function' ? resolve(jitsiId) : null;
        if (token == null) continue; // room index not announced yet — keep buffering
        // Carry the jitsiId (the endpoint id) alongside the resolved token so the
        // aggregator can pin the source -> token mapping ONCE for the whole meeting,
        // rather than re-resolving it on every drain.
        out.push({ jitsiId: String(jitsiId), token: String(token), samples: arr.splice(0) });
      }
      return out;
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
  let ctx = null, proc = null;

  function ensure() {
    if (ctx) return;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
    proc = ctx.createScriptProcessor(FRAME, 1, 1);
    proc.onaudioprocess = (ev) => {
      const out = ev.outputBuffer.getChannelData(0);
      for (let i = 0; i < out.length; i++) {
        if (!chunks.length) { out[i] = 0; continue; } // starved -> silence
        out[i] = chunks[0][head++];
        if (head >= chunks[0].length) { chunks.shift(); head = 0; }
      }
    };
    // fan -> MediaStreamDestination (this bot's mic -> every other client) + hardware
    proc.connect(ctx.destination);
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
  };
}

/** Push assembled master-mix PCM (a plain Array) into the page playback sink. */
export function pageEnqueueMaster(samples) {
  const p = window.__trussalMasterPlayer;
  return (p && typeof p.enqueue === 'function') ? p.enqueue(samples) : 0;
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
  const readTapRmsNative = window.__trussalReadTapRmsNative;
  // DIAGNOSTIC: live each tick — is the CURRENTLY published local audio track the
  // fan's tap, or some other (silent) track? Decisive silent-bot signal alongside
  // fanRms/tapRms: publishedIsTap===false while fanRms>0 means the rebind never
  // made the tap the published track.
  let publishedIsTap = null;
  try {
    const conference = globalThis.APP && globalThis.APP.conference;
    const conferenceRoom = conference && conference._room;
    const localTrack = conferenceRoom && conferenceRoom.getLocalAudioTrack && conferenceRoom.getLocalAudioTrack();
    const localTrackMst = localTrack && typeof localTrack.getTrack === 'function' ? localTrack.getTrack() : null;
    const tapTrack = window.__trussalMicStream && window.__trussalMicStream.getAudioTracks()[0];
    if (localTrackMst && tapTrack) publishedIsTap = localTrackMst === tapTrack;
  } catch (e) { publishedIsTap = null; }
  const audio = {
    fanRms: typeof readFanRms === 'function' ? readFanRms() : null,
    tapRmsNative: typeof readTapRmsNative === 'function' ? readTapRmsNative() : null,
    normTapRms: typeof window.__trussalReadNormTapRms === 'function' ? window.__trussalReadNormTapRms() : null,
    laundryCalls: window.__trussalLaundryCalls ?? null,
    laundryInPeak: (() => { const peak = window.__trussalLaundryInPeak; if (window.__trussalLaundryInPeak != null) window.__trussalLaundryInPeak = 0; return peak ?? null; })(),
    channelDiag: window.__trussalChannelDiag ?? null,
    publishedIsTap,
    publishState: window.__trussalAudioPublish ?? null,
    outboundAudio: window.__trussalOutboundAudio ?? null,
    fanChannelCount: fan ? fan.channelCount : null,
    fanMaxChannelCount: fan ? fan.maxChannelCount : null,
    hardwareMaxChannelCount: window.__trussalHardwareMaxChannelCount ?? null,
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

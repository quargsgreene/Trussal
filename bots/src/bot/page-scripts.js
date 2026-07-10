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
    const room = () => conf._room || conf.room;
    const localTrack = () => { try { const r = room(); return r && r.getLocalAudioTrack && r.getLocalAudioTrack(); } catch (e) { return null; } };

    // 1) Ask jitsi-meet to unmute; if it had no/muted track this triggers a
    //    gUM (→ our tap) and publishes it.
    if (typeof conf.muteAudio === 'function') {
      try { await conf.muteAudio(false); } catch (e) {}
      await sleep(1500);
    }

    // 2) Fallback: explicitly create the audio track and attach it.
    //    createLocalTracks(['audio']) runs through our gUM override → tap.
    if (!localTrack() && window.JitsiMeetJS && typeof window.JitsiMeetJS.createLocalTracks === 'function') {
      try {
        const tracks = await window.JitsiMeetJS.createLocalTracks({ devices: ['audio'] });
        const at = tracks && tracks[0];
        if (at) {
          if (typeof conf.useAudioStream === 'function') await conf.useAudioStream(at);
          else { const r = room(); if (r && r.addTrack) await r.addTrack(at); }
        }
      } catch (e) {}
    }
  } catch (e) {}
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
 * before Jitsi renders any remote participant. Jitsi plays every remote peer's
 * audio through its own <audio> element (id "remoteAudio_<jitsiId>"); this scans
 * for those elements and taps each one into a ScriptProcessor, accumulating that
 * peer's PCM into a page-side store keyed by the peer's jitsiId. The Node side
 * drains it (via pageDrainParticipantAudio) into the AggregatorBot's
 * per-participant ring buffers — the "clients -> individual buffer queues" hop.
 *
 * Each buffer is identified by the peer's Net Cycles room-index token (0 for the
 * first human, 0a/0b/… for that human's bots, 1 for the next human, …). The tap
 * stores under jitsiId and resolves to the token at drain time via
 * window.__trussalRoomIndexForJitsiId (exposed by the Trussal bundle from the
 * already-maintained jitsiId↔roomIndex mapper) — so buffers are only ever keyed
 * by room index, and a peer whose index the sidecar hasn't announced yet is held
 * (capped) until it resolves.
 *
 * Self-contained per the module contract: it touches only page globals and its
 * own closures. It reuses the shared AudioContext (pageAudioBridge wraps the
 * constructor so `new AudioContext()` returns one instance), so the tap lives
 * in the same graph as everything else on the page.
 */
export function pageAggregatorCapture() {
  if (window.__trussalAggCapture) return;
  const store = new Map();       // jitsiId -> number[] of accumulated mono PCM
  const tapped = new WeakSet();  // <audio> elements already wired
  const FRAME = 2048;
  const MAX_BACKLOG = FRAME * 64; // cap page-side buffering if Node never drains

  function jitsiIdFor(el) {
    const m = /^remoteAudio_(.+)$/.exec(el.id || '');
    return m ? m[1] : null;
  }

  function tap(el) {
    if (tapped.has(el)) return;
    const jitsiId = jitsiIdFor(el);
    if (!jitsiId) return; // only remote participant audio, never the bot's own
    let ctx;
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return; }
    let src;
    // createMediaElementSource throws if the element is already tapped; skip it.
    try { src = ctx.createMediaElementSource(el); } catch (e) { tapped.add(el); return; }
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
    tapped.add(el);
  }

  function scan() { for (const el of document.querySelectorAll('audio')) tap(el); }
  setInterval(scan, 1000); // peers' <audio> elements appear as they join
  scan();

  window.__trussalAggCapture = {
    drain() {
      const resolve = window.__trussalRoomIndexForJitsiId;
      const out = [];
      for (const [jitsiId, arr] of store) {
        if (!arr.length) continue;
        const token = typeof resolve === 'function' ? resolve(jitsiId) : null;
        if (token == null) continue; // room index not announced yet — keep buffering
        out.push({ token: String(token), samples: arr.splice(0) });
      }
      return out;
    },
  };
}

/** Drain the accumulated per-participant PCM the aggregator tap has captured. */
export function pageDrainParticipantAudio() {
  return (window.__trussalAggCapture && window.__trussalAggCapture.drain()) || [];
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
  return {
    fps: window.__trussalFps ?? 0,
    errors: (window.__trussalErrors || []).splice(0),
    diag: {
      canvases: document.querySelectorAll('canvas').length,
      strudelMounted: Boolean(editor && editor.editor),
      schedulerStarted: Boolean(repl && repl.scheduler && repl.scheduler.started),
      jitsiJoined: Boolean(globalThis.APP && globalThis.APP.conference
        && globalThis.APP.conference.isJoined && globalThis.APP.conference.isJoined()),
    },
  };
}

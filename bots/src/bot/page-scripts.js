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

  // Diagnostic: capture console errors/warnings + uncaught errors so Strudel/
  // superdough audio-init failures (worklet load, channel config, missing
  // sounds) surface in the metrics diag instead of being swallowed in-page.
  const conBuf = (window.__trussalConsole = window.__trussalConsole || []);
  const push = (m) => { conBuf.push(String(m).slice(0, 300)); if (conBuf.length > 60) conBuf.shift(); };
  for (const level of ['error', 'warn']) {
    const orig = console[level] && console[level].bind(console);
    if (orig) console[level] = (...a) => { try { push(level + ': ' + a.map((x) => (x && x.stack) || String(x)).join(' ')); } catch (e) {} return orig(...a); };
  }
  window.addEventListener('error', (e) => push('onerror: ' + (e.message || e)));
  window.addEventListener('unhandledrejection', (e) => push('reject: ' + ((e.reason && e.reason.stack) || e.reason)));

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
    // Diagnostic: measure the live signal reaching our fan (= what Strudel
    // sends to ctx.destination). 0 while playing ⇒ no audio reaches the tap.
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    fan.connect(analyser);
    window.__trussalTapAnalyser = analyser;
    window.__trussalMicStream = tap.stream;
    window.__trussalAudioCtx = ctx;
    window.__trussalHardware = hardware; // real AudioDestinationNode, for diag
    return ctx;
  }

  function Wrapped(...args) { if (!shared) shared = build(args); return shared; }
  Wrapped.prototype = Native.prototype;
  Wrapped.__trussalWrapped = true;
  window.AudioContext = Wrapped;
  window.webkitAudioContext = Wrapped;
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

  window.__trussalGumCalls = window.__trussalGumCalls || [];
  navigator.mediaDevices.getUserMedia = async (constraints = {}) => {
    const rec = { audio: !!constraints.audio, video: !!constraints.video, usedTap: false };
    window.__trussalGumCalls.push(rec);
    const stream = new MediaStream();
    if (constraints.video) {
      const canvas = await waitForCanvas();
      // captureFps is a bandwidth guard: 15 fps halves encode + uplink cost
      // vs 30 with little visual loss for slow-evolving Hydra patterns.
      const cs = canvas.captureStream(captureFps);
      const vts = cs.getVideoTracks();
      rec.canvas = { id: canvas.id, cls: String(canvas.className), w: canvas.width, h: canvas.height };
      rec.vsettings = vts[0] && vts[0].getSettings ? vts[0].getSettings() : null;
      for (const t of vts) stream.addTrack(t);
    }
    if (constraints.audio) {
      const mic = window.__trussalMicStream;
      const tapTrack = mic && mic.getAudioTracks()[0];
      if (tapTrack) rec.usedTap = true;
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
 * track, create one explicitly and hand it to the conference. Every step is
 * logged to window.__trussalAudioLog for the metrics diag.
 */
export async function pageEnsureAudioPublished() {
  const log = (m) => { (window.__trussalAudioLog = window.__trussalAudioLog || []).push(String(m)); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const APP = globalThis.APP;
    const conf = APP && APP.conference;
    if (!conf) { log('no APP.conference'); return; }
    const room = () => conf._room || conf.room;
    const localTrack = () => { try { const r = room(); return r && r.getLocalAudioTrack && r.getLocalAudioTrack(); } catch (e) { return null; } };

    log('api muteAudio=' + typeof conf.muteAudio
      + ' useAudioStream=' + typeof conf.useAudioStream
      + ' JMJS=' + Boolean(window.JitsiMeetJS)
      + ' store=' + Boolean(APP.store));

    // 1) Ask jitsi-meet to unmute; if it had no/muted track this triggers a
    //    gUM (→ our tap) and publishes it.
    if (typeof conf.muteAudio === 'function') {
      try { await conf.muteAudio(false); log('muteAudio(false) called'); } catch (e) { log('muteAudio err ' + e); }
      await sleep(1500);
      log('after muteAudio track=' + Boolean(localTrack()));
    }

    // 2) Fallback: explicitly create the audio track and attach it.
    //    createLocalTracks(['audio']) runs through our gUM override → tap.
    if (!localTrack() && window.JitsiMeetJS && typeof window.JitsiMeetJS.createLocalTracks === 'function') {
      try {
        const tracks = await window.JitsiMeetJS.createLocalTracks({ devices: ['audio'] });
        const at = tracks && tracks[0];
        log('createLocalTracks -> ' + Boolean(at));
        if (at) {
          if (typeof conf.useAudioStream === 'function') { await conf.useAudioStream(at); log('useAudioStream ok'); }
          else { const r = room(); if (r && r.addTrack) { await r.addTrack(at); log('addTrack ok'); } else log('no attach api'); }
        }
      } catch (e) { log('createLocalTracks err ' + e); }
      await sleep(1000);
      log('after create track=' + Boolean(localTrack()));
    }
    const lt = localTrack();
    log('final track=' + Boolean(lt) + ' muted=' + (lt && lt.isMuted ? lt.isMuted() : 'n/a'));
  } catch (e) { log('ensure fatal ' + e); }
}

/**
 * After the bot has joined, make sure its Hydra canvas is actually published as
 * a live video track (the bot's "camera"). Like audio, startWithVideoMuted=false
 * is not enough headlessly — lib-jitsi-meet never requests the camera on its own
 * (gUM is only ever called for audio), so the Hydra canvas stream from the gUM
 * override is never published and the bot's tile stays blank. Drive jitsi-meet
 * directly: ask it to unmute video (which triggers a gUM → our canvas override),
 * falling back to creating the track explicitly. Logged to window.__trussalVideoLog.
 */
export async function pageEnsureVideoPublished() {
  const log = (m) => { (window.__trussalVideoLog = window.__trussalVideoLog || []).push(String(m)); };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    const APP = globalThis.APP;
    const conf = APP && APP.conference;
    if (!conf) { log('no APP.conference'); return; }
    const room = () => conf._room || conf.room;
    const localTrack = () => { try { const r = room(); return r && r.getLocalVideoTrack && r.getLocalVideoTrack(); } catch (e) { return null; } };

    log('api muteVideo=' + typeof conf.muteVideo
      + ' useVideoStream=' + typeof conf.useVideoStream
      + ' JMJS=' + Boolean(window.JitsiMeetJS));

    // 1) Ask jitsi-meet to unmute video; if it had no/muted track this triggers
    //    a gUM (→ our Hydra canvas stream) and publishes it.
    if (typeof conf.muteVideo === 'function') {
      try { await conf.muteVideo(false); log('muteVideo(false) called'); } catch (e) { log('muteVideo err ' + e); }
      await sleep(1500);
      log('after muteVideo track=' + Boolean(localTrack()));
    }

    // 2) Fallback: explicitly create the video track and attach it.
    //    createLocalTracks(['video']) runs through our gUM override → canvas.
    if (!localTrack() && window.JitsiMeetJS && typeof window.JitsiMeetJS.createLocalTracks === 'function') {
      try {
        const tracks = await window.JitsiMeetJS.createLocalTracks({ devices: ['video'] });
        const vt = tracks && tracks[0];
        log('createLocalTracks -> ' + Boolean(vt));
        if (vt) {
          if (typeof conf.useVideoStream === 'function') { await conf.useVideoStream(vt); log('useVideoStream ok'); }
          else { const r = room(); if (r && r.addTrack) { await r.addTrack(vt); log('addTrack ok'); } else log('no attach api'); }
        }
      } catch (e) { log('createLocalTracks err ' + e); }
      await sleep(1000);
      log('after create track=' + Boolean(localTrack()));
    }
    const lt = localTrack();
    log('final track=' + Boolean(lt) + ' muted=' + (lt && lt.isMuted ? lt.isMuted() : 'n/a'));

    // Diagnostic: sample outbound RTP so we can see whether the browser is
    // actually encoding+sending video frames (vs. having a live track that
    // produces nothing, vs. having no video sender at all).
    const findPC = () => {
      try {
        const r = room();
        const rtc = r && r.rtc;
        const pcs = rtc && (rtc.peerConnections || rtc._peerConnections);
        let tpc = null;
        if (pcs && pcs.values) { for (const v of pcs.values()) { tpc = v; break; } }
        tpc = tpc || (r && r.jvbJingleSession && r.jvbJingleSession.peerconnection);
        return tpc && (tpc.peerconnection || tpc.pc || tpc);
      } catch (e) { return null; }
    };
    setInterval(async () => {
      try {
        const pc = findPC();
        if (!pc || !pc.getStats) { window.__trussalVideoStats = { pc: false }; return; }
        const stats = await pc.getStats();
        const o = { pc: true, senders: 0 };
        stats.forEach((s) => {
          if (s.type === 'outbound-rtp' && (s.kind === 'video' || s.mediaType === 'video')) {
            o.senders++;
            o.vid = { framesEncoded: s.framesEncoded, framesSent: s.framesSent, bytesSent: s.bytesSent, w: s.frameWidth, h: s.frameHeight, qual: s.qualityLimitationReason, active: s.active };
          }
          if (s.type === 'outbound-rtp' && (s.kind === 'audio' || s.mediaType === 'audio')) {
            o.aud = { bytesSent: s.bytesSent, packetsSent: s.packetsSent };
          }
        });
        window.__trussalVideoStats = o;
      } catch (e) { window.__trussalVideoStats = { err: String(e) }; }
    }, 3000);
  } catch (e) { log('ensure fatal ' + e); }
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
  } catch (e) {
    window.__trussalReportError(e);
  }
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
      audio: (() => {
        const out = {};
        try {
          const ctx = window.__trussalAudioCtx;
          out.ctxState = ctx ? ctx.state : 'no-ctx';
          const mic = window.__trussalMicStream;
          const t = mic && mic.getAudioTracks()[0];
          out.tap = t ? { readyState: t.readyState, enabled: t.enabled, muted: t.muted } : null;
        } catch (e) { out.tapErr = String(e); }
        try {
          const conf = globalThis.APP && globalThis.APP.conference;
          out.localAudioMuted = conf && conf.isLocalAudioMuted ? conf.isLocalAudioMuted() : 'no-api';
          // Probe lib-jitsi-meet for an actual published local audio track.
          const room = conf && (conf._room || conf.room);
          const lat = room && room.getLocalAudioTrack && room.getLocalAudioTrack();
          if (lat) {
            const mt = lat.getTrack && lat.getTrack();
            out.jitsiAudioTrack = {
              muted: lat.isMuted ? lat.isMuted() : null,
              readyState: mt ? mt.readyState : null,
              enabled: mt ? mt.enabled : null,
            };
          } else {
            out.jitsiAudioTrack = null;
          }
          // Probe lib-jitsi-meet for a published local video track (Hydra cam).
          const lvt = room && room.getLocalVideoTrack && room.getLocalVideoTrack();
          if (lvt) {
            const vt = lvt.getTrack && lvt.getTrack();
            out.jitsiVideoTrack = {
              muted: lvt.isMuted ? lvt.isMuted() : null,
              readyState: vt ? vt.readyState : null,
              enabled: vt ? vt.enabled : null,
            };
          } else {
            out.jitsiVideoTrack = null;
          }
        } catch (e) { out.jitsiErr = String(e); }
        // Diagnostic: live RMS of what reaches our shared-context destination.
        try {
          const an = window.__trussalTapAnalyser;
          if (an) {
            const buf = new Float32Array(an.fftSize);
            an.getFloatTimeDomainData(buf);
            let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i];
            out.fanRms = Math.sqrt(s / buf.length);
          } else { out.fanRms = 'no-analyser'; }
        } catch (e) { out.fanRmsErr = String(e); }
        // Diagnostic: identify the AudioContext Strudel actually renders into,
        // and whether it is the same object whose destination feeds our tap.
        try {
          const shared = window.__trussalAudioCtx;
          const editor = document.querySelector('strudel-editor');
          const repl = editor && editor.editor && editor.editor.repl;
          const sched = repl && repl.scheduler;
          const cand = {
            'window.getAudioContext()': typeof window.getAudioContext === 'function' ? window.getAudioContext() : undefined,
            'editor.editor.audioContext': editor && editor.editor && editor.editor.audioContext,
            'repl.audioContext': repl && repl.audioContext,
            'sched.audioContext': sched && sched.audioContext,
            'sched.worker && sched.getAudioContext': sched && typeof sched.getAudioContext === 'function' ? sched.getAudioContext() : undefined,
          };
          const info = {};
          for (const k of Object.keys(cand)) {
            const v = cand[k];
            if (v) info[k] = { ctor: v.constructor && v.constructor.name, isShared: v === shared, sameDest: shared && v.destination === shared.destination, state: v.state };
          }
          out.strudelCtx = info;
          out.wrapInstalled = Boolean(window.AudioContext && window.AudioContext.__trussalWrapped);
        } catch (e) { out.strudelCtxErr = String(e); }
        // Diagnostic: is the destination Strudel sees a real AudioDestinationNode
        // (has maxChannelCount) or our GainNode fan (undefined → may break init)?
        try {
          const shared = window.__trussalAudioCtx;
          const seen = shared && shared.destination;
          const hw = window.__trussalHardware;
          out.destInfo = {
            seenCtor: seen && seen.constructor && seen.constructor.name,
            seenMaxCC: seen && seen.maxChannelCount,
            seenCC: seen && seen.channelCount,
            hwCtor: hw && hw.constructor && hw.constructor.name,
            hwMaxCC: hw && hw.maxChannelCount,
          };
        } catch (e) { out.destErr = String(e); }
        out.console = (window.__trussalConsole || []).slice(-30);
        out.gumCalls = window.__trussalGumCalls || [];
        out.log = window.__trussalAudioLog || [];
        out.videoLog = window.__trussalVideoLog || [];
        // Diagnostic: enumerate canvases so we can tell which one the gUM
        // override captured and whether it's the animated Hydra output.
        try {
          out.canvasList = [...document.querySelectorAll('canvas')].map((c) => ({
            id: c.id, cls: String(c.className), w: c.width, h: c.height,
            vis: !!(c.offsetWidth || c.offsetHeight || c.getClientRects().length),
          }));
        } catch (e) { out.canvasErr = String(e); }
        out.videoStats = window.__trussalVideoStats || null;
        return out;
      })(),
    },
  };
}

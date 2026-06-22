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

  // Build the shared context and tap eagerly (autoplay-policy flag lets it
  // start without a gesture). Strudel's later `new AudioContext()` returns
  // this same instance, so its output lands on our fan.
  const shared = new Native();
  const hardware = shared.destination; // real device → ALSA loopback → Jamulus
  const tap = shared.createMediaStreamDestination(); // → Jitsi mic track
  const fan = shared.createGain();
  fan.connect(hardware);
  fan.connect(tap);
  Object.defineProperty(shared, 'destination', {
    configurable: true,
    get: () => fan,
  });
  window.__trussalMicStream = tap.stream;

  function Wrapped() { return shared; }
  Wrapped.prototype = Native.prototype;
  Wrapped.__trussalWrapped = true;
  window.AudioContext = Wrapped;
  window.webkitAudioContext = Wrapped;
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
    },
  };
}

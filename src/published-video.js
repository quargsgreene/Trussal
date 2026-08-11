// published-video.js — what a participant's video track actually carries.
//
// A performer's camera never reaches the wire. What the room sees in someone's
// tile is their Hydra output, or black when they are not running any — the
// camera only ever becomes visible by being drawn INTO Hydra (`src(s0)`), or
// locally in the landmarks UI, which is a panel on their own page and is not
// published at all.
//
// The mechanism is the same one the bots use: intercept getUserMedia and hand
// back a canvas capture instead of a camera. The canvas is a compositor that
// mirrors `#hydra-canvas` when it exists and paints black when it doesn't, so
// starting and stopping Hydra changes what the room sees without ever
// re-negotiating the track.
//
// hydra-video.js still needs the real camera (that is what feeds `s0`), so the
// pre-override getUserMedia is kept and exported as openCamera().

const CANVAS_ID = 'trussal-published-video';
const CAPTURE_FPS = 15;
const FRAME_INTERVAL_MS = 1000 / CAPTURE_FPS;

let realGetUserMedia = null;
let canvas = null;
let ctx = null;
let rafId = null;
let lastDrawMs = -Infinity;

// The camera, for the code that legitimately wants it: hydra-video.js's `s0`
// feed and its local panel. Bypasses the override below — that exists to stop
// the camera being PUBLISHED, not to stop it being used.
export function openCamera(constraints = { video: true }) {
  const gum = realGetUserMedia
    || navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  return gum(constraints);
}

function ensureCanvas(width, height) {
  if (canvas) return canvas;
  canvas = document.createElement('canvas');
  canvas.id = CANVAS_ID;
  canvas.width = width;
  canvas.height = height;
  // Kept out of sight but composited: a display:none canvas is not guaranteed
  // to produce frames.
  canvas.style.cssText = 'position:fixed;left:-20000px;top:0;pointer-events:none;';
  (document.body || document.documentElement).appendChild(canvas);
  ctx = canvas.getContext('2d');
  startCompositing();
  return canvas;
}

// Mirror the Hydra canvas each frame, letterboxed to preserve its aspect, or
// paint black when there is none. Reading `#hydra-canvas` per frame rather
// than caching it is deliberate: initHydra() REPLACES the element on every
// re-init, so a cached reference would silently freeze on a dead canvas.
function drawFrame(now) {
  rafId = requestAnimationFrame(drawFrame);
  if (!ctx) return;
  // captureStream(CAPTURE_FPS) only ever samples this canvas at 15fps, so
  // compositing it at display refresh rate (~60fps) draws roughly 4x more
  // than any consumer reads. Match the draw rate to the capture rate instead.
  if (now - lastDrawMs < FRAME_INTERVAL_MS) return;
  lastDrawMs = now;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  const hydra = document.getElementById('hydra-canvas');
  if (!hydra || !hydra.width || !hydra.height) return;
  const scale = Math.min(canvas.width / hydra.width, canvas.height / hydra.height);
  const w = hydra.width * scale;
  const h = hydra.height * scale;
  try {
    ctx.drawImage(hydra, (canvas.width - w) / 2, (canvas.height - h) / 2, w, h);
  } catch (e) {
    // A canvas mid-teardown throws; the next frame picks up the new one.
    console.error('[published-video] could not draw the Hydra canvas', e);
  }
}

function startCompositing() {
  if (rafId == null) rafId = requestAnimationFrame(drawFrame);
}

/**
 * Replace the camera with the published canvas for every video getUserMedia.
 * Audio requests pass straight through. Idempotent.
 *
 * Installed as early as the bundle runs, so lib-jitsi-meet's first camera
 * request already resolves to the canvas — there is no window in which a real
 * camera frame could be published.
 */
export function installPublishedVideoOverride({ width = 640, height = 360 } = {}) {
  if (realGetUserMedia) return;
  const media = navigator.mediaDevices;
  if (!media || typeof media.getUserMedia !== 'function') {
    console.error('[published-video] no navigator.mediaDevices.getUserMedia to override');
    return;
  }
  realGetUserMedia = media.getUserMedia.bind(media);

  media.getUserMedia = async (constraints = {}) => {
    if (!constraints.video) return realGetUserMedia(constraints);

    const stream = new MediaStream();
    for (const track of ensureCanvas(width, height).captureStream(CAPTURE_FPS).getVideoTracks()) {
      stream.addTrack(track);
    }
    // A combined audio+video request still needs its real microphone.
    if (constraints.audio) {
      const mic = await realGetUserMedia({ audio: constraints.audio });
      for (const track of mic.getAudioTracks()) stream.addTrack(track);
    }
    return stream;
  };
}

/**
 * Join with video off. Participants opt IN to being seen; the toolbar's camera
 * button still works and publishes the canvas above.
 *
 * Set on `config` rather than by muting after the join, because the bundle is
 * APPENDED TO config.js by the web container (web/rootfs/.../10-config), so
 * this runs while config is still just an object and well before the app reads
 * it — there is no window in which video is briefly live.
 */
export function startWithVideoMuted() {
  const config = window.config;
  if (!config) {
    console.error('[published-video] no window.config — cannot default video off');
    return;
  }
  config.startWithVideoMuted = true;
}

// Test seam: drop the override and the canvas so a suite can install it again.
export function resetPublishedVideo() {
  if (realGetUserMedia) navigator.mediaDevices.getUserMedia = realGetUserMedia;
  realGetUserMedia = null;
  if (rafId != null) cancelAnimationFrame(rafId);
  rafId = null;
  if (canvas) canvas.remove();
  canvas = null;
  ctx = null;
}

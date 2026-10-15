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
//
// Publication is explicit: a conference only ever publishes a track someone
// adds, so the ensureVideoPublished()/unpublishVideo() pair below is that path,
// built on the same canvas the override already serves — so the published
// pixels are the Hydra output and the raw camera still never reaches the wire.

import { getConference } from './meeting-adapter.js';

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

// Explicit local video track plumbing.
//
// A direct lib-jitsi-meet conference has no camera button: it only ever
// publishes a track someone explicitly adds. `ensureVideoPublished()` drives
// that publication: create a video track (routed through the override above)
// and add it to the conference. Both functions take the conference/test doubles
// as options so the path stays unit-testable outside a browser, and both are
// inert until a caller runs them.
// ---------------------------------------------------------------------------

const PUBLISH_POLL_MS = 150;
const PUBLISH_WAIT_MS = 3000;

// The one track this module last published. Kept here (rather than re-derived
// from the conference every time) because a renegotiation can leave the
// conference object briefly unaware of the live track; the seam makes the
// previous one reachable for unpublish/teardown.
let publishedTrack = null;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function libJitsiGlobal() {
  try {
    return (typeof window !== 'undefined' && window.JitsiMeetJS) ? window.JitsiMeetJS : null;
  } catch (e) {
    return null;
  }
}

function roomFor(conf) {
  if (!conf) return null;
  // The object that actually owns the track API. Prefer `_room` if a wrapper
  // parked the JitsiConference there; otherwise the conference itself (a bare
  // JitsiConference IS that object). NB: a real JitsiConference ALSO exposes
  // `conf.room`, but that is its XMPP room (addListener/muteParticipant — no
  // track API), so it must never be chosen over the conference. Capability-check
  // each candidate so a wrapper that parks the conference on `.room` still
  // resolves.
  const hasTrackApi = (o) => !!o && (typeof o.addTrack === 'function' || typeof o.removeTrack === 'function');
  if (hasTrackApi(conf._room)) return conf._room;
  if (hasTrackApi(conf)) return conf;
  if (hasTrackApi(conf.room)) return conf.room;
  return conf._room || conf;
}

function isVideoTrack(track) {
  if (!track) return false;
  try {
    if (typeof track.isVideoTrack === 'function') return track.isVideoTrack();
  } catch (e) { /* fall through to the shape checks */ }
  return track.type === 'video' || track.kind === 'video';
}

// The live local video track, wherever the backend keeps it. Jitsi Meet's APP
// conference exposes getLocalVideoTrack(); a bare lib-jitsi-meet JitsiConference
// keeps its JitsiLocalTracks in `_localTracks`.
function readLocalVideoTrack(conf) {
  try {
    if (!conf) return null;
    if (typeof conf.getLocalVideoTrack === 'function') {
      const track = conf.getLocalVideoTrack();
      if (track) return track;
    }
    const room = conf._room;
    if (room && typeof room.getLocalVideoTrack === 'function') {
      const track = room.getLocalVideoTrack();
      if (track) return track;
    }
    for (const list of [conf._localTracks, room && room._localTracks]) {
      if (!Array.isArray(list)) continue;
      const track = list.find(isVideoTrack);
      if (track) return track;
    }
  } catch (e) {
    console.warn('[published-video] reading the local video track failed', e);
  }
  return null;
}

async function waitForLocalVideoTrack(conf, timeoutMs) {
  const startedAt = Date.now();
  for (;;) {
    const track = readLocalVideoTrack(conf);
    if (track) return track;
    if (Date.now() - startedAt >= timeoutMs) return null;
    await sleep(PUBLISH_POLL_MS);
  }
}

async function attachVideoTrack(conf, track) {
  try {
    // Jitsi Meet's APP conference takes the track through useVideoStream; a
    // bare lib-jitsi-meet conference only has addTrack.
    if (typeof conf.useVideoStream === 'function') {
      await conf.useVideoStream(track);
      return true;
    }
    const room = roomFor(conf);
    if (room && typeof room.addTrack === 'function') {
      await room.addTrack(track);
      return true;
    }
  } catch (e) {
    console.warn('[published-video] attaching the video track failed', e);
  }
  return false;
}

/** Track this module last published, or null. Test/inspection seam. */
export function getPublishedVideoTrack() {
  return publishedTrack;
}

export function setPublishedVideoTrack(track) {
  publishedTrack = track || null;
  return publishedTrack;
}

export function clearPublishedVideoTrack() {
  publishedTrack = null;
}

export function hasPublishedVideoTrack() {
  return !!publishedTrack;
}

/**
 * Publish the composited canvas as the local video track, if it is not already
 * published. Backend-agnostic and idempotent: a live local track short-circuits.
 *
 * Returns true when the conference now has a local video track.
 */
export async function ensureVideoPublished({ conference, JitsiMeetJS, waitMs = PUBLISH_WAIT_MS } = {}) {
  const conf = conference || getConference();
  if (!conf) return false;

  const existing = readLocalVideoTrack(conf);
  if (existing) {
    setPublishedVideoTrack(existing);
    return true;
  }

  // Path 1 — the conference's own unmute. It triggers gUM (the override above
  // answers with the canvas) and publishes the result. This is exactly what a
  // toolbar camera button does, so that path is unchanged.
  if (typeof conf.muteVideo === 'function') {
    try {
      await conf.muteVideo(false);
    } catch (e) {
      console.warn('[published-video] muteVideo(false) failed', e);
    }
    const track = await waitForLocalVideoTrack(conf, waitMs);
    if (track) {
      setPublishedVideoTrack(track);
      return true;
    }
  }

  // Path 2 — direct lib-jitsi-meet. No muteVideo to lean on: create the track
  // (through the same override) and attach it explicitly.
  const meetjs = JitsiMeetJS || libJitsiGlobal();
  if (meetjs && typeof meetjs.createLocalTracks === 'function') {
    let tracks = null;
    try {
      tracks = await meetjs.createLocalTracks({ devices: ['video'] });
    } catch (e) {
      console.warn('[published-video] createLocalTracks failed', e);
    }
    const track = Array.isArray(tracks) ? tracks[0] : tracks;
    if (track && await attachVideoTrack(conf, track)) {
      const live = await waitForLocalVideoTrack(conf, waitMs);
      setPublishedVideoTrack(live || track);
      return true;
    }
  }

  return false;
}

/**
 * Wait for a conference to exist, then publish once. The lib-jitsi-meet
 * bootstrap connects asynchronously, so the Hydra camera gesture can fire
 * before getConference() is non-null. Deliberately does NOT retry after a
 * conference is present: a failure there could otherwise create a second track.
 */
export async function ensureVideoPublishedWhenReady({ attempts = 40, intervalMs = 500, ...options } = {}) {
  for (let i = 0; i < attempts; i++) {
    const conf = options.conference || getConference();
    if (conf) return ensureVideoPublished({ ...options, conference: conf });
    await sleep(intervalMs);
  }
  return false;
}

/**
 * Stop publishing the local video track. Prefers the conference's own
 * removeTrack/dispose path and falls back to the conference's muteVideo.
 * Idempotent.
 */
export async function unpublishVideo({ conference } = {}) {
  const conf = conference || getConference();
  const track = readLocalVideoTrack(conf) || publishedTrack;
  clearPublishedVideoTrack();
  if (!conf) return false;
  try {
    const room = roomFor(conf);
    if (track && room && typeof room.removeTrack === 'function') {
      await room.removeTrack(track);
      return true;
    }
    if (track && typeof track.dispose === 'function') {
      track.dispose();
      return true;
    }
    if (typeof conf.muteVideo === 'function') {
      await conf.muteVideo(true);
      return true;
    }
  } catch (e) {
    console.warn('[published-video] unpublishVideo failed', e);
  }
  return false;
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
  publishedTrack = null;
}

// Manual hooks for driving publication (the lib-jitsi-meet backend has no
// toolbar of its own, so these are the way in; they are inert until called).
// The bot bundle installs its own __trussalEnsureVideoPublished at
// document-start; never clobber that.
if (typeof window !== 'undefined' && !window.__trussalIsBot && !window.__trussalIsAggregator) {
  if (typeof window.__trussalEnsureVideoPublished !== 'function') {
    window.__trussalEnsureVideoPublished = () => ensureVideoPublished();
  }
  window.__trussalUnpublishVideo = () => unpublishVideo();
}

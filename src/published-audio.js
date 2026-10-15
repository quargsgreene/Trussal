// published-audio.js — the local microphone track, made backend-agnostic.
//
// The Jitsi Meet web app publishes the microphone itself: joining unmuted (the
// default) ends in jitsi-meet creating the local audio track and adding it to
// the conference. A direct lib-jitsi-meet conference has no such UI — it only
// ever publishes a track someone explicitly adds — so, left alone, it would
// carry no microphone at all. ensureAudioPublished()/unpublishAudio() is that
// explicit path: the audio twin of published-video.js's video pair.
//
// Unlike video, audio is NOT replaced: the raw microphone is exactly what the
// room should hear. (published-video.js swaps the camera for the Hydra canvas
// only because a performer's camera must never reach the wire; the mic has no
// such rule.) This same track is what latency-instrument.js layers effects onto
// through JitsiTrack.setEffect() when Strudel is published to the room — so the
// finder here is the one place that knows where each backend keeps it.
//
// Both the web wrapper and a bare lib-jitsi-meet JitsiConference expose the
// local tracks, so readLocalAudioTrack() reads whichever is present. Everything
// takes an optional conference/test double so the paths stay unit-testable
// outside a browser, and both publishers are inert until called — the default
// Jitsi web backend keeps publishing through its own unmute, unchanged.

import { getConference } from './meeting-adapter.js';

const PUBLISH_POLL_MS = 150;
const PUBLISH_WAIT_MS = 3000;

// The one track this module last published. Kept here (rather than re-derived
// from the conference every time) so unpublish/teardown can still reach it when
// a renegotiation has left the conference briefly unaware of the live track.
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
  // The object that actually owns the track API. Prefer `_room` (the Jitsi web
  // wrapper parks the lib-jitsi-meet JitsiConference there); otherwise a bare
  // JitsiConference is that object itself. NB: a real JitsiConference ALSO
  // exposes `conf.room`, but that is its XMPP room (addListener/
  // muteParticipant — no track API), so it must never be chosen over the
  // conference. Capability-check each candidate so a wrapper that parks the
  // conference on `.room` still resolves.
  const hasTrackApi = (o) => !!o && (typeof o.addTrack === 'function' || typeof o.removeTrack === 'function');
  if (hasTrackApi(conf._room)) return conf._room;
  if (hasTrackApi(conf)) return conf;
  if (hasTrackApi(conf.room)) return conf.room;
  return conf._room || conf;
}

export function isAudioTrack(track) {
  if (!track) return false;
  try {
    if (typeof track.isAudioTrack === 'function') return track.isAudioTrack();
  } catch (e) { /* fall through to the shape checks */ }
  return track.type === 'audio' || track.kind === 'audio';
}

/**
 * The live local audio track, wherever the backend keeps it. Jitsi Meet's APP
 * conference exposes getLocalAudioTrack()/localAudioTrack; a bare lib-jitsi-meet
 * JitsiConference keeps its JitsiLocalTracks in `_localTracks` (reachable via
 * getLocalTracks()).
 */
export function readLocalAudioTrack(conf) {
  try {
    if (!conf) return null;
    if (conf.localAudioTrack && isAudioTrack(conf.localAudioTrack)) return conf.localAudioTrack;
    if (typeof conf.getLocalAudioTrack === 'function') {
      const track = conf.getLocalAudioTrack();
      if (track) return track;
    }
    const room = conf._room;
    if (room && typeof room.getLocalAudioTrack === 'function') {
      const track = room.getLocalAudioTrack();
      if (track) return track;
    }
    if (room && typeof room.getLocalTracks === 'function') {
      const track = (room.getLocalTracks() || []).find(isAudioTrack);
      if (track) return track;
    }
    for (const list of [conf._localTracks, room && room._localTracks]) {
      if (!Array.isArray(list)) continue;
      const track = list.find(isAudioTrack);
      if (track) return track;
    }
  } catch (e) {
    console.warn('[published-audio] reading the local audio track failed', e);
  }
  return null;
}

async function waitForLocalAudioTrack(conf, timeoutMs) {
  const startedAt = Date.now();
  for (;;) {
    const track = readLocalAudioTrack(conf);
    if (track) return track;
    if (Date.now() - startedAt >= timeoutMs) return null;
    await sleep(PUBLISH_POLL_MS);
  }
}

async function attachAudioTrack(conf, track) {
  try {
    // Jitsi Meet's APP conference takes the track through useAudioStream; a
    // bare lib-jitsi-meet conference only has addTrack.
    if (typeof conf.useAudioStream === 'function') {
      await conf.useAudioStream(track);
      return true;
    }
    const room = roomFor(conf);
    if (room && typeof room.addTrack === 'function') {
      await room.addTrack(track);
      return true;
    }
  } catch (e) {
    console.warn('[published-audio] attaching the audio track failed', e);
  }
  return false;
}

/** Track this module last published, or null. Test/inspection seam. */
export function getPublishedAudioTrack() {
  return publishedTrack;
}

export function setPublishedAudioTrack(track) {
  publishedTrack = track || null;
  return publishedTrack;
}

export function clearPublishedAudioTrack() {
  publishedTrack = null;
}

export function hasPublishedAudioTrack() {
  return !!publishedTrack;
}

/**
 * Publish the local microphone, if it is not already published. Backend-neutral
 * and idempotent: a live local track short-circuits.
 *
 * Returns true when the conference now has a local audio track.
 */
export async function ensureAudioPublished({ conference, JitsiMeetJS, waitMs = PUBLISH_WAIT_MS } = {}) {
  const conf = conference || getConference();
  if (!conf) return false;

  const existing = readLocalAudioTrack(conf);
  if (existing) {
    setPublishedAudioTrack(existing);
    return true;
  }

  // Path 1 — the Jitsi web app's own unmute. This is exactly what joining
  // unmuted (or the toolbar mic button) does, so the default backend is
  // unchanged.
  if (typeof conf.muteAudio === 'function') {
    try {
      await conf.muteAudio(false);
    } catch (e) {
      console.warn('[published-audio] muteAudio(false) failed', e);
    }
    const track = await waitForLocalAudioTrack(conf, waitMs);
    if (track) {
      setPublishedAudioTrack(track);
      return true;
    }
  }

  // Path 2 — direct lib-jitsi-meet. No muteAudio to lean on: create the track
  // and attach it explicitly.
  const meetjs = JitsiMeetJS || libJitsiGlobal();
  if (meetjs && typeof meetjs.createLocalTracks === 'function') {
    let tracks = null;
    try {
      tracks = await meetjs.createLocalTracks({ devices: ['audio'] });
    } catch (e) {
      console.warn('[published-audio] createLocalTracks failed', e);
    }
    const track = Array.isArray(tracks) ? tracks[0] : tracks;
    if (track && await attachAudioTrack(conf, track)) {
      const live = await waitForLocalAudioTrack(conf, waitMs);
      setPublishedAudioTrack(live || track);
      return true;
    }
  }

  return false;
}

/**
 * Wait for a conference to exist, then publish the microphone once. The
 * lib-jitsi-meet bootstrap connects asynchronously, so a join-time call can
 * fire before getConference() is non-null. Deliberately does NOT retry after a
 * conference is present: a failure there could otherwise create a second track.
 */
export async function ensureAudioPublishedWhenReady({ attempts = 40, intervalMs = 500, ...options } = {}) {
  for (let i = 0; i < attempts; i++) {
    const conf = options.conference || getConference();
    if (conf) return ensureAudioPublished({ ...options, conference: conf });
    await sleep(intervalMs);
  }
  return false;
}

/**
 * Stop publishing the local microphone. Prefers the conference's own
 * removeTrack/dispose path and falls back to the Jitsi web app's muteAudio.
 * Idempotent.
 */
export async function unpublishAudio({ conference } = {}) {
  const conf = conference || getConference();
  const track = readLocalAudioTrack(conf) || publishedTrack;
  clearPublishedAudioTrack();
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
    if (typeof conf.muteAudio === 'function') {
      await conf.muteAudio(true);
      return true;
    }
  } catch (e) {
    console.warn('[published-audio] unpublishAudio failed', e);
  }
  return false;
}

// Test seam: drop the remembered track so a suite can publish again.
export function resetPublishedAudio() {
  publishedTrack = null;
}

// Manual hooks for driving microphone publication while the lib-jitsi-meet
// backend has no toolbar of its own (the Jitsi web backend keeps using its own
// unmute, and these are inert until called). The bot bundle installs its own
// __trussalEnsureAudioPublished at document-start; never clobber that.
if (typeof window !== 'undefined' && !window.__trussalIsBot && !window.__trussalIsAggregator) {
  if (typeof window.__trussalEnsureAudioPublished !== 'function') {
    window.__trussalEnsureAudioPublished = () => ensureAudioPublished();
  }
  window.__trussalUnpublishAudio = () => unpublishAudio();
}

// remote-tracks.js — backend-neutral access to remote participants' live media.
//
// The Jitsi web app renders each remote participant's media into its own
// injected <audio>/<video> element and hangs the live MediaStream off
// element.srcObject. A bare lib-jitsi-meet conference injects no such elements,
// so any code that wants a remote participant's audio or video must read the
// conference model instead of the DOM. This module normalises both backends to
// the same shape: a stable MediaStream per participant (built from the tracks
// the conference reports), plus — where the Jitsi web app did inject an element
// — that element, so its native playback can be muted once we tap the same
// track ourselves.
//
// The conference model is authoritative in both backends (the web app's own
// element ids are generic in this deployment), and readRemoteTracks() already
// handles local/hidden filtering.

import { getConference, readRemoteTracks } from './meeting-adapter.js';

const audioStreams = new Map(); // id -> { stream, key }
const videoStreams = new Map(); // id -> { stream, key }
const ownedVideoEls = new Map(); // id -> HTMLVideoElement we created

function trackKey(tracks) {
  return (tracks || []).map((t) => (t && t.id) || '').join(',');
}

function trackIdSet(tracks) {
  const set = new Set();
  for (const t of tracks || []) { if (t && t.id) set.add(t.id); }
  return set;
}

// One current view of the roster's remote tracks, pruning stream caches for
// participants who have left so ids never accumulate across the session. Only
// prune while a conference is actually present: an empty read while the meeting
// is transiently gone (e.g. a breakout-room transition) must not drop live
// caches. Owned <video> elements are deliberately NOT pruned here — an
// in-progress capture holds a reference to one, so they are released only on
// conference change (resetRemoteTracks) or explicit release.
function currentMedia() {
  const media = readRemoteTracks();
  if (getConference()) {
    for (const id of Array.from(audioStreams.keys())) { if (!media.has(id)) audioStreams.delete(id); }
    for (const id of Array.from(videoStreams.keys())) { if (!media.has(id)) videoStreams.delete(id); }
  }
  return media;
}

// A stable MediaStream for the given tracks: the same object is returned while
// the track set is unchanged, a fresh one when a track is replaced. Identity is
// what callers use to decide whether an existing audio tap is still live. A
// missing/empty track set yields null without evicting the cache, so a transient
// gap (a renegotiating track) does not force a re-wire.
function streamFor(cache, id, tracks) {
  if (!tracks || !tracks.length) return null;
  const key = trackKey(tracks);
  const existing = cache.get(id);
  if (existing && existing.key === key) return existing.stream;
  let stream = null;
  try {
    stream = new MediaStream(tracks);
  } catch (e) {
    console.warn('[remote-tracks] could not build MediaStream', e);
    return null;
  }
  cache.set(id, { stream, key });
  return stream;
}

export function getRemoteAudioStream(id) {
  if (!id) return null;
  const media = currentMedia();
  return streamFor(audioStreams, id, media.get(id) && media.get(id).audio);
}

export function getRemoteVideoStream(id) {
  if (!id) return null;
  const media = currentMedia();
  return streamFor(videoStreams, id, media.get(id) && media.get(id).video);
}

// The Jitsi web app's own <audio> element for a participant, matched by track
// identity (its element ids are generic in this deployment). Null under a bare
// lib-jitsi conference, which injects no element. Used to mute native playback
// once the same track is routed through the audio engine.
export function findRemoteAudioElement(id) {
  if (!id || typeof document === 'undefined') return null;
  const media = currentMedia();
  const ids = trackIdSet(media.get(id) && media.get(id).audio);
  if (!ids.size) return null;
  const tags = document.querySelectorAll ? document.querySelectorAll('audio') : [];
  for (const tag of tags) {
    if (!tag || tag.id === 'userAudio') continue; // local mic is never a remote owner
    const srcObject = tag.srcObject;
    if (!srcObject || typeof srcObject.getAudioTracks !== 'function') continue;
    if (srcObject.getAudioTracks().some((t) => t && ids.has(t.id))) return tag;
  }
  return null;
}

// The Jitsi web app's own <video> element for a participant. Prefer its tile
// (the visible one the web app manages); fall back to matching by track
// identity for layouts whose ids do not embed the participant id.
export function findRemoteVideoElement(id) {
  if (!id || typeof document === 'undefined') return null;
  let scoped = null;
  try { scoped = document.querySelector(`#participant_${id} video`); } catch (e) { console.warn('[remote-tracks] scoped video lookup failed', e); }
  if (scoped) return scoped;
  const byId = document.getElementById ? document.getElementById(`remoteVideo_${id}`) : null;
  if (byId && byId.srcObject) return byId;
  const media = currentMedia();
  const ids = trackIdSet(media.get(id) && media.get(id).video);
  if (!ids.size) return null;
  const vids = document.querySelectorAll ? document.querySelectorAll('video') : [];
  for (const v of vids) {
    const srcObject = v && v.srcObject;
    if (!srcObject || typeof srcObject.getVideoTracks !== 'function') continue;
    if (srcObject.getVideoTracks().some((t) => t && ids.has(t.id))) return v;
  }
  return null;
}

// A <video> element the caller can draw frames from, whether or not the backend
// injected one: the Jitsi tile when present, otherwise a hidden element of our
// own bound to the participant's video stream. Null while no video track exists.
export function ensureRemoteVideoElement(id) {
  const existing = findRemoteVideoElement(id);
  if (existing) return existing;
  if (!id || typeof document === 'undefined' || !document.createElement) return null;
  const stream = getRemoteVideoStream(id);
  if (!stream) return null;
  let el = ownedVideoEls.get(id);
  if (!el || !el.isConnected) {
    el = document.createElement('video');
    el.id = `trussalRemoteVideo_${id}`;
    el.autoplay = true;
    el.muted = true;
    if (typeof el.setAttribute === 'function') el.setAttribute('playsinline', '');
    el.style.cssText = 'position:absolute;left:-9999px;width:1px;height:1px;opacity:0;pointer-events:none;';
    try { document.body && document.body.appendChild(el); } catch (e) { console.warn('[remote-tracks] could not append remote video element', e); }
    ownedVideoEls.set(id, el);
  }
  if (el.srcObject !== stream) el.srcObject = stream;
  return el;
}

// Remove a hidden video element we created (a no-op for a Jitsi tile we do not
// own). Safe to call for any participant id.
export function releaseRemoteVideoElement(id) {
  const el = ownedVideoEls.get(id);
  if (!el) return;
  try { el.srcObject = null; } catch (e) { console.warn('[swallowed error]', e); }
  try { el.remove && el.remove(); } catch (e) { console.warn('[swallowed error]', e); }
  ownedVideoEls.delete(id);
}

// Drop every cached stream and owned element. Call when the conference changes.
export function resetRemoteTracks() {
  audioStreams.clear();
  videoStreams.clear();
  for (const id of Array.from(ownedVideoEls.keys())) releaseRemoteVideoElement(id);
}

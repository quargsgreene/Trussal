// remote-tracks.js is how Trussal reaches a remote participant's audio/video
// without depending on Jitsi's injected <audio>/<video> elements (a bare
// lib-jitsi-meet conference injects none). These tests drive it with a fake
// conference model + a fake DOM so nothing touches a real browser.

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { setConference, clearConference, readRemoteTracks, readRemotes, readLocal } from '../src/meeting-adapter.js';
import {
  getRemoteAudioStream,
  getRemoteVideoStream,
  findRemoteAudioElement,
  findRemoteVideoElement,
  ensureRemoteVideoElement,
  releaseRemoteVideoElement,
  resetRemoteTracks,
} from '../src/remote-tracks.js';

// --- fakes -----------------------------------------------------------------

function fakeTrack(kind, id, label) {
  return { getType: () => kind, getTrack: () => ({ id, kind, label: label || kind }) };
}

function fakeParticipant(id, { audio = [], video = [], hidden = false, name } = {}) {
  const tracks = [
    ...audio.map((t) => fakeTrack('audio', t)),
    ...video.map((t) => fakeTrack('video', t)),
  ];
  return {
    getId: () => id,
    getDisplayName: () => name || id,
    isHidden: () => hidden,
    getTracks: () => tracks,
  };
}

// A bare lib-jitsi-meet JitsiConference, as injected by lib-jitsi-bootstrap.
function libJitsiConference(participants, myId) {
  return {
    myUserId: () => myId,
    getParticipants: () => participants,
    getParticipantById: (id) => participants.find((p) => p.getId() === id) || null,
    isJoined: () => true,
  };
}

// The Jitsi web app's wrapper: getMyUserId()/listMembers(), with the real
// lib-jitsi conference reachable as `_room`.
function webConference(participants, myId) {
  return {
    getMyUserId: () => myId,
    listMembers: () => participants,
    _room: libJitsiConference(participants, myId),
    isJoined: () => true,
  };
}

let dom;

function installDom() {
  const elements = [];
  const videoTiles = new Map(); // selector -> element
  const makeEl = (tag) => {
    const el = {
      tagName: tag, id: '', style: { cssText: '' }, srcObject: null, isConnected: true,
      setAttribute() {},
      remove() { this.isConnected = false; const i = elements.indexOf(this); if (i >= 0) elements.splice(i, 1); },
    };
    elements.push(el);
    return el;
  };
  globalThis.document = {
    createElement: makeEl,
    querySelector: (sel) => videoTiles.get(sel) || null,
    getElementById: (id) => elements.find((e) => e.id === id) || null,
    querySelectorAll: (sel) => elements.filter((e) => e.tagName === sel),
    body: { appendChild() {} },
  };
  globalThis.MediaStream = class {
    constructor(tracks = []) { this._tracks = tracks; this.id = 'stream-' + Math.random().toString(36).slice(2); }
    getTracks() { return this._tracks; }
    getAudioTracks() { return this._tracks.filter((t) => t.kind === 'audio'); }
    getVideoTracks() { return this._tracks.filter((t) => t.kind === 'video'); }
  };
  return { elements, videoTiles, makeEl };
}

beforeEach(() => { dom = installDom(); });
afterEach(() => { resetRemoteTracks(); clearConference(); delete globalThis.document; delete globalThis.MediaStream; });

// --- readRemoteTracks (via meeting-adapter) --------------------------------

test('remote-tracks: enumerates a raw lib-jitsi conference, excluding local + hidden', () => {
  const p1 = fakeParticipant('p1', { audio: ['a1'], video: ['v1'] });
  const me = fakeParticipant('me', { audio: ['am'] });
  const hidden = fakeParticipant('bot', { audio: ['ab'], hidden: true });
  setConference(libJitsiConference([p1, me, hidden], 'me'));
  const map = readRemoteTracks();
  assert.deepEqual([...map.keys()], ['p1']);
  assert.deepEqual(map.get('p1').audio.map((t) => t.id), ['a1']);
  assert.deepEqual(map.get('p1').video.map((t) => t.id), ['v1']);
});

test('remote-tracks: enumerates the web wrapper through its _room', () => {
  const p1 = fakeParticipant('p1', { audio: ['a1'] });
  setConference(webConference([p1], 'me'));
  const map = readRemoteTracks();
  assert.deepEqual([...map.keys()], ['p1']);
});

test('remote-tracks: no conference yields an empty map', () => {
  clearConference();
  assert.equal(readRemoteTracks().size, 0);
});

// --- adapter backend-neutral roster ---------------------------------------

test('remote-tracks: readRemotes resolves a raw lib-jitsi roster', () => {
  const p1 = fakeParticipant('p1', { name: 'Ada' });
  setConference(libJitsiConference([p1], 'me'));
  const remotes = readRemotes();
  assert.equal(remotes.get('p1').displayName, 'Ada');
});

test('remote-tracks: readLocal resolves myUserId() on a raw lib-jitsi conference', () => {
  const me = fakeParticipant('me', { name: 'Me' });
  setConference(libJitsiConference([me], 'me'));
  const local = readLocal();
  assert.equal(local.id, 'me');
  assert.equal(local.displayName, 'Me');
});

// --- streams ---------------------------------------------------------------

test('remote-tracks: getRemoteAudioStream is stable across calls, fresh on track change', () => {
  const p1 = fakeParticipant('p1', { audio: ['a1'] });
  setConference(libJitsiConference([p1], 'me'));
  const first = getRemoteAudioStream('p1');
  assert.ok(first);
  assert.equal(first.getAudioTracks().map((t) => t.id).join(','), 'a1');
  assert.equal(getRemoteAudioStream('p1'), first, 'same tracks → same stream object');
  // Replace the participant's audio track (a Jitsi renegotiation).
  setConference(libJitsiConference([fakeParticipant('p1', { audio: ['a2'] })], 'me'));
  const second = getRemoteAudioStream('p1');
  assert.notEqual(second, first, 'a replaced track must yield a new stream');
  assert.equal(second.getAudioTracks()[0].id, 'a2');
});

test('remote-tracks: getRemoteAudioStream returns null without audio', () => {
  const p1 = fakeParticipant('p1', { audio: ['a1'] });
  setConference(libJitsiConference([p1], 'me'));
  const s = getRemoteAudioStream('p1');
  assert.ok(s);
  setConference(libJitsiConference([fakeParticipant('p1', { audio: [] })], 'me'));
  assert.equal(getRemoteAudioStream('p1'), null);
});

test('remote-tracks: getRemoteVideoStream builds a stream from video tracks', () => {
  const p1 = fakeParticipant('p1', { video: ['v1'] });
  setConference(libJitsiConference([p1], 'me'));
  const s = getRemoteVideoStream('p1');
  assert.ok(s);
  assert.deepEqual(s.getVideoTracks().map((t) => t.id), ['v1']);
});

// --- Jitsi web element lookup (for muting native playback) ------------------

test('remote-tracks: findRemoteAudioElement matches by track identity and skips userAudio', () => {
  const local = dom.makeEl('audio'); local.id = 'userAudio'; local.srcObject = { getAudioTracks: () => [{ id: 'a1' }] };
  const remote = dom.makeEl('audio'); remote.id = 'remoteAudio_remote-audio-3'; remote.srcObject = { getAudioTracks: () => [{ id: 'a1' }] };
  setConference(libJitsiConference([fakeParticipant('p1', { audio: ['a1'] })], 'me'));
  assert.equal(findRemoteAudioElement('p1'), remote, 'must not return the local mic element');
});

test('remote-tracks: findRemoteAudioElement is null under a bare lib-jitsi conference', () => {
  setConference(libJitsiConference([fakeParticipant('p1', { audio: ['a1'] })], 'me'));
  assert.equal(findRemoteAudioElement('p1'), null);
});

test('remote-tracks: ensureRemoteVideoElement prefers the Jitsi tile', () => {
  const tile = dom.makeEl('video'); tile.id = 'participantTile';
  dom.videoTiles.set('#participant_p1 video', tile);
  setConference(libJitsiConference([fakeParticipant('p1', { video: ['v1'] })], 'me'));
  assert.equal(ensureRemoteVideoElement('p1'), tile);
});

test('remote-tracks: ensureRemoteVideoElement creates and caches a hidden element', () => {
  setConference(libJitsiConference([fakeParticipant('p1', { video: ['v1'] })], 'me'));
  const el = ensureRemoteVideoElement('p1');
  assert.ok(el, 'a hidden element is created when the backend injects none');
  assert.equal(el.tagName, 'video');
  assert.ok(el.srcObject, 'bound to the participant video stream');
  assert.equal(el.muted, true);
  assert.equal(ensureRemoteVideoElement('p1'), el, 'reused on the next call');
  releaseRemoteVideoElement('p1');
  assert.equal(el.isConnected, false, 'released element is detached');
});

test('remote-tracks: ensureRemoteVideoElement is null while there is no video track', () => {
  setConference(libJitsiConference([fakeParticipant('p1', { audio: ['a1'] })], 'me'));
  assert.equal(ensureRemoteVideoElement('p1'), null);
});

test('remote-tracks: a participant leaving prunes its cached stream', () => {
  setConference(libJitsiConference([fakeParticipant('p1', { audio: ['a1'] })], 'me'));
  assert.ok(getRemoteAudioStream('p1'));
  setConference(libJitsiConference([], 'me'));
  // Touch any helper to trigger the prune, then confirm a last-known stream is gone.
  assert.equal(getRemoteAudioStream('p1'), null);
});

test('remote-tracks: resetRemoteTracks drops owned elements', () => {
  setConference(libJitsiConference([fakeParticipant('p1', { video: ['v1'] })], 'me'));
  const el = ensureRemoteVideoElement('p1');
  resetRemoteTracks();
  assert.equal(el.isConnected, false);
});

test('remote-tracks: a transient conference loss does not detach an owned element', () => {
  setConference(libJitsiConference([fakeParticipant('p1', { video: ['v1'] })], 'me'));
  const el = ensureRemoteVideoElement('p1');
  // The meeting momentarily disappears (e.g. a breakout-room transition).
  clearConference();
  assert.equal(getRemoteVideoStream('p1'), null, 'no tracks while the meeting is gone');
  assert.equal(el.isConnected, true, 'an in-progress capture keeps drawing from its element');
  resetRemoteTracks();
  assert.equal(el.isConnected, false);
});

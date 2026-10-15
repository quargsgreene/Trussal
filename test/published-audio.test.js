// The local microphone, made backend-agnostic. The web app publishes the mic
// itself; a bare lib-jitsi-meet conference creates no tracks, so without this
// seam it would carry no microphone at all. This covers the finder (where each
// backend keeps the track), the explicit publisher, the finder/publisher the
// Strudel path reuses, and the unpublish/teardown path.

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

class FakeTrack {
  constructor(kind, label) { this.kind = kind; this.label = label; }
  isAudioTrack() { return this.kind === 'audio'; }
  isVideoTrack() { return this.kind === 'video'; }
}

let mod;
beforeEach(async () => {
  globalThis.window = { config: {} };
  mod = await import(`../src/published-audio.js?t=${Date.now()}`);
});
afterEach(() => { if (mod) mod.resetPublishedAudio(); });

test('published audio: readLocalAudioTrack finds the web wrapper direct property', () => {
  const track = new FakeTrack('audio', 'mic');
  assert.equal(mod.readLocalAudioTrack({ localAudioTrack: track }), track);
});

test('published audio: readLocalAudioTrack finds via getLocalAudioTrack()', () => {
  const track = new FakeTrack('audio', 'mic');
  const conf = { getLocalAudioTrack: () => track };
  assert.equal(mod.readLocalAudioTrack(conf), track);
});

test('published audio: readLocalAudioTrack reads the lib-jitsi _room', () => {
  const track = new FakeTrack('audio', 'mic');
  assert.equal(mod.readLocalAudioTrack({ _room: { getLocalAudioTrack: () => track } }), track);
  assert.equal(mod.readLocalAudioTrack({ _room: { getLocalTracks: () => [track] } }), track);
});

test('published audio: readLocalAudioTrack scans _localTracks and ignores video', () => {
  const video = new FakeTrack('video', 'cam');
  const audio = new FakeTrack('audio', 'mic');
  assert.equal(mod.readLocalAudioTrack({ _localTracks: [video, audio] }), audio);
  assert.equal(mod.readLocalAudioTrack({ _localTracks: [video] }), null);
});

test('published audio: readLocalAudioTrack is null without a conference or track', () => {
  assert.equal(mod.readLocalAudioTrack(null), null);
  assert.equal(mod.readLocalAudioTrack({}), null);
  assert.equal(mod.readLocalAudioTrack({ _localTracks: [] }), null);
});

test('published audio: a live track short-circuits, so mute is not re-driven', async () => {
  const track = new FakeTrack('audio', 'mic');
  let muteCalls = 0;
  const conf = {
    _localTracks: [track],
    _room: null,
    async muteAudio() { muteCalls += 1; },
  };
  assert.equal(await mod.ensureAudioPublished({ conference: conf, waitMs: 50 }), true);
  assert.equal(muteCalls, 0);
  assert.equal(mod.getPublishedAudioTrack(), track);
  assert.equal(mod.hasPublishedAudioTrack(), true);
});

test('published audio: ensureAudioPublished drives the Jitsi web mute path', async () => {
  const track = new FakeTrack('audio', 'mic');
  const calls = [];
  const conf = {
    _localTracks: [],
    _room: null,
    async muteAudio(muted) {
      calls.push(muted);
      if (!muted) conf._localTracks.push(track);
    },
  };
  assert.equal(await mod.ensureAudioPublished({ conference: conf, waitMs: 50 }), true);
  assert.deepEqual(calls, [false]);
  assert.equal(mod.getPublishedAudioTrack(), track);
});

test('published audio: ensureAudioPublished publishes explicitly under lib-jitsi', async () => {
  const track = new FakeTrack('audio', 'mic');
  const added = [];
  const conf = {
    _localTracks: [],
    _room: {
      async addTrack(t) { added.push(t); conf._localTracks.push(t); },
    },
  };
  const JitsiMeetJS = {
    async createLocalTracks(options) {
      assert.deepEqual(options, { devices: ['audio'] }, 'only the microphone is created');
      return [track];
    },
  };
  assert.equal(await mod.ensureAudioPublished({ conference: conf, JitsiMeetJS, waitMs: 50 }), true);
  assert.deepEqual(added, [track]);
  assert.equal(mod.getPublishedAudioTrack(), track);
});

test('published audio: a bare JitsiConference publishes on itself, not its XMPP room', async () => {
  // A real JitsiConference exposes `room` — its XMPP room, which has no track
  // API. ensureAudioPublished must attach via the conference's own addTrack.
  const track = new FakeTrack('audio', 'mic');
  const added = [];
  const conf = {
    room: { name: 'room1', addListener() {} },
    getLocalAudioTrack: () => added[0] || null,
    async addTrack(t) { added.push(t); },
  };
  const JitsiMeetJS = { async createLocalTracks() { return [track]; } };
  assert.equal(await mod.ensureAudioPublished({ conference: conf, JitsiMeetJS, waitMs: 50 }), true);
  assert.deepEqual(added, [track]);
  assert.equal(mod.getPublishedAudioTrack(), track);
});

test('published audio: the web useAudioStream path is preferred over addTrack', async () => {
  const track = new FakeTrack('audio', 'mic');
  const used = [];
  const added = [];
  const conf = {
    _localTracks: [],
    async useAudioStream(t) { used.push(t); conf._localTracks.push(t); },
    _room: { async addTrack(t) { added.push(t); } },
  };
  const JitsiMeetJS = { async createLocalTracks() { return [track]; } };
  assert.equal(await mod.ensureAudioPublished({ conference: conf, JitsiMeetJS, waitMs: 50 }), true);
  assert.deepEqual(used, [track]);
  assert.deepEqual(added, [], 'the raw JitsiConference addTrack is not used when useAudioStream exists');
});

test('published audio: unpublishAudio removes the track and clears the seam', async () => {
  const track = new FakeTrack('audio', 'mic');
  const removed = [];
  const conf = {
    _localTracks: [track],
    _room: {
      async removeTrack(t) {
        removed.push(t);
        conf._localTracks = conf._localTracks.filter((x) => x !== t);
      },
    },
  };
  mod.setPublishedAudioTrack(track);
  assert.equal(await mod.unpublishAudio({ conference: conf }), true);
  assert.deepEqual(removed, [track]);
  assert.equal(mod.hasPublishedAudioTrack(), false);
  assert.equal(mod.getPublishedAudioTrack(), null);
});

test('published audio: unpublishAudio falls back to muteAudio(true)', async () => {
  const calls = [];
  const conf = { async muteAudio(muted) { calls.push(muted); } };
  mod.setPublishedAudioTrack(new FakeTrack('audio', 'mic'));
  assert.equal(await mod.unpublishAudio({ conference: conf }), true);
  assert.deepEqual(calls, [true]);
  assert.equal(mod.hasPublishedAudioTrack(), false);
});

test('published audio: ensureAudioPublished is inert without a conference', async () => {
  assert.equal(await mod.ensureAudioPublished({ conference: null, waitMs: 10 }), false);
  assert.equal(mod.hasPublishedAudioTrack(), false);
});

test('published audio: whenReady waits for an async conference and publishes once', async () => {
  const track = new FakeTrack('audio', 'mic');
  const added = [];
  const conf = {
    _localTracks: [],
    _room: { async addTrack(t) { added.push(t); conf._localTracks.push(t); } },
  };
  const JitsiMeetJS = { async createLocalTracks() { return [track]; } };
  let injected = null;
  globalThis.window.APP = { get conference() { return injected; } };
  const p = mod.ensureAudioPublishedWhenReady({ attempts: 5, intervalMs: 5, JitsiMeetJS });
  setTimeout(() => { injected = conf; }, 8);
  assert.equal(await p, true);
  assert.deepEqual(added, [track]);
});

test('published audio: resetPublishedAudio clears the remembered track', () => {
  mod.setPublishedAudioTrack(new FakeTrack('audio', 'mic'));
  assert.equal(mod.hasPublishedAudioTrack(), true);
  mod.resetPublishedAudio();
  assert.equal(mod.hasPublishedAudioTrack(), false);
});

test('published audio: isAudioTrack recognises both track shapes', () => {
  assert.equal(mod.isAudioTrack(new FakeTrack('audio', 'mic')), true);
  assert.equal(mod.isAudioTrack(new FakeTrack('video', 'cam')), false);
  assert.equal(mod.isAudioTrack({ type: 'audio' }), true);
  assert.equal(mod.isAudioTrack({ kind: 'video' }), false);
  assert.equal(mod.isAudioTrack(null), false);
});

test('published audio: manual hooks are installed for the standalone deployment', () => {
  assert.equal(typeof globalThis.window.__trussalEnsureAudioPublished, 'function');
  assert.equal(typeof globalThis.window.__trussalUnpublishAudio, 'function');
});

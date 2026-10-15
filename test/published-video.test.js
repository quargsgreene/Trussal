// What a participant's video track carries. The rule this file defends is a
// privacy rule as much as an aesthetic one: the raw camera must never reach
// the wire, and the two code paths that legitimately want a camera (the `s0`
// Hydra source and the landmarks UI) must still get a real one. The second half
// covers the step-4 explicit publisher a direct lib-jitsi-meet conference needs
// (no Jitsi web camera button exists to drive it).

import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal DOM/media stubs — the module only needs createElement, a canvas with
// captureStream, and navigator.mediaDevices.
class FakeTrack {
  constructor(kind, label) { this.kind = kind; this.label = label; }
}
class FakeStream {
  constructor(tracks = []) { this.tracks = tracks; }
  addTrack(t) { this.tracks.push(t); }
  getTracks() { return this.tracks; }
  getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter((t) => t.kind === 'audio'); }
}

let cameraRequests;

function installDom() {
  cameraRequests = [];
  const elements = [];
  const canvasStub = () => ({
    id: '', width: 0, height: 0, style: { cssText: '' },
    getContext: () => ({ fillRect() {}, drawImage() {}, set fillStyle(_v) {} }),
    captureStream: () => new FakeStream([new FakeTrack('video', 'canvas')]),
    remove() {},
  });
  globalThis.document = {
    createElement: (tag) => { const el = canvasStub(); el.tagName = tag; elements.push(el); return el; },
    getElementById: () => null,
    body: { appendChild: () => {} },
    documentElement: { appendChild: () => {} },
  };
  globalThis.MediaStream = FakeStream;
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.navigator = {
    mediaDevices: {
      getUserMedia: async (constraints) => {
        cameraRequests.push(constraints);
        const tracks = [];
        if (constraints.video) tracks.push(new FakeTrack('video', 'REAL CAMERA'));
        if (constraints.audio) tracks.push(new FakeTrack('audio', 'REAL MIC'));
        return new FakeStream(tracks);
      },
    },
  };
  globalThis.window = { config: {} };
}

let mod;
beforeEach(async () => {
  installDom();
  mod = await import(`../src/published-video.js?t=${Date.now()}`);
});
afterEach(() => { if (mod) mod.resetPublishedVideo(); });

test('published video: a video request gets the canvas, never the camera', async () => {
  mod.installPublishedVideoOverride();
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const labels = stream.getVideoTracks().map((t) => t.label);
  assert.deepEqual(labels, ['canvas']);
  assert.ok(!labels.includes('REAL CAMERA'), 'the raw camera must never reach a published track');
  assert.deepEqual(cameraRequests, [], 'no camera was even opened');
});

test('published video: an audio-only request passes straight through', async () => {
  mod.installPublishedVideoOverride();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  assert.deepEqual(stream.getAudioTracks().map((t) => t.label), ['REAL MIC']);
  assert.deepEqual(cameraRequests, [{ audio: true }]);
});

test('published video: a combined request keeps the real mic but swaps the camera', async () => {
  mod.installPublishedVideoOverride();
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  assert.deepEqual(stream.getVideoTracks().map((t) => t.label), ['canvas']);
  assert.deepEqual(stream.getAudioTracks().map((t) => t.label), ['REAL MIC']);
  assert.deepEqual(cameraRequests, [{ audio: true }], 'only the microphone was opened');
});

test('published video: openCamera still reaches the real camera', async () => {
  mod.installPublishedVideoOverride();
  // This is the path hydra-video.js (s0) and facial-gesture.js (landmarks UI)
  // take. If it ever returns the canvas, face tracking tracks its own output
  // and src(s0) shows a picture of itself.
  const stream = await mod.openCamera({ video: { width: 320, height: 240 } });
  assert.deepEqual(stream.getVideoTracks().map((t) => t.label), ['REAL CAMERA']);
});

test('published video: installing twice does not stack overrides', async () => {
  mod.installPublishedVideoOverride();
  const once = navigator.mediaDevices.getUserMedia;
  mod.installPublishedVideoOverride();
  assert.equal(navigator.mediaDevices.getUserMedia, once);
  // And openCamera must still find the ORIGINAL, not the first override.
  const stream = await mod.openCamera({ video: true });
  assert.deepEqual(stream.getVideoTracks().map((t) => t.label), ['REAL CAMERA']);
});

test('published video: participants join with video off', () => {
  mod.startWithVideoMuted();
  assert.equal(window.config.startWithVideoMuted, true);
});

test('published video: ensureVideoPublished drives the Jitsi web mute path', async () => {
  const track = new FakeTrack('video', 'canvas');
  const calls = [];
  const conf = {
    _localTracks: [],
    _room: null,
    async muteVideo(muted) {
      calls.push(muted);
      if (!muted) conf._localTracks.push(track);
    },
  };
  assert.equal(await mod.ensureVideoPublished({ conference: conf, waitMs: 50 }), true);
  assert.deepEqual(calls, [false]);
  assert.equal(mod.getPublishedVideoTrack(), track);
  assert.equal(mod.hasPublishedVideoTrack(), true);
});

test('published video: ensureVideoPublished publishes explicitly under lib-jitsi', async () => {
  const track = new FakeTrack('video', 'canvas');
  const added = [];
  const conf = {
    _localTracks: [],
    _room: {
      async addTrack(t) { added.push(t); conf._localTracks.push(t); },
    },
  };
  const JitsiMeetJS = {
    async createLocalTracks(options) {
      assert.deepEqual(options, { devices: ['video'] });
      return [track];
    },
  };
  assert.equal(await mod.ensureVideoPublished({ conference: conf, JitsiMeetJS, waitMs: 50 }), true);
  assert.deepEqual(added, [track]);
  assert.equal(mod.getPublishedVideoTrack(), track);
});

test('published video: a bare JitsiConference publishes on itself, not its XMPP room', async () => {
  // A real JitsiConference exposes `room` — its XMPP room, which has no track
  // API. ensureVideoPublished must attach via the conference's own addTrack,
  // never hand the track to the XMPP room.
  const track = new FakeTrack('video', 'canvas');
  const added = [];
  const conf = {
    room: { name: 'room1', addListener() {} },
    getLocalVideoTrack: () => added[0] || null,
    async addTrack(t) { added.push(t); },
  };
  const JitsiMeetJS = { async createLocalTracks() { return [track]; } };
  assert.equal(await mod.ensureVideoPublished({ conference: conf, JitsiMeetJS, waitMs: 50 }), true);
  assert.deepEqual(added, [track]);
  assert.equal(mod.getPublishedVideoTrack(), track);
});

test('published video: a live track short-circuits, so mute is not re-driven', async () => {
  const track = new FakeTrack('video', 'canvas');
  let muteCalls = 0;
  const conf = {
    _localTracks: [track],
    _room: null,
    async muteVideo() { muteCalls += 1; },
  };
  assert.equal(await mod.ensureVideoPublished({ conference: conf, waitMs: 50 }), true);
  assert.equal(muteCalls, 0);
  assert.equal(mod.getPublishedVideoTrack(), track);
});

test('published video: unpublishVideo removes the track and clears the seam', async () => {
  const track = new FakeTrack('video', 'canvas');
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
  mod.setPublishedVideoTrack(track);
  assert.equal(await mod.unpublishVideo({ conference: conf }), true);
  assert.deepEqual(removed, [track]);
  assert.equal(mod.hasPublishedVideoTrack(), false);
  assert.equal(mod.getPublishedVideoTrack(), null);
});

test('published video: ensureVideoPublished is inert without a conference', async () => {
  assert.equal(await mod.ensureVideoPublished({ conference: null, waitMs: 10 }), false);
  assert.equal(mod.hasPublishedVideoTrack(), false);
});

test('published video: lib-jitsi createLocalTracks is fed the Hydra canvas, not the camera', async () => {
  // Exercises the real chain the lib-jitsi backend uses: createLocalTracks ->
  // RTC.obtainAudioAndVideoPermissions -> navigator.mediaDevices.getUserMedia,
  // which the override answers with the composited canvas. The fake below
  // stands in only for RTC._createLocalTracks wrapping the raw track.
  mod.installPublishedVideoOverride();
  const published = [];
  const conf = {
    _localTracks: [],
    _room: {
      async addTrack(track) {
        published.push(track);
        conf._localTracks.push(track);
      },
    },
  };
  const JitsiMeetJS = {
    async createLocalTracks({ devices }) {
      assert.deepEqual(devices, ['video']);
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { height: { ideal: 720 }, width: { ideal: 1280 } },
      });
      return stream.getVideoTracks().map((raw) => ({
        type: 'video',
        kind: 'video',
        source: raw,
        isVideoTrack: () => true,
      }));
    },
  };
  assert.equal(await mod.ensureVideoPublished({ conference: conf, JitsiMeetJS, waitMs: 50 }), true);
  assert.equal(published.length, 1);
  assert.equal(published[0].source.label, 'canvas', 'the room sees the Hydra canvas');
  assert.deepEqual(cameraRequests, [], 'no camera was ever opened');
});

test('published video: whenReady waits for an async conference and publishes once', async () => {
  const track = new FakeTrack('video', 'canvas');
  const added = [];
  const conf = {
    _localTracks: [],
    _room: { async addTrack(t) { added.push(t); conf._localTracks.push(t); } },
  };
  const JitsiMeetJS = { async createLocalTracks() { return [track]; } };
  // Monkey-patch the module's own getConference dependency by using the global
  // APP path the adapter falls back to, once we look.
  let injected = null;
  globalThis.window.APP = { get conference() { return injected; } };
  const p = mod.ensureVideoPublishedWhenReady({ attempts: 5, intervalMs: 5, JitsiMeetJS });
  // Conference shows up a couple of ticks later, as it does after join.
  setTimeout(() => { injected = conf; }, 8);
  assert.equal(await p, true);
  assert.deepEqual(added, [track]);
});

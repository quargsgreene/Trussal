// What a participant's video track carries. The rule this file defends is a
// privacy rule as much as an aesthetic one: the raw camera must never reach
// the wire, and the two code paths that legitimately want a camera (the `s0`
// Hydra source and the landmarks UI) must still get a real one.

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

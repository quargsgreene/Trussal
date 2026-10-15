// hydra-video.js patches Hydra's own External Sources so a performer's gesture
// means what it says. These tests cover the lib-jitsi-meet-only half of that
// added with the screen-share migration: s0.initScreen() must still acquire the
// display and feed Hydra (Hydra's original returns nothing and swallows
// failures, so it is reimplemented), and must also publish the composited output
// to the conference the way initCam already does. lib-jitsi-meet is the only
// backend, so there is no flag to gate publication on.

import test, { beforeEach, afterEach, after } from 'node:test';
import assert from 'node:assert/strict';

// meeting-adapter.js and published-video.js load fine without a DOM (their
// window use is guarded); hydra-video.js does not — one of its transitive
// imports (peer-state.js) touches window at module-load — so it is imported
// below, after installDom(), and only ever once: ensureCameraBypass patches
// whichever sources exist, so each test's fresh stand-in source is patched
// anyway and no cache-busting re-import is needed.
import { setConference, clearConference } from '../src/meeting-adapter.js';
import { getPublishedVideoTrack, resetPublishedVideo } from '../src/published-video.js';

class FakeTrack {
  constructor(kind, label) { this.kind = kind; this.label = label; }
}

let displayRequests;
let videoEls;

const flush = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function installDom() {
  displayRequests = [];
  videoEls = [];
  globalThis.document = {
    createElement: (tag) => {
      if (tag !== 'video') return { tagName: tag, style: {} };
      const listeners = {};
      const el = {
        tagName: 'video', autoplay: false, muted: false, playsInline: false, srcObject: null,
        addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn); },
        play: async () => {},
        _fire: (type) => (listeners[type] || []).forEach((fn) => fn()),
      };
      videoEls.push(el);
      return el;
    },
    getElementById: () => null,
    querySelector: () => null,
    body: { appendChild() {} },
    documentElement: { appendChild() {} },
  };
  globalThis.MediaStream = class {
    constructor() { this.tracks = []; }
    addTrack(t) { this.tracks.push(t); }
    getTracks() { return this.tracks; }
    getVideoTracks() { return this.tracks.filter((t) => t.kind === 'video'); }
  };
  globalThis.requestAnimationFrame = () => 1;
  globalThis.cancelAnimationFrame = () => {};
  globalThis.navigator = {
    mediaDevices: {
      enumerateDevices: async () => [],
      getUserMedia: async () => ({ getTracks: () => [], getVideoTracks: () => [], getAudioTracks: () => [] }),
      getDisplayMedia: async (opts) => {
        displayRequests.push(opts);
        return { getTracks: () => [], getVideoTracks: () => [new FakeTrack('video', 'screen')] };
      },
    },
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, location: { search: '' }, config: {} };
}

installDom();
const hydra = await import('../src/hydra-video.js');
// hydra-video → peer-state → participants, which starts a setInterval poll at
// module load; release it once the file's tests are done so the process exits.
const { stopPolling } = await import('../src/participants.js');

// A stand-in Hydra source: records init() and starts with real
// initScreen()/initCam()/initVideo() no-ops so ensureCameraBypass has something
// to patch.
function makeSource() {
  const calls = { init: [] };
  return {
    calls,
    initScreen() {},
    initCam() {},
    initVideo() {},
    init(opts, params) { calls.init.push({ opts, params }); },
  };
}

beforeEach(() => { installDom(); });
afterEach(() => {
  resetPublishedVideo();
  clearConference();
  delete globalThis.document;
  delete globalThis.navigator;
  delete globalThis.MediaStream;
  delete globalThis.window;
  delete globalThis.s0;
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
});
after(() => { stopPolling(); });

test('hydra-video: initScreen acquires the display and feeds Hydra', async () => {
  globalThis.s0 = makeSource();
  hydra.ensureCameraBypass();

  assert.equal(globalThis.s0.initScreen(0, { texParams: true }), globalThis.s0);
  assert.deepEqual(displayRequests, [{ video: true, audio: false }]);

  await flush();
  assert.equal(videoEls.length, 1, 'the display stream is wrapped in a <video>');
  videoEls[0]._fire('loadedmetadata');

  assert.equal(globalThis.s0.calls.init.length, 1);
  assert.equal(globalThis.s0.calls.init[0].opts.src, videoEls[0]);
  assert.equal(globalThis.s0.calls.init[0].opts.dynamic, true);
  assert.deepEqual(globalThis.s0.calls.init[0].params, { texParams: true });
});

test('hydra-video: initScreen publishes the composited output', async () => {
  const track = new FakeTrack('video', 'canvas');
  setConference({ _localTracks: [track] });
  globalThis.s0 = makeSource();
  hydra.ensureCameraBypass();

  globalThis.s0.initScreen();
  await flush();
  videoEls[0]._fire('loadedmetadata');
  await flush();

  assert.equal(getPublishedVideoTrack(), track);
});

test('hydra-video: initCam still publishes (helper regression)', async () => {
  const track = new FakeTrack('video', 'canvas');
  setConference({ _localTracks: [track] });
  globalThis.s0 = makeSource();
  hydra.ensureCameraBypass();

  const p = globalThis.s0.initCam();
  await flush();
  videoEls[videoEls.length - 1]._fire('loadedmetadata');
  await p;
  await flush();

  assert.equal(getPublishedVideoTrack(), track);
});

test('hydra-video: ensureCameraBypass patches each source only once', () => {
  globalThis.s0 = makeSource();
  hydra.ensureCameraBypass();
  const patched = globalThis.s0.initScreen;
  hydra.ensureCameraBypass();
  assert.equal(globalThis.s0.initScreen, patched);
});

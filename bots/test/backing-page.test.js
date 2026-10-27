// pageBacking runs in the aggregator's page, but it is a plain function — so
// run it here against a DOM/media stub, the same approach mosaic-page.test.js
// takes for pageMosaic.

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { pageBacking, pageSetBacking, pageLoadBacking, pageSetBackingActive } from '../src/bot/page-scripts.js';

class FakeMedia {
  constructor(tag) {
    this.tagName = tag.toUpperCase();
    this.paused = true;
    this.currentTime = 0;
    this.readyState = 4;
    this.videoWidth = 640;
    this.videoHeight = 360;
    this.loop = false;
    this.listeners = {};
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  play() { this.paused = false; return Promise.resolve(); }
  pause() { this.paused = true; }
  remove() { this.removed = true; }
  // Test helpers: advance the playhead, or reach the end of the file.
  advance(s) { if (!this.paused) this.currentTime += s; }
  end() {
    if (this.loop) { this.currentTime = 0; return; }
    this.paused = true;
    (this.listeners.ended || []).forEach((fn) => fn());
  }
}

const saved = {};
let media;
let connected;

beforeEach(() => {
  media = [];
  connected = [];
  for (const k of ['window', 'document', 'URL', 'atob', 'setTimeout']) saved[k] = globalThis[k];
  const ctx = {
    sampleRate: 48000,
    createMediaElementSource: (el) => ({ el, connect: (n) => connected.push(n), disconnect() {} }),
  };
  globalThis.window = {
    __trussalMasterPlayer: { graph: () => ({ ctx, input: 'busOut' }), queued: () => 0 },
  };
  globalThis.document = {
    body: { appendChild: (c) => c },
    documentElement: { appendChild: (c) => c },
    createElement: (tag) => {
      if (tag === 'audio' || tag === 'video') { const m = new FakeMedia(tag); media.push(m); return m; }
      return { appendChild: (c) => c };
    },
  };
  globalThis.URL = { createObjectURL: () => 'blob:x', revokeObjectURL() {} };
  globalThis.atob = (s) => Buffer.from(s, 'base64').toString('binary');
  // The heard-turn delay is 0 here (empty master queue); run it inline.
  globalThis.setTimeout = (fn) => { fn(); return 0; };
  globalThis.window.setTimeout = globalThis.setTimeout;
  pageBacking();
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) globalThis[k] = v;
});

const bed = (over = {}) => ({ key: '0/bed.wav', token: '0', name: 'bed.wav', kind: 'audio', loop: true, turnOnly: false, restart: false, playing: true, ...over });

test('set() asks for the bytes it lacks, load() routes the file into the master bus', () => {
  assert.deepEqual(pageSetBacking([bed()]), ['0/bed.wav']);
  assert.equal(pageLoadBacking('0/bed.wav', 'audio/wav', 'AAAA'), true);
  assert.equal(media.length, 1);
  assert.equal(media[0].tagName, 'AUDIO');
  assert.deepEqual(connected, ['busOut']);
  assert.deepEqual(pageSetBacking([bed()]), [], 'already loaded: nothing needed');
});

test('a backing on every turn plays through other participants\' turns', () => {
  pageSetBacking([bed()]);
  pageLoadBacking('0/bed.wav', 'audio/wav', 'AAAA');
  for (const token of ['0', '1', null, '2']) {
    pageSetBackingActive(token);
    assert.equal(media[0].paused, false, `still playing on turn ${token}`);
  }
});

test('a turn-only backing pauses off-turn and resumes where it left off', () => {
  pageSetBacking([bed({ turnOnly: true })]);
  pageLoadBacking('0/bed.wav', 'audio/wav', 'AAAA');
  assert.equal(media[0].paused, true, 'nobody\'s turn yet');

  pageSetBackingActive('0');
  assert.equal(media[0].paused, false);
  media[0].advance(3);

  pageSetBackingActive('1');
  assert.equal(media[0].paused, true);
  media[0].advance(5); // paused: the playhead holds

  pageSetBackingActive('0');
  assert.equal(media[0].paused, false);
  assert.equal(media[0].currentTime, 3, 'picks up where it left off');
});

test('a one-shot backing stays finished once the file ends', () => {
  pageSetBacking([bed({ loop: false })]);
  pageLoadBacking('0/bed.wav', 'audio/wav', 'AAAA');
  assert.equal(media[0].loop, false);
  media[0].end();
  pageSetBackingActive('1');
  assert.equal(media[0].paused, true, 'not restarted by a turn change');
});

test('a video backing is offered to the mosaic only while it plays', () => {
  pageSetBacking([bed({ key: '0/clip.mp4', name: 'clip.mp4', kind: 'video', turnOnly: true })]);
  pageLoadBacking('0/clip.mp4', 'video/mp4', 'AAAA');
  const b = globalThis.window.__trussalBacking;
  assert.equal(media[0].tagName, 'VIDEO');
  assert.equal(b.videos().length, 0);
  pageSetBackingActive('0');
  assert.equal(b.videos().length, 1);
});

test('a dropped declaration stops and removes its element', () => {
  pageSetBacking([bed()]);
  pageLoadBacking('0/bed.wav', 'audio/wav', 'AAAA');
  pageSetBacking([]);
  assert.equal(media[0].paused, true);
  assert.equal(media[0].removed, true);
});

test('stopping pauses a backing and Play resumes it where it left off', () => {
  pageSetBacking([bed()]);
  pageLoadBacking('0/bed.wav', 'audio/wav', 'AAAA');
  media[0].advance(4);
  pageSetBacking([bed({ playing: false })]);
  assert.equal(media[0].paused, true);
  pageSetBacking([bed()]);
  assert.equal(media[0].paused, false);
  assert.equal(media[0].currentTime, 4, 'resumed, not restarted');
});

test('restart: true starts the file over on Play', () => {
  pageSetBacking([bed({ restart: true })]);
  pageLoadBacking('0/bed.wav', 'audio/wav', 'AAAA');
  media[0].advance(4);
  pageSetBacking([bed({ restart: true, playing: false })]);
  pageSetBacking([bed({ restart: true })]);
  assert.equal(media[0].paused, false);
  assert.equal(media[0].currentTime, 0);
});

test('a one-shot that finished stays finished across Play, unless it restarts', () => {
  pageSetBacking([bed({ loop: false })]);
  pageLoadBacking('0/bed.wav', 'audio/wav', 'AAAA');
  media[0].end();
  pageSetBacking([bed({ loop: false, playing: false })]);
  pageSetBacking([bed({ loop: false })]);
  assert.equal(media[0].paused, true);
  pageSetBacking([bed({ loop: false, restart: true, playing: false })]);
  pageSetBacking([bed({ loop: false, restart: true })]);
  assert.equal(media[0].paused, false);
});

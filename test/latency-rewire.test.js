import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// src/latency-instrument.js runs in the browser (module-scope DOM/WebAudio
// subscriptions), so it can't be imported under node:test. These are
// source-shape tests in the same spirit as bots/test/bot.test.js's
// String(pageFn) assertions: they pin the renegotiation-survival fixes behind
// the bots-spawn total-mute (2026-07-15) — a P2P→JVB flip replaces every
// WebRTC track, and every one-shot wiring keyed to the old track goes silent
// forever.

const latencySrc = await readFile(new URL('../src/latency-instrument.js', import.meta.url), 'utf8');
const configCheckSrc = await readFile(new URL('../src/audio-config-check.js', import.meta.url), 'utf8');

test('captureJitsiAudio re-wires a peer whose stream/track was replaced', () => {
  // The wiring must record what it was built from…
  assert.match(latencySrc, /remoteSources\.set\(jitsiId, \{ tag, stream, track:/,
    'remoteSources entries carry the wired stream + track for staleness checks');
  // …and treat the entry as dead when any of the three replacement signals
  // fire: tag left the DOM, tag.srcObject swapped, or the wired track ended.
  assert.match(latencySrc, /existing\.tag\.isConnected/, 'detects a replaced tag');
  assert.match(latencySrc, /existing\.tag\.srcObject === existing\.stream/, 'detects a swapped srcObject');
  assert.match(latencySrc, /existing\.track\.readyState === 'live'/, 'detects an ended track');
});

test('audio wirings are re-verified on a poll, not only on DOM mutations', () => {
  // A srcObject swap mutates no DOM, so the MutationObserver alone never sees
  // a renegotiation replace a stream — captureJitsiAudio must also run on the
  // codebase's standard 1s Jitsi-state poll.
  assert.match(latencySrc, /setInterval\(captureJitsiAudio, 1000\)/);
});

test('the aggregator-mode Strudel publish survives a replaced local track', () => {
  // The guard runs for the whole time an aggregator is present and re-publishes
  // when the effect no longer rides the live local track.
  assert.match(latencySrc, /function ensureStrudelPublishGuard\(\)/);
  assert.match(latencySrc, /current === strudelRoomEffect\.track/,
    'verifies the published track is still the current one');
  // A successful publish must arm the guard too — the original retry stopped
  // the moment a publish took hold, leaving a later replacement unnoticed.
  assert.match(latencySrc, /strudelRoomEffect = \{ track, effect \};[^]*?ensureStrudelPublishGuard\(\);/,
    'guard stays armed after a successful publish');
});

test('audio config guard demands p2p disabled (ENABLE_P2P=false)', () => {
  // A human+aggregator room is exactly 2 participants, so with p2p enabled the
  // first bot spawn always forces the P2P→JVB flip. The deployed config.js is
  // generated from the video VM's gitignored .env — this client-side check is
  // what surfaces a forgotten ENABLE_P2P=false at deploy time.
  assert.match(configCheckSrc, /c\.p2p && c\.p2p\.enabled === false/);
  assert.match(configCheckSrc, /ENABLE_P2P=false/);
});

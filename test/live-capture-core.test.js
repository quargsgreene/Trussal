import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LiveRing, EventLog, CursorPath,
  matchAudioDevice, captureSlug, parseLiveCaptureArgs, patternWordsToString,
  rewriteLiveCaptureCalls, MEDIA,
} from '../src/live-capture-core.js';

const f32 = (...vals) => Float32Array.from(vals);

// --- LiveRing ---------------------------------------------------------------

test('ring: snapshot of an empty ring is all silence', () => {
  const ring = new LiveRing(8);
  assert.equal(ring.filled, 0);
  assert.deepEqual([...ring.snapshot(4)], [0, 0, 0, 0]);
});

test('ring: partial fill front-pads with silence, data at the end', () => {
  const ring = new LiveRing(8);
  ring.write(f32(1, 2, 3));
  assert.equal(ring.filled, 3);
  assert.deepEqual([...ring.snapshot(5)], [0, 0, 1, 2, 3]);
});

test('ring: snapshot returns the most recent frames in order', () => {
  const ring = new LiveRing(8);
  ring.write(f32(1, 2, 3, 4, 5, 6));
  assert.deepEqual([...ring.snapshot(3)], [4, 5, 6]);
});

test('ring: wrap-around keeps chronological order', () => {
  const ring = new LiveRing(4);
  ring.write(f32(1, 2, 3));
  ring.write(f32(4, 5, 6)); // overwrites 1, 2
  assert.equal(ring.filled, 4);
  assert.deepEqual([...ring.snapshot(4)], [3, 4, 5, 6]);
});

test('ring: a chunk larger than capacity keeps only its tail', () => {
  const ring = new LiveRing(3);
  ring.write(f32(1, 2, 3, 4, 5));
  assert.deepEqual([...ring.snapshot(3)], [3, 4, 5]);
  ring.write(f32(6));
  assert.deepEqual([...ring.snapshot(3)], [4, 5, 6]);
});

test('ring: snapshot request larger than capacity clamps to capacity', () => {
  const ring = new LiveRing(4);
  ring.write(f32(1, 2, 3, 4, 5, 6));
  const snap = ring.snapshot(100);
  assert.equal(snap.length, 4);
  assert.deepEqual([...snap], [3, 4, 5, 6]);
});

test('ring: many small writes across the seam', () => {
  const ring = new LiveRing(5);
  for (let i = 1; i <= 12; i++) ring.write(f32(i));
  assert.deepEqual([...ring.snapshot(5)], [8, 9, 10, 11, 12]);
});

// --- EventLog -------------------------------------------------------------

test('log: latest is the freshest value, null when empty', () => {
  const log = new EventLog();
  assert.equal(log.latest(), null);
  log.push('a', 1);
  log.push('b', 2);
  assert.equal(log.latest().value, 'b');
});

test('log: nextAfter walks forward then wraps to the oldest', () => {
  const log = new EventLog();
  log.push('a', 10);
  log.push('b', 20);
  log.push('c', 30);
  assert.equal(log.nextAfter(0).value, 'a');
  assert.equal(log.nextAfter(10).value, 'b');
  assert.equal(log.nextAfter(20).value, 'c');
  assert.equal(log.nextAfter(30).value, 'a'); // past the end → wrap
});

test('log: capacity drops the oldest entries', () => {
  const log = new EventLog({ capacity: 3, windowMs: 0 });
  for (let i = 1; i <= 5; i++) log.push(i, i);
  assert.equal(log.length, 3);
  assert.deepEqual(log.entries.map(e => e.value), [3, 4, 5]);
});

test('log: windowMs drops entries older than the newest minus the window', () => {
  const log = new EventLog({ capacity: 100, windowMs: 100 });
  log.push('old', 0);
  log.push('mid', 90);
  log.push('new', 200); // trims anything before t=100
  assert.deepEqual(log.entries.map(e => e.value), ['new']);
});

test('log: reset empties it', () => {
  const log = new EventLog();
  log.push('a', 1);
  log.reset();
  assert.equal(log.length, 0);
  assert.equal(log.latest(), null);
});

// --- CursorPath --------------------------------------------------------------

test('path: empty path reads null, single sample reads that point', () => {
  const path = new CursorPath();
  assert.equal(path.at(0), null);
  path.push(10, 20, 0);
  assert.deepEqual(path.at(999), { x: 10, y: 20 });
});

test('path: linear interpolation across the span', () => {
  const path = new CursorPath();
  path.push(0, 0, 0);
  path.push(100, 200, 100);
  assert.deepEqual(path.at(0), { x: 0, y: 0 });
  assert.deepEqual(path.at(25), { x: 25, y: 50 });
  assert.deepEqual(path.at(90), { x: 90, y: 180 });
});

test('path: the head wraps modulo the span (reaching the end loops to the start)', () => {
  const path = new CursorPath();
  path.push(0, 0, 0);
  path.push(100, 100, 100);
  assert.deepEqual(path.at(100), { x: 0, y: 0 });   // one full lap
  assert.deepEqual(path.at(150), { x: 50, y: 50 });
  assert.deepEqual(path.at(250), { x: 50, y: 50 });
});

test('path: non-finite samples are ignored; capacity bounds the ring', () => {
  const path = new CursorPath(3);
  path.push(NaN, 1, 0);
  path.push(1, 1, 1);
  path.push(2, 2, 2);
  path.push(3, 3, 3);
  path.push(4, 4, 4);
  assert.equal(path.length, 3);
  assert.equal(path.points[0].x, 2);
});

// --- matchAudioDevice -------------------------------------------------------

const DEVICES = [
  { deviceId: 'id-default', label: 'Default - Built-in Microphone' },
  { deviceId: 'id-motu', label: 'MOTU M4' },
  { deviceId: 'id-monitor', label: 'Monitor of Built-in Audio Analog Stereo' },
  { deviceId: 'id-unlabeled', label: '' },
];

test('match: exact label, case-insensitive', () => {
  assert.equal(matchAudioDevice(DEVICES, 'motu m4').deviceId, 'id-motu');
});

test('match: substring falls back when no exact hit', () => {
  assert.equal(matchAudioDevice(DEVICES, 'monitor of').deviceId, 'id-monitor');
});

test('match: exact label beats substring on another device', () => {
  const devices = [
    { deviceId: 'a', label: 'Mic 1 (copy)' },
    { deviceId: 'b', label: 'Mic 1' },
  ];
  assert.equal(matchAudioDevice(devices, 'Mic 1').deviceId, 'b');
});

test('match: raw deviceId accepted as a last resort', () => {
  assert.equal(matchAudioDevice(DEVICES, 'id-unlabeled').deviceId, 'id-unlabeled');
});

test('match: empty name means default input (null)', () => {
  assert.equal(matchAudioDevice(DEVICES, ''), null);
  assert.equal(matchAudioDevice(DEVICES, '   '), null);
});

test('match: no hit returns null', () => {
  assert.equal(matchAudioDevice(DEVICES, 'Scarlett 2i2'), null);
});

// --- captureSlug ---------------------------------------------------------

test('slug: mini-notation-safe keys, medium prefix, self fallback', () => {
  assert.equal(captureSlug('audio', 'MOTU M4'), 'livecap_audio_motu_m4');
  assert.equal(captureSlug('audio', 'Monitor of Built-in Audio'), 'livecap_audio_monitor_of_built_in_audio');
  assert.equal(captureSlug('gesture', ''), 'livecap_gesture_self');
  assert.equal(captureSlug('cursor', '***'), 'livecap_cursor_self');
  assert.equal(captureSlug('video', 'Ada Lovelace'), 'livecap_video_ada_lovelace');
});

// --- parseLiveCaptureArgs ----------------------------------------------------

test('args: medium is lower-cased and validated against MEDIA', () => {
  assert.deepEqual(MEDIA, ['audio', 'video', 'text', 'css', 'gesture', 'cursor']);
  const ok = parseLiveCaptureArgs('AUDIO', 'MOTU M4', false);
  assert.equal(ok.medium, 'audio');
  assert.equal(ok.name, 'MOTU M4');
  assert.equal(ok.detectLocalDevices, false);
  assert.equal(ok.error, null);
});

test('args: an unknown medium yields an error string', () => {
  const bad = parseLiveCaptureArgs('sound', 'x');
  assert.equal(bad.medium, 'sound');
  assert.match(bad.error, /unknown medium/);
});

test('args: detectLocalDevices coerces true / "true" / 1', () => {
  assert.equal(parseLiveCaptureArgs('cursor', '', true).detectLocalDevices, true);
  assert.equal(parseLiveCaptureArgs('cursor', '', 'true').detectLocalDevices, true);
  assert.equal(parseLiveCaptureArgs('cursor', '', 1).detectLocalDevices, true);
  assert.equal(parseLiveCaptureArgs('cursor', '', 0).detectLocalDevices, false);
  assert.equal(parseLiveCaptureArgs('cursor', '').detectLocalDevices, false);
});

test('args: a mini-pattern medium/name is flattened to words', () => {
  const pat = {
    firstCycle: () => [
      { part: { begin: 0 }, value: 'MOTU' },
      { part: { begin: 0.5 }, value: 'M4' },
    ],
  };
  assert.equal(patternWordsToString(pat), 'MOTU M4');
  assert.equal(parseLiveCaptureArgs('audio', pat).name, 'MOTU M4');
});

// --- rewriteLiveCaptureCalls ----------------------------------------------

test('rewrite: string args become single-quoted so the transpiler skips them', () => {
  assert.equal(
    rewriteLiveCaptureCalls('$: liveCapture("audio", "MOTU M4").struct("<x ~ x>")'),
    `$: liveCapture('audio', 'MOTU M4').struct("<x ~ x>")`
  );
});

test('rewrite: a name with parentheses survives (mini would throw on it)', () => {
  assert.equal(
    rewriteLiveCaptureCalls('liveCapture("audio", "Scarlett 2i2 USB (Focusrite)")'),
    `liveCapture('audio', 'Scarlett 2i2 USB (Focusrite)')`
  );
});

test('rewrite: a trailing boolean argument passes through untouched', () => {
  assert.equal(
    rewriteLiveCaptureCalls('liveCapture("audio", "MOTU M4", true)'),
    `liveCapture('audio', 'MOTU M4', true)`
  );
  assert.equal(
    rewriteLiveCaptureCalls("liveCapture('cursor', '', false)"),
    `liveCapture('cursor', '', false)`
  );
});

test('rewrite: single-quoted and backtick args are normalized too', () => {
  assert.equal(rewriteLiveCaptureCalls("liveCapture('gesture')"), `liveCapture('gesture')`);
  assert.equal(rewriteLiveCaptureCalls('liveCapture(`text`, `Ada`)'), `liveCapture('text', 'Ada')`);
});

test('rewrite: a quote inside a name is escaped', () => {
  assert.equal(
    rewriteLiveCaptureCalls(`liveCapture("audio", "Bob's Mic")`),
    `liveCapture('audio', 'Bob\\'s Mic')`
  );
});

test('rewrite: only the call args are touched, other strings stay mini', () => {
  const out = rewriteLiveCaptureCalls('$: liveCapture("text", "Ada").struct("<x ~ x>").s("bd")');
  assert.ok(out.includes(`.struct("<x ~ x>")`));
  assert.ok(out.includes(`.s("bd")`));
  assert.ok(out.includes(`liveCapture('text', 'Ada')`));
});

test('rewrite: no-argument liveCapture() is preserved', () => {
  assert.equal(rewriteLiveCaptureCalls('liveCapture()'), 'liveCapture()');
  assert.equal(rewriteLiveCaptureCalls('liveCapture()', { silent: true }), '_liveCaptureSilent()');
});

test('rewrite: silent mode swaps the callee for remote peers', () => {
  assert.equal(
    rewriteLiveCaptureCalls('$: liveCapture("audio", "MOTU M4").struct("<x ~ x>")', { silent: true }),
    `$: _liveCaptureSilent('audio', 'MOTU M4').struct("<x ~ x>")`
  );
});

test('rewrite: silent mode also catches non-literal argument forms', () => {
  assert.equal(
    rewriteLiveCaptureCalls('liveCapture("text", deviceVar)', { silent: true }),
    "_liveCaptureSilent('text', deviceVar)"
  );
  // The plain-literal medium is still normalized; only the interpolated name
  // is left as written.
  assert.equal(
    rewriteLiveCaptureCalls('liveCapture(`audio`, `Mic ${n}`)', { silent: true }),
    "_liveCaptureSilent('audio', `Mic ${n}`)"
  );
});

test('rewrite: silent mode never double-rewrites', () => {
  const out = rewriteLiveCaptureCalls('liveCapture("audio","A") liveCapture("audio","B")', { silent: true });
  assert.equal(out, `_liveCaptureSilent('audio', 'A') _liveCaptureSilent('audio', 'B')`);
  assert.ok(!out.includes('_liveCapture_liveCaptureSilent'));
});

test('rewrite: identifiers merely containing liveCapture are left alone', () => {
  const code = 'const notliveCapture = 1; obj.liveCapture("x"); myliveCapture("y")';
  const out = rewriteLiveCaptureCalls(code, { silent: true });
  assert.equal(out, code);
});

test('rewrite: multiple liveCapture() calls in one block', () => {
  assert.equal(
    rewriteLiveCaptureCalls('$: liveCapture("audio","A").struct("x")\n$: liveCapture("video","B (2)").struct("x")'),
    `$: liveCapture('audio', 'A').struct("x")\n$: liveCapture('video', 'B (2)').struct("x")`
  );
});

test('rewrite: code without liveCapture() is unchanged', () => {
  const code = 's("bd sd").room(2)';
  assert.equal(rewriteLiveCaptureCalls(code), code);
  assert.equal(rewriteLiveCaptureCalls(code, { silent: true }), code);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LiveRing, matchAudioDevice, liveSlug, rewriteLiveCalls } from '../src/live-input-core.js';

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

// --- liveSlug ---------------------------------------------------------------

test('slug: mini-notation-safe sound keys', () => {
  assert.equal(liveSlug('MOTU M4'), 'live_motu_m4');
  assert.equal(liveSlug('Monitor of Built-in Audio'), 'live_monitor_of_built_in_audio');
  assert.equal(liveSlug(''), 'live_default');
  assert.equal(liveSlug('***'), 'live_default');
});

// --- rewriteLiveCalls -------------------------------------------------------

test('rewrite: double-quoted name becomes single-quoted so the transpiler skips it', () => {
  assert.equal(
    rewriteLiveCalls('$: live("MOTU M4").struct("<x ~ x>")'),
    `$: live('MOTU M4').struct("<x ~ x>")`
  );
});

test('rewrite: a device label with parentheses survives (mini would throw on it)', () => {
  assert.equal(
    rewriteLiveCalls('live("Scarlett 2i2 USB (Focusrite)")'),
    `live('Scarlett 2i2 USB (Focusrite)')`
  );
});

test('rewrite: single-quoted and backtick names are normalized too', () => {
  assert.equal(rewriteLiveCalls("live('MOTU M4')"), `live('MOTU M4')`);
  assert.equal(rewriteLiveCalls('live(`MOTU M4`)'), `live('MOTU M4')`);
});

test('rewrite: a quote inside the name is escaped', () => {
  assert.equal(rewriteLiveCalls(`live("Bob's Mic")`), `live('Bob\\'s Mic')`);
});

test('rewrite: only the name literal is touched, other strings stay mini', () => {
  const out = rewriteLiveCalls('$: live("X").struct("<x ~ x>").s("bd")');
  assert.ok(out.includes(`.struct("<x ~ x>")`));
  assert.ok(out.includes(`.s("bd")`));
});

test('rewrite: no-argument live() is preserved', () => {
  assert.equal(rewriteLiveCalls('live()'), 'live()');
  assert.equal(rewriteLiveCalls('live()', { silent: true }), '_liveSilent()');
});

test('rewrite: silent mode swaps the callee for remote peers', () => {
  assert.equal(
    rewriteLiveCalls('$: live("MOTU M4").struct("<x ~ x>")', { silent: true }),
    `$: _liveSilent('MOTU M4').struct("<x ~ x>")`
  );
});

test('rewrite: silent mode also catches forms the literal pass skipped', () => {
  assert.equal(rewriteLiveCalls('live(deviceVar)', { silent: true }), '_liveSilent(deviceVar)');
  assert.equal(
    rewriteLiveCalls('live(`Mic ${n}`)', { silent: true }),
    '_liveSilent(`Mic ${n}`)'
  );
});

test('rewrite: silent mode never double-rewrites', () => {
  const out = rewriteLiveCalls('live("A") live("B")', { silent: true });
  assert.equal(out, `_liveSilent('A') _liveSilent('B')`);
  assert.ok(!out.includes('_live_liveSilent'));
});

test('rewrite: identifiers merely containing "live" are left alone', () => {
  const code = 'const alive = 1; obj.live("x"); relive("y")';
  const out = rewriteLiveCalls(code, { silent: true });
  assert.equal(out, code);
});

test('rewrite: multiple live() calls in one block', () => {
  assert.equal(
    rewriteLiveCalls('$: live("A").struct("x")\n$: live("B (2)").struct("x")'),
    `$: live('A').struct("x")\n$: live('B (2)').struct("x")`
  );
});

test('rewrite: code without live() is unchanged', () => {
  const code = 's("bd sd").room(2)';
  assert.equal(rewriteLiveCalls(code), code);
  assert.equal(rewriteLiveCalls(code, { silent: true }), code);
});

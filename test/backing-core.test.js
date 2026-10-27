import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BACKING_CALL_RE,
  backingKindOf,
  parseBackingCalls,
  peerBackings,
  backingsForPeers,
  backingsEqual,
  stripBackingCalls,
} from '../src/backing-core.js';

test('backingKindOf accepts audio and video uploads only', () => {
  assert.equal(backingKindOf('bed.wav'), 'audio');
  assert.equal(backingKindOf('bed.MP3'), 'audio');
  assert.equal(backingKindOf('clip.mp4'), 'video');
  assert.equal(backingKindOf('clip.mov'), 'video');
  assert.equal(backingKindOf('cat.png'), null);
  assert.equal(backingKindOf('notes.txt'), null);
});

test('parseBackingCalls reads the file and both flags', () => {
  assert.deepEqual(parseBackingCalls('$: backing("example.wav", true, false)'), [
    { name: 'example.wav', kind: 'audio', loop: true, turnOnly: false, restart: false },
  ]);
  assert.deepEqual(parseBackingCalls("$: backing('my clip.mp4', false, true)"), [
    { name: 'my clip.mp4', kind: 'video', loop: false, turnOnly: true, restart: false },
  ]);
});

test('parseBackingCalls reads the restart flag', () => {
  assert.deepEqual(parseBackingCalls('$: backing("bed.wav", true, false, true)'), [
    { name: 'bed.wav', kind: 'audio', loop: true, turnOnly: false, restart: true },
  ]);
});

test('parseBackingCalls defaults to looping on every turn', () => {
  assert.deepEqual(parseBackingCalls('$: backing("bed.wav")'), [
    { name: 'bed.wav', kind: 'audio', loop: true, turnOnly: false, restart: false },
  ]);
  assert.deepEqual(parseBackingCalls('$: backing("bed.wav", false)'), [
    { name: 'bed.wav', kind: 'audio', loop: false, turnOnly: false, restart: false },
  ]);
});

test('parseBackingCalls ignores unplayable files and keeps one entry per file', () => {
  const code = [
    '$: s("bd sd")',
    '$: backing("cat.png")',
    '$: backing("bed.wav", true, false)',
    '$: backing("bed.wav", false, true)',
  ].join('\n');
  assert.deepEqual(parseBackingCalls(code), [
    { name: 'bed.wav', kind: 'audio', loop: false, turnOnly: true, restart: false },
  ]);
});

test('peerBackings requires the personal editor directive', () => {
  assert.deepEqual(peerBackings('$: backing("bed.wav")'), []);
  assert.equal(peerBackings(`'personal editor'\n$: backing("bed.wav")`).length, 1);
});

test('backingsForPeers takes humans with a room index, stopped ones included', () => {
  const pattern = `'personal editor'\n$: backing("bed.wav", true, true)`;
  const peers = [
    { roomIndex: 0, playing: true, pattern },
    { roomIndex: 1, playing: false, pattern },
    { roomIndex: '0a', playing: true, isBot: true, pattern },
    { roomIndex: null, playing: true, pattern },
    { roomIndex: 2, playing: true, isAggregator: true, pattern },
  ];
  assert.deepEqual(backingsForPeers(peers), [
    { token: '0', name: 'bed.wav', kind: 'audio', loop: true, turnOnly: true, restart: false, playing: true },
    { token: '1', name: 'bed.wav', kind: 'audio', loop: true, turnOnly: true, restart: false, playing: false },
  ]);
});

test('backingsEqual compares every field', () => {
  const a = [{ token: '0', name: 'bed.wav', kind: 'audio', loop: true, turnOnly: false, restart: false, playing: true }];
  assert.equal(backingsEqual(a, [{ ...a[0] }]), true);
  assert.equal(backingsEqual(a, [{ ...a[0], turnOnly: true }]), false);
  assert.equal(backingsEqual(a, [{ ...a[0], playing: false }]), false);
  assert.equal(backingsEqual(a, [{ ...a[0], restart: true }]), false);
  assert.equal(backingsEqual(a, []), false);
});

test('stripping backing statements leaves the rest of the program', () => {
  const code = '$: s("bd sd")\n$: backing("bed.wav", true, false)\n$: n("0 2").s("piano")';
  assert.ok(BACKING_CALL_RE.test(code));
  assert.equal(stripBackingCalls(code), '$: s("bd sd")\n$: n("0 2").s("piano")');
  assert.equal(stripBackingCalls('$: backing("bed.wav")'), '');
  assert.equal(BACKING_CALL_RE.test('$: s("bd").feedbacking(2)'), false);
});

test('backingsForPeers reads a Map or any iterable of peers', () => {
  const peer = { roomIndex: 0, playing: true, pattern: `'personal editor'\n$: backing("bed.wav")` };
  const roster = new Map([['p0', peer]]);
  assert.equal(backingsForPeers(roster).length, 1);
  assert.equal(backingsForPeers(roster.values()).length, 1);
});

import test from 'node:test';
import assert from 'node:assert/strict';

import { SampleStore, isAudioName, isSafeSegment } from '../src/orchestrator/sample-store.js';

const ROOM = 'gig';
const OWNER = '1';
const bytes = (n, fill = 0x41) => Buffer.alloc(n, fill);

test('accepts an audio file and serves it back', () => {
  const store = new SampleStore();
  assert.deepEqual(store.put(ROOM, OWNER, { bank: 'kicks', name: 'a.wav', bytes: bytes(10) }), { ok: true });
  assert.equal(store.get(ROOM, OWNER, 'kicks', 'a.wav').bytes.length, 10);
});

test('rejects a non-audio file', () => {
  const store = new SampleStore();
  const res = store.put(ROOM, OWNER, { bank: 'kicks', name: 'notes.txt', bytes: bytes(10) });
  assert.equal(res.ok, false);
  assert.match(res.error, /not an audio file/);
});

test('rejects path traversal rather than sanitising it', () => {
  const store = new SampleStore();
  for (const name of ['../escape.wav', 'a/b.wav', '..']) {
    assert.equal(store.put(ROOM, OWNER, { bank: 'kicks', name, bytes: bytes(10) }).ok, false, name);
  }
  for (const bank of ['../escape', 'a/b', '.']) {
    assert.equal(store.put(ROOM, OWNER, { bank, name: 'a.wav', bytes: bytes(10) }).ok, false, bank);
  }
});

test('rejects an empty file', () => {
  const store = new SampleStore();
  const res = store.put(ROOM, OWNER, { bank: 'kicks', name: 'a.wav', bytes: Buffer.alloc(0) });
  assert.equal(res.ok, false);
  assert.match(res.error, /empty/);
});

test('enforces the per-file cap with a reason naming the file', () => {
  const store = new SampleStore({ maxFileBytes: 100, maxOwnerBytes: 1000 });
  const res = store.put(ROOM, OWNER, { bank: 'kicks', name: 'big.wav', bytes: bytes(101) });
  assert.equal(res.ok, false);
  assert.match(res.error, /big\.wav/);
  assert.match(res.error, /per-file limit/);
});

test('enforces the per-owner cap', () => {
  const store = new SampleStore({ maxFileBytes: 100, maxOwnerBytes: 150 });
  assert.equal(store.put(ROOM, OWNER, { bank: 'k', name: 'a.wav', bytes: bytes(100) }).ok, true);
  const res = store.put(ROOM, OWNER, { bank: 'k', name: 'b.wav', bytes: bytes(100) });
  assert.equal(res.ok, false);
  assert.match(res.error, /limit/);
});

test('re-sending a path replaces it instead of double-counting', () => {
  const store = new SampleStore({ maxFileBytes: 100, maxOwnerBytes: 150 });
  assert.equal(store.put(ROOM, OWNER, { bank: 'k', name: 'a.wav', bytes: bytes(100) }).ok, true);
  assert.equal(store.put(ROOM, OWNER, { bank: 'k', name: 'a.wav', bytes: bytes(90) }).ok, true);
  assert.equal(store.totalBytes(ROOM, OWNER), 90);
});

test('owners and rooms are isolated', () => {
  const store = new SampleStore();
  store.put(ROOM, '1', { bank: 'k', name: 'a.wav', bytes: bytes(10) });
  assert.equal(store.get(ROOM, '2', 'k', 'a.wav'), null);
  assert.equal(store.get('other', '1', 'k', 'a.wav'), null);
});

test('the manifest groups by bank and sorts numerically for stable indices', () => {
  const store = new SampleStore();
  for (const name of ['k10.wav', 'k2.wav', 'k1.wav']) {
    store.put(ROOM, OWNER, { bank: 'kicks', name, bytes: bytes(5) });
  }
  const manifest = store.manifestFor(ROOM, OWNER, 'http://localhost:7700');
  assert.deepEqual(manifest.kicks.map((u) => u.split('/').pop()), ['k1.wav', 'k2.wav', 'k10.wav']);
  assert.match(manifest.kicks[0], /^http:\/\/localhost:7700\/samples\/gig\/1\/kicks\/k1\.wav$/);
});

test('an owner with no samples has an empty manifest', () => {
  assert.deepEqual(new SampleStore().manifestFor(ROOM, OWNER, 'http://x'), {});
});

test('clear drops one owner\'s library', () => {
  const store = new SampleStore();
  store.put(ROOM, OWNER, { bank: 'k', name: 'a.wav', bytes: bytes(10) });
  store.clear(ROOM, OWNER);
  assert.equal(store.totalBytes(ROOM, OWNER), 0);
});

test('segment and audio predicates', () => {
  assert.equal(isSafeSegment('my kit-01.wav'), true);
  assert.equal(isSafeSegment(''), false);
  assert.equal(isSafeSegment('a/b'), false);
  assert.equal(isAudioName('x.WAV'), true);
  assert.equal(isAudioName('x.txt'), false);
});

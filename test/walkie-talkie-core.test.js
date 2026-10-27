import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isOfferer,
  walkieAwayJitsiIds,
  walkiePartners,
  diffConnections,
  iceServersFrom,
  walkieLabel,
  DEFAULT_ICE_SERVERS,
} from '../src/walkie-talkie-core.js';

const roster = [
  { peerId: 'a', jitsiId: 'ja', displayName: 'Ann' },
  { peerId: 'b', jitsiId: 'jb', displayName: '' , roomIndex: 2 },
];

test('isOfferer: exactly one side of a pair offers', () => {
  assert.equal(isOfferer('a', 'b'), true);
  assert.equal(isOfferer('b', 'a'), false);
});

test('walkieAwayJitsiIds hides every walkie peer from a non-walkie view', () => {
  assert.deepEqual(walkieAwayJitsiIds(roster, { localWalkie: false, myPeerId: 'z' }), ['ja', 'jb']);
});

test('walkieAwayJitsiIds hides nobody while we are in Walkie Talkie Mode ourselves', () => {
  assert.deepEqual(walkieAwayJitsiIds(roster, { localWalkie: true, myPeerId: 'a' }), []);
});

test('walkiePartners leaves ourselves out', () => {
  assert.deepEqual(walkiePartners(roster, 'a').map((p) => p.peerId), ['b']);
  assert.deepEqual(walkiePartners(null, 'a'), []);
});

test('diffConnections opens the missing and closes the departed', () => {
  assert.deepEqual(diffConnections(['b', 'c'], [{ peerId: 'b' }, { peerId: 'd' }]), { add: ['d'], remove: ['c'] });
});

test('iceServersFrom prefers the Jitsi P2P STUN list', () => {
  const stun = [{ urls: 'stun:example.org:3478' }];
  assert.deepEqual(iceServersFrom({ p2p: { stunServers: stun } }), stun);
  assert.deepEqual(iceServersFrom({ p2p: {} }), DEFAULT_ICE_SERVERS);
  assert.deepEqual(iceServersFrom(undefined), DEFAULT_ICE_SERVERS);
});

test('walkieLabel falls back from name to room index', () => {
  assert.equal(walkieLabel(roster[0]), 'Ann');
  assert.equal(walkieLabel(roster[1]), 'Participant 2');
  assert.equal(walkieLabel({}), 'Participant');
});

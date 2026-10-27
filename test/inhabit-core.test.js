import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveInhabitMap,
  hostAtCycle,
  sanitizeInhabitMap,
  inhabitMapsEqual,
  hostOf,
  guestsOf,
  turnTokenFor,
  inhabitRole,
  foldInhabitantSamples,
  planInhabitMoves,
  sanitizeHostSnapshot,
  privateChatEntry,
  isInhabitToken,
} from '../src/inhabit-core.js';

// --- resolving the map -------------------------------------------------------

test('a static entry maps every guest to the host on every cycle', () => {
  const entries = [{ hosts: ['0'], slow: 1, guests: ['1', '2b'] }];
  for (const cycle of [0, 1, 7, -3]) {
    assert.deepEqual(resolveInhabitMap(entries, cycle), { 1: '0', '2b': '0' });
  }
});

test('a host pattern takes one host per cycle and a rest lets the guests go', () => {
  const entries = [{ hosts: ['0', '~', '3a'], slow: 1, guests: ['1'] }];
  assert.deepEqual(resolveInhabitMap(entries, 0), { 1: '0' });
  assert.deepEqual(resolveInhabitMap(entries, 1), {});
  assert.deepEqual(resolveInhabitMap(entries, 2), { 1: '3a' });
  assert.deepEqual(resolveInhabitMap(entries, 3), { 1: '0' });
});

test('/n holds each host for n cycles, and negative cycles floor-mod', () => {
  const entry = { hosts: ['0', '~'], slow: 2, guests: ['1'] };
  assert.deepEqual([0, 1, 2, 3, 4].map((c) => hostAtCycle(entry, c)), ['0', '0', null, null, '0']);
  assert.equal(hostAtCycle(entry, -1), null);
  assert.equal(hostAtCycle(entry, -3), '0');
});

test('a guest is only ever in one host, and never in itself', () => {
  const entries = [
    { hosts: ['0'], slow: 1, guests: ['1'] },
    { hosts: ['2'], slow: 1, guests: ['1', '2', '3'] },
  ];
  assert.deepEqual(resolveInhabitMap(entries, 0), { 1: '0', 3: '2' });
});

test('sanitizeInhabitMap keeps valid pairs only', () => {
  assert.deepEqual(sanitizeInhabitMap({ 1: '0', '2b': '0', x: '0', 3: 'pi', 4: '4', '5': 7 }), { 1: '0', '2b': '0' });
  assert.deepEqual(sanitizeInhabitMap(null), {});
  assert.deepEqual(sanitizeInhabitMap(['0']), {});
});

test('tokens follow the room-index shape', () => {
  for (const t of ['0', '12', '2b', '0za']) assert.equal(isInhabitToken(t), true, t);
  for (const t of ['', 'a', '2B', '2ab', 'pi', '1.5', 3]) assert.equal(isInhabitToken(t), false, String(t));
});

test('map helpers: equality, hosts, guests, the turn token', () => {
  const map = { 1: '0', '2b': '0', 3: '1' };
  assert.equal(inhabitMapsEqual(map, { 3: '1', '2b': '0', 1: '0' }), true);
  assert.equal(inhabitMapsEqual(map, { 1: '0' }), false);
  assert.equal(hostOf(map, 1), '0');
  assert.equal(hostOf(map, '0'), null);
  assert.deepEqual(guestsOf(map, '0'), ['1', '2b']);
  assert.equal(turnTokenFor('1', map), '0');
  assert.equal(turnTokenFor('0', map), '0');
  assert.equal(turnTokenFor('3', map), '1', 'inhabiting is not transitive');
});

test('inhabitRole only counts participants who are present', () => {
  const map = { 1: '0', '2b': '0' };
  assert.deepEqual(inhabitRole(map, '1', ['0', '1', '2b']), { inhabiting: '0', hosting: [] });
  assert.deepEqual(inhabitRole(map, '0', ['0', '1']), { inhabiting: null, hosting: ['1'] });
  assert.deepEqual(inhabitRole(map, '1', ['1']), { inhabiting: null, hosting: [] }, 'a host who left takes nobody in');
});

// --- folding audio -----------------------------------------------------------

const f32 = (...v) => Float32Array.from(v);
const arr = (x) => Array.from(x, (v) => Math.round(v * 1000) / 1000);

test('with no map every take is written as it came', () => {
  const a = f32(0.1);
  const out = foldInhabitantSamples([{ token: '0', samples: a }, { token: '1', samples: f32(0.2) }], {});
  assert.deepEqual(out.map((e) => e.token), ['0', '1']);
  assert.equal(out[0].samples, a);
});

test('a guest is mixed into its host, at the host\'s position, and its own slot gets nothing', () => {
  const out = foldInhabitantSamples([
    { token: '1', samples: f32(0.25, 0.25, 0.5) },
    { token: '0', samples: f32(0.5, -0.5) },
    { token: '2', samples: f32(0.1) },
  ], { 1: '0' });
  assert.deepEqual(out.map((e) => e.token), ['0', '2']);
  assert.deepEqual(arr(out[0].samples), [0.75, -0.25, 0.5]);
});

test('a host with no audio this batch still hears its guests', () => {
  const out = foldInhabitantSamples([{ token: '1', samples: f32(0.3) }, { token: '2b', samples: f32(0.2) }], { 1: '0', '2b': '0' });
  assert.deepEqual(out.map((e) => e.token), ['0']);
  assert.deepEqual(arr(out[0].samples), [0.5]);
});

test('mixing clamps into [-1, 1] and never mutates the input', () => {
  const host = f32(0.9, -0.9);
  const out = foldInhabitantSamples([{ token: '0', samples: host }, { token: '1', samples: f32(0.9, -0.9) }], { 1: '0' });
  assert.deepEqual(arr(out[0].samples), [1, -1]);
  assert.deepEqual(arr(host), [0.9, -0.9]);
});

test('a host that is itself a guest elsewhere still carries its own guests', () => {
  const out = foldInhabitantSamples([
    { token: '0', samples: f32(0.1) },
    { token: '1', samples: f32(0.2) },
    { token: '2', samples: f32(0.4) },
  ], { 1: '0', 0: '2' });
  const byToken = Object.fromEntries(out.map((e) => [e.token, arr(e.samples)]));
  assert.deepEqual(byToken, { 0: [0.2], 2: [0.5] });
});

// --- rooms -------------------------------------------------------------------

const ROOMS = {
  'main@muc': { jid: 'main@muc', isMainRoom: true, participants: { 'main@muc/aaa': { jid: 'j-0', displayName: 'Zero' }, 'main@muc/bbb': { jid: 'j-1', displayName: 'One' } } },
  'r1@muc': { jid: 'r1@muc', name: 'room', participants: { 'r1@muc/ccc': { jid: 'j-2', displayName: 'Two' } } },
};
const PEERS = new Map([
  ['0', { jitsiId: 'aaa', displayName: 'Zero' }],
  ['1', { jitsiId: 'bbb', displayName: 'One' }],
  ['2', { jitsiId: 'ccc', displayName: 'Two' }],
]);

test('a guest is moved into its host\'s room and remembers where it came from', () => {
  const { moves, origins } = planInhabitMoves({ map: { 1: '2' }, rawRooms: ROOMS, peersByToken: PEERS });
  assert.deepEqual(moves, [{ token: '1', participantJid: 'j-1', roomJid: 'r1@muc' }]);
  assert.equal(origins.get('1'), 'main@muc');
});

test('a guest already with its host is left where it is', () => {
  const { moves } = planInhabitMoves({ map: { 0: '1' }, rawRooms: ROOMS, peersByToken: PEERS });
  assert.deepEqual(moves, []);
});

test('a guest goes back to its origin once it inhabits nobody, and the origin is forgotten', () => {
  const rooms = { ...ROOMS, 'r1@muc': { ...ROOMS['r1@muc'], participants: { ...ROOMS['r1@muc'].participants, 'r1@muc/bbb': { jid: 'j-1', displayName: 'One' } } } };
  delete rooms['main@muc'].participants;
  rooms['main@muc'] = { ...ROOMS['main@muc'], participants: { 'main@muc/aaa': { jid: 'j-0', displayName: 'Zero' } } };
  const { moves, origins } = planInhabitMoves({ map: {}, rawRooms: rooms, peersByToken: PEERS, origins: new Map([['1', 'main@muc']]) });
  assert.deepEqual(moves, [{ token: '1', participantJid: 'j-1', roomJid: 'main@muc' }]);
  assert.equal(origins.size, 0);
});

test('a guest whose origin room has closed goes back to the main room', () => {
  const { moves } = planInhabitMoves({ map: {}, rawRooms: ROOMS, peersByToken: PEERS, origins: new Map([['2', 'gone@muc']]) });
  assert.deepEqual(moves, [{ token: '2', participantJid: 'j-2', roomJid: 'main@muc' }]);
});

test('a panic-button presser is never moved, and a move in flight is not repeated', () => {
  assert.deepEqual(planInhabitMoves({ map: { 1: '2' }, rawRooms: ROOMS, peersByToken: PEERS, isExempt: (t) => t === '1' }).moves, []);
  assert.deepEqual(planInhabitMoves({
    map: { 1: '2' }, rawRooms: ROOMS, peersByToken: PEERS, expectedRoomOf: (jid) => (jid === 'j-1' ? 'r1@muc' : null),
  }).moves, []);
});

test('the origins passed in are not mutated', () => {
  const origins = new Map();
  planInhabitMoves({ map: { 1: '2' }, rawRooms: ROOMS, peersByToken: PEERS, origins });
  assert.equal(origins.size, 0);
});

// --- the host's snapshot -----------------------------------------------------

test('privateChatEntry keeps private messages only, and names the other side', () => {
  assert.equal(privateChatEntry({ message: 'hi', privateMessage: false }), null);
  assert.deepEqual(privateChatEntry({
    message: 'hello', privateMessage: true, messageType: 'remote', participantId: 'p9', displayName: 'Nine', timestamp: 5, messageId: 'm1',
  }), { id: 'm1', outgoing: false, peerId: 'p9', peerName: 'Nine', text: 'hello', at: 5, viaGuest: null });
  const out = privateChatEntry({ message: 'yo', privateMessage: true, messageType: 'local', participantId: 'me', recipient: 'Nine', recipientId: 'p9' });
  assert.equal(out.outgoing, true);
  assert.equal(out.peerId, 'p9');
  assert.equal(privateChatEntry({ message: 'yo', privateMessage: true, messageType: 'local', participantId: 'me', recipient: 'Nine' }).peerId, null);
});

test('sanitizeHostSnapshot drops whatever is malformed and never throws', () => {
  const snap = sanitizeHostSnapshot({
    displayName: 'Host',
    theme: { darkMode: true, primary: '#fff', walkieTalkie: true, disableMediaPipe: true, font: 5 },
    chats: [{ text: 'a', outgoing: 1, peerId: 'p', peerName: 'P' }, { text: '' }, 'junk'],
    devices: { audio: ['MOTU', 'MOTU', 3], screens: 'nope' },
    routes: [{ key: 'k', author: 'A', label: 'L', kind: 'screen', media: ['video'], decision: 'maybe' }, { nokey: true }],
    editorReady: 1,
    settings: { effects: { reverb: 1 } },
  });
  assert.deepEqual(snap.theme, { darkMode: true, primary: '#fff' });
  assert.equal(snap.chats.length, 1);
  assert.equal(snap.chats[0].outgoing, true);
  assert.deepEqual(snap.devices, { audio: ['MOTU'], screens: [] });
  assert.deepEqual(snap.routes, [{ key: 'k', author: 'A', label: 'L', kind: 'screen', media: ['video'], decision: null }]);
  assert.equal(snap.editorReady, true);
  assert.deepEqual(snap.settings.effects, { distortion: false, noise: false, reverb: true });
  assert.deepEqual(sanitizeHostSnapshot(null).chats, []);
});

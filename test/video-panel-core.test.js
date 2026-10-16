import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  tileIdFor,
  remoteVideoIdFor,
  orderPanelParticipants,
  chooseLargeVideoId,
  receiverConstraintsPayload,
  humanUiWanted,
} from '../src/video-panel-core.js';

test('tileIdFor / remoteVideoIdFor produce the ids the bundle already queries', () => {
  assert.equal(tileIdFor('abc123'), 'participant_abc123');
  assert.equal(remoteVideoIdFor('abc123'), 'remoteVideo_abc123');
  assert.equal(tileIdFor(''), '');
  assert.equal(tileIdFor(null), '');
  assert.equal(remoteVideoIdFor(undefined), '');
});

test('orderPanelParticipants puts local first and sorts remotes deterministically', () => {
  const ordered = orderPanelParticipants([
    { id: 'z', isLocal: false },
    { id: 'b', isLocal: false },
    { id: 'me', isLocal: true },
    { id: 'a', isLocal: false },
  ]);
  assert.deepEqual(ordered.map((p) => p.id), ['me', 'a', 'b', 'z']);
});

test('orderPanelParticipants drops id-less entries and tolerates non-arrays', () => {
  assert.deepEqual(orderPanelParticipants(null), []);
  assert.deepEqual(orderPanelParticipants([null, { displayName: 'x' }]), []);
});

test('chooseLargeVideoId prefers an explicit pin', () => {
  const list = [
    { id: 'me', isLocal: true },
    { id: 'bot', isLocal: false },
  ];
  assert.equal(chooseLargeVideoId(list, { pinnedId: 'me' }), 'me');
  assert.equal(chooseLargeVideoId(list, { pinnedId: 'bot' }), 'bot');
  // A pin for someone no longer present is ignored.
  assert.equal(chooseLargeVideoId(list, { pinnedId: 'gone' }), 'bot');
});

test('chooseLargeVideoId falls back: aggregator, then first remote, then local', () => {
  assert.equal(chooseLargeVideoId([
    { id: 'me', isLocal: true },
    { id: 'bot', isLocal: false },
    { id: 'agg', isLocal: false, isAggregator: true },
  ]), 'agg');

  assert.equal(chooseLargeVideoId([
    { id: 'me', isLocal: true },
    { id: 'bot', isLocal: false },
  ]), 'bot');

  assert.equal(chooseLargeVideoId([{ id: 'me', isLocal: true }]), 'me');
  assert.equal(chooseLargeVideoId([]), null);
});

test('receiverConstraintsPayload asks for every participant at 360p', () => {
  assert.deepEqual(receiverConstraintsPayload(), {
    defaultConstraints: { maxHeight: 360 },
    lastN: -1,
  });
});

test('humanUiWanted is false only for bot/aggregator pages', () => {
  assert.equal(humanUiWanted({}), true);
  assert.equal(humanUiWanted({ __trussalIsBot: true }), false);
  assert.equal(humanUiWanted({ __trussalIsAggregator: true }), false);
  assert.equal(humanUiWanted({ __trussalIsBot: false, __trussalIsAggregator: false }), true);
});

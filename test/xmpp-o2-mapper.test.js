import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  XMPPtoO2Mapper,
  serviceNameForIndex,
  indexForServiceName,
  syncMapperFromPeerEvent
} from '../src/bridges/XMPPtoO2Mapper.js';

test('service names round-trip through indices', () => {
  assert.equal(serviceNameForIndex('0'), '/perf/0');
  assert.equal(serviceNameForIndex('1a'), '/perf/1a');
  assert.equal(indexForServiceName('/perf/1a'), '1a');
  assert.equal(indexForServiceName('/perf/3/pattern'), '3');
  assert.equal(indexForServiceName('/other/3'), null);
  assert.equal(serviceNameForIndex('bogus!'), null);
});

test('mapper keeps a bijection under re-registration', () => {
  const m = new XMPPtoO2Mapper();
  assert.ok(m.register('jid-a', '0'));
  assert.ok(m.register('jid-b', '1'));
  assert.equal(m.serviceNameFor('jid-b'), '/perf/1');
  assert.equal(m.jitsiIdForService('/perf/0'), 'jid-a');

  // Same pair again: no-op.
  m.register('jid-a', '0');
  assert.equal(m.size(), 2);

  // Index moves to a different jitsiId (reconnect with fresh Jitsi id):
  // old jitsiId must no longer resolve.
  m.register('jid-a2', '0');
  assert.equal(m.jitsiIdForIndex('0'), 'jid-a2');
  assert.equal(m.roomIndexFor('jid-a'), null);
  assert.equal(m.size(), 2);

  m.unregister('jid-b');
  assert.equal(m.jitsiIdForIndex('1'), null);
  assert.equal(m.size(), 1);
});

test('syncMapperFromPeerEvent tracks the peer-state bus', () => {
  const m = new XMPPtoO2Mapper();
  syncMapperFromPeerEvent(m, 'peer-upsert', { jitsiId: 'j1', roomIndex: '2' });
  syncMapperFromPeerEvent(m, 'peer-upsert', { jitsiId: 'j2', roomIndex: null }); // no index yet — ignored
  assert.equal(m.serviceNameFor('j1'), '/perf/2');
  assert.equal(m.serviceNameFor('j2'), null);
  syncMapperFromPeerEvent(m, 'peer-leave', { jitsiId: 'j1', roomIndex: '2' });
  assert.equal(m.serviceNameFor('j1'), null);
});

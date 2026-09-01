import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

import {
  mergeInducedMetrics,
  computeVlanWorstCase,
  vlanMixGains,
  INDUCTIONS
} from '../src/audio-net/network-modulation/WorstCaseCalculationUtils.js';
import { IncreasePacketLoss } from '../src/audio-net/network-modulation/IncreasePacketLoss.js';

const require = createRequire(import.meta.url);
const { createLatencyServer } = require('../latency-instrument/server.js');

test('effective metric merge is strictly upward: induced below measured is a no-op', () => {
  const measured = { wcl: 200, wcrtt: 400, wcpl: 0.1, wcjb: 55 };
  const below = mergeInducedMetrics(measured, { wcl: 50, wcrtt: 100, wcpl: 0.01 });
  assert.deepEqual(below, measured);
  const above = mergeInducedMetrics(measured, { wcl: 900, wcpl: 0.7 });
  assert.equal(above.wcl, 900);
  assert.equal(above.wcpl, 0.7);
  assert.equal(above.wcrtt, 400, 'untouched metrics keep their measured value');
  assert.equal(above.wcjb, 55, 'wcl\'s broken-out terms pass through unchanged');
});

test('induction sliders clamp to their ranges (packet loss ≤ 1, nothing negative)', () => {
  assert.equal(IncreasePacketLoss.clamp(3), 1);
  assert.equal(IncreasePacketLoss.clamp(-0.5), 0);
  assert.equal(IncreasePacketLoss.clamp('nope'), 0);
  assert.equal(INDUCTIONS.wcl.applyTo(100, -50), 100);
  assert.equal(INDUCTIONS.wcl.applyTo(100, 999999), 5000, 'induced latency caps at the slider max');
});

test('per-VLAN worst case: members only, VLAN-local induced conditions', () => {
  const peers = [
    { roomIndex: '0', rtt: 40, packetLoss: 0.01 },
    { roomIndex: '1', rtt: 400, packetLoss: 0.5 },
    { roomIndex: '2', rtt: 80, packetLoss: 0.05 }
  ];
  // Members only: member 1's 400 ms link and 0.5 loss must not leak in.
  const local = computeVlanWorstCase(peers, { members: ['0', '2'] });
  assert.equal(local.wcrtt, 80, "member 1's terrible link doesn't leak into this VLAN");
  assert.equal(local.wcl, 80 / 2 + 40 / 2 + 40, "nor its latency");
  assert.equal(local.wcpl, 0.05, "nor its packet loss");
  // VLAN-local induced floor applies on top of the members-only measurement.
  const floored = computeVlanWorstCase(peers, { members: ['0', '2'], induced: { wcpl: 0.3 } });
  assert.equal(floored.wcpl, 0.3, 'VLAN-local induced loss floor applies');
});

test('VLAN mix-down gains: equal power, defaulting to one mutual VLAN', () => {
  assert.deepEqual(vlanMixGains([]), { default: 1 });
  assert.deepEqual(vlanMixGains(null), { default: 1 });
  const two = vlanMixGains(['a', 'b']);
  assert.ok(Math.abs(two.a - 1 / Math.sqrt(2)) < 1e-12);
  assert.equal(two.a, two.b);
  const four = vlanMixGains(['a', 'b', 'c', 'd']);
  assert.equal(four.a, 0.5);
});

// --- Relay: modulation channel honors canWriteModulation, not canEditMetaprogram ---

function connect(port, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room}`);
    const client = { ws, messages: [], waiters: [] };
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      client.messages.push(msg);
      client.waiters = client.waiters.filter(w => (w.pred(msg) ? (w.resolve(msg), false) : true));
    });
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
}
function waitFor(client, pred, ms = 2000) {
  const hit = client.messages.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    client.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
}
function send(c, m) { c.ws.send(JSON.stringify(m)); }
async function settled(c) { send(c, { type: 'ping', sentAt: Date.now() }); await waitFor(c, m => m.type === 'pong'); }

test('bot with modulation-write (but not edit) permission: modulation relays, metaprogram is dropped', async () => {
  const { wss } = createLatencyServer({ port: 0 });
  await new Promise(r => wss.once('listening', r));
  const port = wss.address().port;
  try {
    const human = await connect(port, 'mod1');
    send(human, { type: 'hello', jitsiId: 'jh', displayName: 'h' });
    await waitFor(human, m => m.type === 'roster');
    const bot = await connect(port, 'mod1');
    send(bot, { type: 'hello', jitsiId: 'jb', displayName: 'b', isBot: true, ownerIndex: '0' });
    await waitFor(bot, m => m.type === 'roster');
    const join = await waitFor(human, m => m.type === 'peer-join');

    send(human, { type: 'bot-permission', targetPeerId: join.peer.peerId, canWriteModulation: true });
    await waitFor(human, m => m.type === 'peer-update' && m.patch.canWriteModulation === true);

    send(bot, { type: 'crdt-update', update: 'AAA=', channel: 'modulation', modality: 'bot' });
    const relayed = await waitFor(human, m => m.type === 'crdt-update');
    assert.equal(relayed.channel, 'modulation');
    assert.equal(relayed.authorIndex, '0a');

    const before = human.messages.filter(m => m.type === 'crdt-update').length;
    send(bot, { type: 'crdt-update', update: 'AAA=', channel: 'metaprogram' });
    await settled(bot);
    assert.equal(human.messages.filter(m => m.type === 'crdt-update').length, before,
      'metaprogram edit still requires canEditMetaprogram');
    human.ws.close(); bot.ws.close();
  } finally {
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
});

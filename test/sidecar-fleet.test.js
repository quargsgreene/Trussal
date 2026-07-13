// Sidecar fleet plumbing: the fleet client is invisible to participants,
// human fleet-requests are relayed with the requester's index, bots can't
// drive the fleet, and fleet-status reaches the room.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { createLatencyServer } = require('../latency-instrument/server.js');

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
async function hello(client, fields) {
  client.ws.send(JSON.stringify({ type: 'hello', displayName: 'x', ...fields }));
  return (await waitFor(client, m => m.type === 'roster'));
}
function send(client, msg) { client.ws.send(JSON.stringify(msg)); }
async function settled(client) {
  send(client, { type: 'ping', sentAt: Date.now() });
  await waitFor(client, m => m.type === 'pong');
}

test('fleet relay: invisible fleet, stamped requests, bot requests dropped, status broadcast', async () => {
  const { wss } = createLatencyServer({ port: 0 });
  await new Promise(r => wss.once('listening', r));
  const port = wss.address().port;
  try {
    const human = await connect(port, 'fleet1');
    const humanRoster = await hello(human, { jitsiId: 'jh' });
    assert.equal(humanRoster.you.roomIndex, '0');

    const fleet = await connect(port, 'fleet1');
    const fleetRoster = await hello(fleet, { jitsiId: 'fleet-x', isFleet: true });
    assert.equal(fleetRoster.you.roomIndex, null, 'fleet gets no participant index');
    assert.ok(!human.messages.some(m => m.type === 'peer-join' && m.peer.jitsiId === 'fleet-x'),
      'fleet join is never announced');

    // Late joiner must not see the fleet in the roster either — and takes
    // index 1, proving the fleet consumed no index.
    const late = await connect(port, 'fleet1');
    const lateRoster = await hello(late, { jitsiId: 'jl' });
    assert.equal(lateRoster.you.roomIndex, '1');
    assert.ok(!lateRoster.peers.some(p => p.jitsiId === 'fleet-x'));

    // Human spawn request → relayed to the fleet with fromIndex stamped.
    send(human, { type: 'fleet-request', action: 'spawn', count: 3 });
    const req = await waitFor(fleet, m => m.type === 'fleet-request');
    assert.equal(req.fromIndex, '0');
    assert.equal(req.action, 'spawn');
    assert.equal(req.count, 3);

    // Bot request is dropped.
    const bot = await connect(port, 'fleet1');
    await hello(bot, { jitsiId: 'jb', isBot: true, ownerIndex: '0' });
    const before = fleet.messages.filter(m => m.type === 'fleet-request').length;
    send(bot, { type: 'fleet-request', action: 'spawn', count: 99 });
    await settled(bot);
    assert.equal(fleet.messages.filter(m => m.type === 'fleet-request').length, before,
      'bot fleet-request never relayed');

    // fleet-status reaches the humans.
    send(fleet, { type: 'fleet-status', action: 'spawn', ownerIndex: '0', spawned: 2, requested: 3, reason: 'health ceiling 2 reached' });
    const status = await waitFor(human, m => m.type === 'fleet-status');
    assert.equal(status.spawned, 2);
    assert.match(status.reason, /health ceiling/);

    human.ws.close(); fleet.ws.close(); late.ws.close(); bot.ws.close();
  } finally {
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
});

// A fleet's own connection is persistent (opened once, kept alive for the
// conductor's lifetime), so `room.size === 0` never fires purely from
// participants leaving — the "only fleet left" branch is what tells a
// still-connected fleet the meeting is actually over.
test('session-reset: broadcast only once the room becomes fleet-only, not on every leave', async () => {
  const { wss } = createLatencyServer({ port: 0 });
  await new Promise(r => wss.once('listening', r));
  const port = wss.address().port;
  try {
    const fleet = await connect(port, 'fleet2');
    await hello(fleet, { jitsiId: 'fleet-x', isFleet: true });

    const human = await connect(port, 'fleet2');
    await hello(human, { jitsiId: 'jh' });
    const bot = await connect(port, 'fleet2');
    await hello(bot, { jitsiId: 'jb', isBot: true, ownerIndex: '0' });

    human.ws.close();
    // Wait for the bot to see the human's peer-leave — deterministic proof
    // the server finished processing the close, unlike a ping/pong on the
    // fleet's own (different) connection, which has no ordering guarantee
    // relative to a close handled on another socket.
    await waitFor(bot, m => m.type === 'peer-leave');
    assert.ok(
      !fleet.messages.some(m => m.type === 'session-reset'),
      'the bot is still there — not fleet-only yet',
    );

    bot.ws.close();
    await waitFor(fleet, m => m.type === 'session-reset');

    fleet.ws.close();
  } finally {
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
});

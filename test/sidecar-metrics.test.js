// Integration: the latency sidecar relays the extended metrics fields
// (packetLoss, rtcRtt, rtcJitter, jitterBufferMs, pipelineMs) alongside the
// existing rtt/jitter, and includes them in the roster snapshot for late
// joiners.
//
// The transport leg is tested because it is where these fields get silently
// dropped: rtcJitter was measured by NetStats for months and never reached
// any peer, because nothing here asserted it survived the round trip.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { createLatencyServer } = require('../latency-instrument/server.js');

function connect(port, room) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room}&role=player`);
    const client = { ws, messages: [], waiters: [] };
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      client.messages.push(msg);
      client.waiters = client.waiters.filter(w => {
        if (w.pred(msg)) { w.resolve(msg); return false; }
        return true;
      });
    });
    ws.on('open', () => resolve(client));
    ws.on('error', reject);
  });
}

function waitFor(client, pred, ms = 2000) {
  const hit = client.messages.find(pred);
  if (hit) return Promise.resolve(hit);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timed out waiting for message')), ms);
    client.waiters.push({ pred, resolve: (m) => { clearTimeout(t); resolve(m); } });
  });
}

function send(client, msg) { client.ws.send(JSON.stringify(msg)); }

async function withServer(fn) {
  const { wss } = createLatencyServer({ port: 0 });
  await new Promise(r => wss.once('listening', r));
  const port = wss.address().port;
  try {
    await fn(port);
  } finally {
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
}

test('metrics broadcast carries packetLoss and rtcRtt to other peers', async () => {
  await withServer(async (port) => {
    const a = await connect(port, 'r1');
    send(a, { type: 'hello', jitsiId: 'jit-a', displayName: 'A' });
    await waitFor(a, m => m.type === 'roster');
    const b = await connect(port, 'r1');
    send(b, { type: 'hello', jitsiId: 'jit-b', displayName: 'B' });
    await waitFor(b, m => m.type === 'roster');
    const joined = await waitFor(a, m => m.type === 'peer-join');
    const bPeerId = joined.peer.peerId;

    send(b, {
      type: 'metrics', rtt: 42, jitter: 1.5, packetLoss: 0.12,
      rtcRtt: 66, rtcJitter: 2.75, jitterBufferMs: 48, pipelineMs: 31
    });
    const update = await waitFor(a, m => m.type === 'peer-update' && m.peerId === bPeerId && m.patch.packetLoss != null);
    assert.equal(update.patch.rtt, 42);
    assert.equal(update.patch.jitter, 1.5);
    assert.equal(update.patch.packetLoss, 0.12);
    assert.equal(update.patch.rtcRtt, 66);
    assert.equal(update.patch.rtcJitter, 2.75, 'media jitter reaches other peers');
    assert.equal(update.patch.jitterBufferMs, 48);
    assert.equal(update.patch.pipelineMs, 31);

    // Partial update (RTCStats only) keeps the previously stored WS values.
    send(b, { type: 'metrics', packetLoss: 0.3 });
    const update2 = await waitFor(a, m => m.type === 'peer-update' && m.peerId === bPeerId && m.patch.packetLoss === 0.3);
    assert.equal(update2.patch.rtt, 42);
    assert.equal(update2.patch.rtcRtt, 66);
    assert.equal(update2.patch.rtcJitter, 2.75, 'an absent key leaves the stored value alone');

    a.ws.close(); b.ws.close();
  });
});

test('an explicit null CLEARS a stored metric rather than being ignored', async () => {
  // A peer that stops receiving media reports rtcJitter: null. If the sidecar
  // ignored the null the last reading would be rebroadcast forever, pinning
  // the room's WCJ (and so its turn length) to a dead measurement.
  await withServer(async (port) => {
    const a = await connect(port, 'r3');
    send(a, { type: 'hello', jitsiId: 'jit-a', displayName: 'A' });
    await waitFor(a, m => m.type === 'roster');
    const b = await connect(port, 'r3');
    send(b, { type: 'hello', jitsiId: 'jit-b', displayName: 'B' });
    await waitFor(b, m => m.type === 'roster');
    const joined = await waitFor(a, m => m.type === 'peer-join');
    const bPeerId = joined.peer.peerId;

    send(b, { type: 'metrics', rtt: 20, jitter: 1, rtcRtt: 30, rtcJitter: 9 });
    await waitFor(a, m => m.type === 'peer-update' && m.peerId === bPeerId && m.patch.rtcJitter === 9);

    send(b, { type: 'metrics', rtcRtt: 30, rtcJitter: null });
    const cleared = await waitFor(a, m => m.type === 'peer-update' && m.peerId === bPeerId && m.patch.rtcJitter === null);
    assert.equal(cleared.patch.rtcJitter, null, 'the clear is relayed');
    assert.equal(cleared.patch.rtcRtt, 30, 'a sibling field measured in the same poll survives');
    assert.equal(cleared.patch.rtt, 20, 'the WS fallback leg is untouched by an RTCStats clear');

    a.ws.close(); b.ws.close();
  });
});

test('late joiner receives extended metrics in the roster snapshot', async () => {
  await withServer(async (port) => {
    const a = await connect(port, 'r2');
    send(a, { type: 'hello', jitsiId: 'jit-a', displayName: 'A' });
    await waitFor(a, m => m.type === 'roster');
    send(a, { type: 'metrics', rtt: 10, jitter: 0.4, packetLoss: 0.05, rtcRtt: 25 });
    // Ping/pong on the same socket guarantees the metrics message was
    // processed before the late joiner connects.
    send(a, { type: 'ping', sentAt: Date.now() });
    await waitFor(a, m => m.type === 'pong');
    const b = await connect(port, 'r2');
    send(b, { type: 'hello', jitsiId: 'jit-b', displayName: 'B' });
    const roster = await waitFor(b, m => m.type === 'roster');
    const aView = roster.peers.find(p => p.jitsiId === 'jit-a');
    assert.ok(aView, 'A present in roster');
    assert.equal(aView.packetLoss, 0.05);
    assert.equal(aView.rtcRtt, 25);
    assert.equal(aView.rtt, 10);

    a.ws.close(); b.ws.close();
  });
});

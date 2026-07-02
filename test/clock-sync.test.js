// ClockSync unit tests (fake clock, scripted replies) and the O2Relay
// integration: two clients converge to agreeing clock offsets even with
// simulated asymmetric network delay.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

import { ClockSync, makeClockSyncOverO2 } from '../src/audio-net/ClockSync.js';
import { O2LiteClient } from '../public/lib/o2lite-web.js';

const require = createRequire(import.meta.url);
const { createO2Relay } = require('../latency-instrument/o2-relay.js');

// --- Unit: deterministic fake clock -----------------------------------------

function makeFakeSync({ serverAhead = 100, oneWayMs = [10, 10] } = {}) {
  // local clock in seconds; server clock = local + serverAhead.
  let localNow = 1000;
  const sent = [];
  const sync = new ClockSync({
    sendCsGet: (seq, t) => sent.push({ seq, t }),
    now: () => localNow,
    setTimeoutFn: null, // drive bursts by hand
    clearTimeoutFn: null
  });
  const deliverReply = ({ seq, t }, [upMs, downMs] = oneWayMs) => {
    // Request takes upMs to reach the server, reply takes downMs back.
    const serverTime = (localNow + upMs / 1000) + serverAhead;
    localNow += (upMs + downMs) / 1000;
    sync.handleReply(seq, t, serverTime);
  };
  return { sync, sent, deliverReply, setLocal: (v) => { localNow = v; }, getLocal: () => localNow };
}

test('symmetric delay: offset equals the true clock difference', () => {
  const { sync, sent, deliverReply } = makeFakeSync({ serverAhead: 100, oneWayMs: [10, 10] });
  sync.start();
  assert.equal(sent.length, 1); // no timers → single shot fired
  deliverReply(sent[0]);
  sync._commitBurst();
  assert.ok(sync.isSynced());
  assert.ok(Math.abs(sync.stats().offset - 100) < 1e-9);
  // Mapping round-trips.
  const nt = sync.toNetworkTime(2000);
  assert.ok(Math.abs(sync.toAudioTime(nt) - 2000) < 1e-9);
});

test('burst keeps the minimum-RTT reply (least queueing noise)', () => {
  const { sync, sent, deliverReply } = makeFakeSync({ serverAhead: 50 });
  sync.start();
  deliverReply(sent[0], [40, 90]); // noisy: rtt 130 ms, asymmetric → offset error
  sync._fireOne();
  deliverReply(sent[1], [5, 5]);   // clean: rtt 10 ms
  sync._fireOne();
  deliverReply(sent[2], [80, 20]); // noisy again
  sync._commitBurst();
  assert.ok(Math.abs(sync.stats().offset - 50) < 1e-9, `offset ${sync.stats().offset}`);
});

test('asymmetric delay biases offset by half the asymmetry — bounded, not divergent', () => {
  const { sync, sent, deliverReply } = makeFakeSync({ serverAhead: 100, oneWayMs: [50, 0] });
  sync.start();
  deliverReply(sent[0]);
  sync._commitBurst();
  // up 50 ms / down 0: NTP-style estimate is off by (50-0)/2 = 25 ms.
  assert.ok(Math.abs(sync.stats().offset - 100 - 0.025) < 1e-9);
});

test('negative RTT replies (clock weirdness) are discarded', () => {
  const { sync, sent } = makeFakeSync({});
  sync.start();
  sync.handleReply(sent[0].seq, sent[0].t + 999, 0); // clientSent in the future
  sync._commitBurst();
  assert.equal(sync.isSynced(), false);
  assert.equal(sync.toNetworkTime(1), null);
});

// --- Integration: two clients through a real in-process relay ---------------

test('two clients over the O2Relay agree on network time within 10 ms under 50 ms asymmetric delay', async () => {
  const { wss } = createO2Relay({ port: 0 });
  await new Promise(r => wss.once('listening', r));
  const port = wss.address().port;

  const makeClient = async (delayUpMs) => {
    const client = new O2LiteClient({ url: `ws://127.0.0.1:${port}/o2?room=cs`, WebSocketImpl: WebSocket });
    await client.connect();
    // Simulate an asymmetric uplink: delay outgoing /_cs/get frames.
    const realSend = client.sendCsGet.bind(client);
    if (delayUpMs > 0) {
      client.sendCsGet = (seq, t) => setTimeout(() => realSend(seq, t), delayUpMs);
    }
    const t0 = process.hrtime.bigint();
    const now = () => Number(process.hrtime.bigint() - t0) / 1e9;
    const sync = makeClockSyncOverO2(client, now);
    return { client, sync, now };
  };

  const a = await makeClient(0);
  const b = await makeClient(50);
  try {
    a.sync.start();
    b.sync.start();
    // One burst each: 5 pings at 100 ms spacing + commit ≈ 700 ms.
    await new Promise(r => setTimeout(r, 900));
    assert.ok(a.sync.isSynced(), 'A synced');
    assert.ok(b.sync.isSynced(), 'B synced');
    // Compare both mappings of "the same instant": use A's local now.
    const sample = a.now();
    const viaA = a.sync.toNetworkTime(sample);
    // B's clock shares the process clock here, so B maps the same value.
    const viaB = b.sync.toNetworkTime(sample);
    const diffMs = Math.abs(viaA - viaB) * 1000;
    assert.ok(diffMs < 10 + 25, `|offsetA − offsetB| = ${diffMs.toFixed(2)} ms (50 ms one-way asymmetry biases ≤ 25 ms)`);
  } finally {
    a.sync.stop(); b.sync.stop();
    a.client.close(); b.client.close();
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
});

test('relay fans out non-cs messages to the room, not the sender', async () => {
  const { wss } = createO2Relay({ port: 0 });
  await new Promise(r => wss.once('listening', r));
  const port = wss.address().port;

  const mk = async (room) => {
    const c = new O2LiteClient({ url: `ws://127.0.0.1:${port}/o2?room=${room}`, WebSocketImpl: WebSocket });
    c.received = [];
    c.method('/', (m) => c.received.push(m));
    await c.connect();
    return c;
  };
  const a = await mk('fan');
  const b = await mk('fan');
  const other = await mk('elsewhere');
  try {
    a.send('/perf/0/pattern', ',s', ['s("bd sd")'], 12.5);
    await new Promise(r => setTimeout(r, 200));
    assert.equal(b.received.length, 1);
    assert.equal(b.received[0].address, '/perf/0/pattern');
    assert.equal(b.received[0].timestamp, 12.5);
    assert.deepEqual(b.received[0].args, ['s("bd sd")']);
    assert.equal(a.received.length, 0, 'sender must not hear its own message');
    assert.equal(other.received.length, 0, 'other rooms must not hear it');
  } finally {
    a.close(); b.close(); other.close();
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
});

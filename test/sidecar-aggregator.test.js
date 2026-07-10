// Sidecar single-aggregator claim: only one aggregator per room may ever hold
// the slot, so a losing aggregator bot never joins the meeting. The claim is
// granted to the first asker, denied while held or while an aggregator has
// joined, and released when the holder disconnects.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { createLatencyServer } = require('../latency-instrument/server.js');

function connectTo(port, room, track) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${room}`);
    const client = { ws, messages: [], waiters: [] };
    if (track) track.add(client);
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
function send(client, msg) { client.ws.send(JSON.stringify(msg)); }
async function claim(client) {
  send(client, { type: 'aggregator-claim' });
  return waitFor(client, m => m.type === 'aggregator-claim-result');
}
async function hello(client, fields) {
  send(client, { type: 'hello', displayName: 'x', ...fields });
  return waitFor(client, m => m.type === 'roster');
}
function closed(client) {
  return new Promise((r) => { client.ws.on('close', r); client.ws.close(); });
}

// Runs fn with a live server and a room-scoped connect() that tracks every
// client, then tears them all down (and the server) so node --test can exit.
async function withServer(fn) {
  const { wss } = createLatencyServer({ port: 0 });
  await new Promise(r => wss.once('listening', r));
  const port = wss.address().port;
  const clients = new Set();
  const connect = (room) => connectTo(port, room, clients);
  try {
    await fn(connect);
  } finally {
    for (const c of clients) { try { c.ws.terminate(); } catch {} }
    await new Promise((r) => wss.close(r));
  }
}

test('aggregator-claim: first asker wins, a second is denied while it is held', async () => {
  await withServer(async (connect) => {
    const a = await connect('agg1');
    assert.equal((await claim(a)).granted, true, 'first claim is granted');

    const b = await connect('agg1');
    assert.equal((await claim(b)).granted, false, 'a second claim is denied while the slot is held');
  });
});

test('aggregator-claim: the probe is invisible — it never appears in a participant roster', async () => {
  await withServer(async (connect) => {
    const probe = await connect('agg2');
    await claim(probe);

    const human = await connect('agg2');
    const roster = await hello(human, { jitsiId: 'jh' });
    assert.equal(roster.you.roomIndex, '0', 'the human takes index 0 — the probe consumed none');
    assert.equal(roster.peers.length, 0, 'the claim probe is not a roster participant');
  });
});

test('aggregator-claim: releasing (disconnecting the holder) frees the slot for a replacement', async () => {
  await withServer(async (connect) => {
    const a = await connect('agg3');
    assert.equal((await claim(a)).granted, true);

    await closed(a); // holder leaves -> claim released

    const b = await connect('agg3');
    assert.equal((await claim(b)).granted, true, 'the slot is claimable again once the holder is gone');
  });
});

test('aggregator-claim: an already-joined aggregator blocks a fresh claim', async () => {
  await withServer(async (connect) => {
    // An aggregator that joined via the bundle (hello isAggregator) holds the
    // room even without a probe claim outstanding.
    const joined = await connect('agg4');
    await hello(joined, { jitsiId: 'aggJ', isAggregator: true });

    const other = await connect('agg4');
    assert.equal((await claim(other)).granted, false, 'cannot claim while an aggregator is already in the room');
  });
});

test('aggregator-claim: a non-aggregator room grants the claim', async () => {
  await withServer(async (connect) => {
    const human = await connect('agg5');
    await hello(human, { jitsiId: 'jh' });

    const agg = await connect('agg5');
    assert.equal((await claim(agg)).granted, true, 'a room with only humans has a free aggregator slot');
  });
});

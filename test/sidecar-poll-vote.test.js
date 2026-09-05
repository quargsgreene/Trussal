// Integration: meeting-poll click-to-vote relay (see src/polls.js). Every
// viewer's own click is broadcast to everyone else so their tally agrees;
// the sidecar keeps no tally of its own (see polls.js's doc comment).

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

test('poll-vote broadcasts to every other peer, not back to the sender', async () => {
  await withServer(async (port) => {
    const a = await connect(port, 'r1');
    send(a, { type: 'hello', jitsiId: 'jit-a', displayName: 'A' });
    await waitFor(a, m => m.type === 'roster');
    const b = await connect(port, 'r1');
    send(b, { type: 'hello', jitsiId: 'jit-b', displayName: 'B' });
    await waitFor(b, m => m.type === 'roster');
    await waitFor(a, m => m.type === 'peer-join');

    send(a, { type: 'poll-vote', pollId: 'Is water wet?', option: 'yes', previousOption: null, voterToken: '0' });

    const received = await waitFor(b, m => m.type === 'poll-vote');
    assert.equal(received.pollId, 'Is water wet?');
    assert.equal(received.option, 'yes');
    assert.equal(received.voterToken, '0');

    await new Promise(r => setTimeout(r, 100));
    assert.equal(a.messages.some(m => m.type === 'poll-vote'), false);
  });
});

test('poll-vote from a bot/fleet connection is rejected', async () => {
  await withServer(async (port) => {
    const a = await connect(port, 'r1');
    send(a, { type: 'hello', jitsiId: 'jit-a', displayName: 'A' });
    await waitFor(a, m => m.type === 'roster');
    const bot = await connect(port, 'r1');
    send(bot, { type: 'hello', jitsiId: 'jit-bot', displayName: 'Bot', isBot: true });
    await waitFor(bot, m => m.type === 'roster');
    await waitFor(a, m => m.type === 'peer-join');

    send(bot, { type: 'poll-vote', pollId: 'Q', option: 'a', previousOption: null, voterToken: '0a' });

    await new Promise(r => setTimeout(r, 200));
    assert.equal(a.messages.some(m => m.type === 'poll-vote'), false);
  });
});

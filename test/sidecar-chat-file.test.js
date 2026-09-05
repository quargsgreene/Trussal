// Integration: file-attachment patterns' (image()/video()/document()/
// soundFile(), see src/file-cycles.js) chat-file relay. Unlike sample-file
// (fleet-only), a chat attachment is broadcast to every OTHER human in the
// room — its whole point is that everyone sees the same download.

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

test('chat-file broadcasts to every other peer, not back to the sender', async () => {
  await withServer(async (port) => {
    const a = await connect(port, 'r1');
    send(a, { type: 'hello', jitsiId: 'jit-a', displayName: 'A' });
    await waitFor(a, m => m.type === 'roster');
    const b = await connect(port, 'r1');
    send(b, { type: 'hello', jitsiId: 'jit-b', displayName: 'B' });
    await waitFor(b, m => m.type === 'roster');
    await waitFor(a, m => m.type === 'peer-join');

    send(a, { type: 'chat-file', kind: 'image', name: 'cat.png', mime: 'image/png', data: Buffer.from('hi').toString('base64') });

    const received = await waitFor(b, m => m.type === 'chat-file');
    assert.equal(received.name, 'cat.png');
    assert.equal(received.kind, 'image');
    assert.equal(Buffer.from(received.data, 'base64').toString(), 'hi');

    // The sender never gets their own broadcast back — they already have the
    // bytes locally (file-cycles.js renders its own bubble before sending).
    await new Promise(r => setTimeout(r, 100));
    assert.equal(a.messages.some(m => m.type === 'chat-file'), false);
  });
});

test('chat-file over the 10MB cap is dropped, not forwarded', async () => {
  await withServer(async (port) => {
    const a = await connect(port, 'r1');
    send(a, { type: 'hello', jitsiId: 'jit-a', displayName: 'A' });
    await waitFor(a, m => m.type === 'roster');
    const b = await connect(port, 'r1');
    send(b, { type: 'hello', jitsiId: 'jit-b', displayName: 'B' });
    await waitFor(b, m => m.type === 'roster');
    await waitFor(a, m => m.type === 'peer-join');

    const oversized = Buffer.alloc(11 * 1024 * 1024, 1).toString('base64');
    send(a, { type: 'chat-file', kind: 'video', name: 'huge.mp4', mime: 'video/mp4', data: oversized });

    await new Promise(r => setTimeout(r, 200));
    assert.equal(b.messages.some(m => m.type === 'chat-file'), false);
  });
});

test('chat-file is rejected from a bot/fleet connection', async () => {
  await withServer(async (port) => {
    const a = await connect(port, 'r1');
    send(a, { type: 'hello', jitsiId: 'jit-a', displayName: 'A' });
    await waitFor(a, m => m.type === 'roster');
    const bot = await connect(port, 'r1');
    send(bot, { type: 'hello', jitsiId: 'jit-bot', displayName: 'Bot', isBot: true });
    await waitFor(bot, m => m.type === 'roster');
    await waitFor(a, m => m.type === 'peer-join');

    send(bot, { type: 'chat-file', kind: 'image', name: 'x.png', mime: 'image/png', data: Buffer.from('hi').toString('base64') });

    await new Promise(r => setTimeout(r, 200));
    assert.equal(a.messages.some(m => m.type === 'chat-file'), false);
  });
});

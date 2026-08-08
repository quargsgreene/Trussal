// Integration: CSS Cycles' SCSS compile round trip, including the
// bot-targeted form. A bot's own connection never runs the CSS Cycles
// pipeline (its REPL is a bare @strudel/repl — see
// bots/src/bot/page-scripts.js), so no browser is ever "local" to a bot's
// peer id. Every human viewer's own program parrots the bot's css()
// statements instead (buildBotSilentBlock in src/strudel.js) and compiles +
// sends on the bot's behalf, targeting it by peerId. The sidecar must accept
// that only for a peer it has recorded as a bot, and must still compile a
// human's own SCSS under their own connection as before.

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

test('scss compiles for the sending peer and echoes only to them', async () => {
  await withServer(async (port) => {
    const a = await connect(port, 'r1');
    send(a, { type: 'hello', jitsiId: 'jit-a', displayName: 'A' });
    await waitFor(a, m => m.type === 'roster');
    const b = await connect(port, 'r1');
    send(b, { type: 'hello', jitsiId: 'jit-b', displayName: 'B' });
    await waitFor(b, m => m.type === 'roster');
    const joined = await waitFor(a, m => m.type === 'peer-join');
    const bPeerId = joined.peer.peerId;

    send(b, { type: 'scss', source: '.ts-chip { color: red; }' });
    const echo = await waitFor(b, m => m.type === 'scss-compiled');
    assert.match(echo.css, /color/);
    const update = await waitFor(a, m => m.type === 'peer-update' && m.peerId === bPeerId && m.patch.compiledCss);
    assert.equal(update.patch.compiledCss, echo.css);

    a.ws.close(); b.ws.close();
  });
});

test('scss with a targetPeerId compiles on behalf of a bot and reaches every viewer, including the sender', async () => {
  await withServer(async (port) => {
    const human = await connect(port, 'r1');
    send(human, { type: 'hello', jitsiId: 'jit-human', displayName: 'Human' });
    await waitFor(human, m => m.type === 'roster');

    const bot = await connect(port, 'r1');
    send(bot, { type: 'hello', jitsiId: 'jit-bot', displayName: 'Bot', isBot: true });
    await waitFor(bot, m => m.type === 'roster');
    const joined = await waitFor(human, m => m.type === 'peer-join');
    const botPeerId = joined.peer.peerId;
    assert.equal(joined.peer.isBot, true);

    send(human, { type: 'scss', targetPeerId: botPeerId, source: '.ts-chip { color: blue; }' });

    const onHuman = await waitFor(human, m => m.type === 'peer-update' && m.peerId === botPeerId && m.patch.compiledCss);
    assert.match(onHuman.patch.compiledCss, /color/);
    // The human sender is not excluded from this broadcast — unlike the
    // self-compile case, they have no local record of the bot's compiledCss
    // to fall back on.
    const onBot = await waitFor(bot, m => m.type === 'peer-update' && m.peerId === botPeerId && m.patch.compiledCss);
    assert.equal(onBot.patch.compiledCss, onHuman.patch.compiledCss);

    human.ws.close(); bot.ws.close();
  });
});

test('scss targetPeerId is refused for a peer that is not a bot', async () => {
  await withServer(async (port) => {
    const a = await connect(port, 'r1');
    send(a, { type: 'hello', jitsiId: 'jit-a', displayName: 'A' });
    await waitFor(a, m => m.type === 'roster');
    const b = await connect(port, 'r1');
    send(b, { type: 'hello', jitsiId: 'jit-b', displayName: 'B' });
    await waitFor(b, m => m.type === 'roster');
    const joined = await waitFor(a, m => m.type === 'peer-join');
    const bPeerId = joined.peer.peerId;

    send(a, { type: 'scss', targetPeerId: bPeerId, source: '.ts-chip { color: green; }' });
    // Nothing should arrive: a's send is silently dropped, b's own record is
    // never touched, so it never emits a compiledCss peer-update either.
    send(b, { type: 'metrics', rtt: 5, jitter: 1 });
    const sentinel = await waitFor(a, m => m.type === 'peer-update' && m.peerId === bPeerId && 'rtt' in m.patch);
    assert.equal(sentinel.patch.rtt, 5);
    assert.ok(
      !a.messages.some(m => m.type === 'peer-update' && m.peerId === bPeerId && m.patch.compiledCss),
      'a human peer must never receive a compiledCss set by another connection'
    );

    a.ws.close(); b.ws.close();
  });
});

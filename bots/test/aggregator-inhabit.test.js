// `# inhabit` in the aggregator: it resolves the map from the applied
// program, reports it to the room over its metaprogram bus, and hears each
// guest in its host's slot on the ring.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

import { AggregatorBot } from '../src/bot/aggregator-bot.js';
import { makeWsSidecarConnector } from '../src/orchestrator/fleet-service.js';
import { createMetaprogramDoc, connectMetaprogramSync } from '../../src/audio-net/MetaprogrammerCrdtSync.js';

const require = createRequire(import.meta.url);
const { createLatencyServer } = require('../../latency-instrument/server.js');

const JP = "'metaprogram editor'\n";
const noBrowser = { launch: async () => { throw new Error('no browser in this test'); } };
const cfg = { botId: 1, name: 'Aggregator', jitsiUrl: 'http://localhost/0', ingestIntervalMs: 0, playbackIntervalMs: 0 };
const round = (xs) => Array.from(xs, (v) => Math.round(v * 1000) / 1000);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a guest is heard in its host\'s slot, and in its own again once it leaves', async () => {
  const bot = new AggregatorBot(cfg, { launcher: noBrowser, logIngest: false }, {}, 1024);
  assert.deepEqual(bot.applyProgramText(`${JP}$ participants <0 1>\n# inhabit 0 1\n`), []);
  assert.deepEqual(bot.getInhabitMap(), { 1: '0' });

  await bot.writeToIndividualParticipantBufferQueues([
    { jitsiId: 'h0', token: '0', samples: [0.25, 0.25] },
    { jitsiId: 'h1', token: '1', samples: [0.5] },
  ]);
  assert.deepEqual(round(bot.buffers['0'].peek()), [0.75, 0.25], 'the guest is mixed into the host');
  assert.equal(bot.buffers['1']?.length ?? 0, 0, 'the guest\'s own slot gets nothing while it is away');

  assert.deepEqual(bot.applyProgramText(`${JP}$ participants <0 1>\n`), []);
  assert.deepEqual(bot.getInhabitMap(), {});
  await bot.writeToIndividualParticipantBufferQueues([{ jitsiId: 'h1', token: '1', samples: [0.5] }]);
  assert.deepEqual(round(bot.buffers['1'].peek()), [0.5], 'back in its own slot');
});

test('a patterned host is resolved per cycle, starting from cycle 0', async () => {
  const bot = new AggregatorBot(cfg, { launcher: noBrowser, logIngest: false }, {}, 1024);
  assert.deepEqual(bot.applyProgramText(`${JP}$ participants <0 1 2>\n# inhabit <2 ~> [0 1]\n`), []);
  assert.deepEqual(bot.getInhabitMap(), { 0: '2', 1: '2' });
});

test('the applied program\'s map reaches the room through the sidecar', { timeout: 20000 }, async () => {
  const { wss } = createLatencyServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const port = wss.address().port;
  const ROOM = 'inhabit-agg';

  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${ROOM}&role=player`);
  const maps = [];
  const listeners = new Set();
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'inhabit') maps.push(msg.map);
    else if (msg.type === 'crdt-update') listeners.forEach((fn) => fn('crdt-update', { update: msg.update, modality: msg.modality }));
    else if (msg.type === 'crdt-state') listeners.forEach((fn) => fn('crdt-state', { updates: msg.updates }));
  });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  ws.send(JSON.stringify({ type: 'hello', jitsiId: 'human-0', displayName: 'human' }));
  const sync = connectMetaprogramSync(createMetaprogramDoc(), {
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    sendUpdate: (update, { snapshot = false, modality = 'keyboard', channel = 'metaprogram' } = {}) =>
      ws.send(JSON.stringify({ type: 'crdt-update', update, snapshot, modality, channel })),
  });

  const bot = new AggregatorBot(
    { botId: 99998, name: 'agg', jitsiUrl: `http://127.0.0.1:${port}/${ROOM}`, ingestIntervalMs: 0, playbackIntervalMs: 0 },
    { launcher: noBrowser, connectSidecar: makeWsSidecarConnector(WebSocket), webSocketImpl: WebSocket, logIngest: false, isActive: () => true },
  );
  try {
    sync.setText(`${JP}$ participants <0 1>\n`, 'roster');
    await sleep(150);
    await bot.interpretAndExecuteMetaprogram();
    await sleep(200);
    sync.setText(`${JP}$ participants <0 1>\n# inhabit 0 [1 0a]\n`, 'apply');
    for (let i = 0; i < 40 && !maps.some((m) => m[1] === '0'); i++) await sleep(50);
    assert.deepEqual(maps.at(-1), { 1: '0', '0a': '0' });

    // A human's own report is now ignored: the aggregator is the authority.
    ws.send(JSON.stringify({ type: 'inhabit', map: {} }));
    await sleep(150);
    assert.deepEqual(maps.at(-1), { 1: '0', '0a': '0' });
  } finally {
    await bot.stop().catch(() => {});
    ws.close();
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
});

test('a guest the host refuses is not heard in the host\'s slot', { timeout: 20000 }, async () => {
  const { wss } = createLatencyServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const port = wss.address().port;
  const ROOM = 'inhabit-agg-refuse';
  const open = async (hello) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${ROOM}&role=player`);
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'hello', ...hello }));
    return ws;
  };
  const host = await open({ jitsiId: 'human-0', permissionsConfig: { allowInhabitFrom: 'none' } }); // 0
  const guest = await open({ jitsiId: 'human-1' });                                                  // 1
  const listeners = new Set();
  host.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.type === 'crdt-update' || msg.type === 'crdt-state') listeners.forEach((fn) => fn(msg.type, msg));
  });
  const sync = connectMetaprogramSync(createMetaprogramDoc(), {
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    sendUpdate: (update, { snapshot = false, modality = 'keyboard', channel = 'metaprogram' } = {}) =>
      host.send(JSON.stringify({ type: 'crdt-update', update, snapshot, modality, channel })),
  });
  const bot = new AggregatorBot(
    { botId: 99997, name: 'agg', jitsiUrl: `http://127.0.0.1:${port}/${ROOM}`, ingestIntervalMs: 0, playbackIntervalMs: 0 },
    { launcher: noBrowser, connectSidecar: makeWsSidecarConnector(WebSocket), webSocketImpl: WebSocket, logIngest: false, isActive: () => true },
  );
  try {
    sync.setText(`${JP}$ participants <0 1>\n# inhabit 0 1\n`, 'roster');
    await sleep(150);
    await bot.interpretAndExecuteMetaprogram();
    await sleep(300);
    assert.deepEqual(bot.getInhabitMap(), {}, 'the sidecar refused the pair, so the bot does not mix it');
    await bot.writeToIndividualParticipantBufferQueues([
      { jitsiId: 'h0', token: '0', samples: [0.25] },
      { jitsiId: 'h1', token: '1', samples: [0.5] },
    ]);
    assert.deepEqual(round(bot.buffers['0'].peek()), [0.25]);
    assert.deepEqual(round(bot.buffers['1'].peek()), [0.5], 'the refused guest stays in its own slot');

    host.send(JSON.stringify({ type: 'permissions-config', config: { allowInhabitFrom: 'all' } }));
    for (let i = 0; i < 40 && !bot.getInhabitMap()[1]; i++) await sleep(50);
    assert.deepEqual(bot.getInhabitMap(), { 1: '0' }, 'allowed again, the pair is back');
  } finally {
    await bot.stop().catch(() => {});
    host.close();
    guest.close();
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
});

// Full metaprogram sync path: real sidecar relay + real Yjs provider (the
// "human" side) + the AggregatorBot's Node-side wiring, over real WebSockets
// — no browser. Covers the apply-gate semantics: typing syncs the shared
// TEXT only; the ring/scheduler adopt a program solely on an explicit apply
// (including the empty-diff apply the editor produces after typing), the
// roster seed, or the late-join catch-up.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

import { AggregatorBot } from '../src/bot/aggregator-bot.js';
import { makeWsSidecarConnector } from '../src/orchestrator/fleet-service.js';
import {
  createMetaprogramDoc,
  connectMetaprogramSync
} from '../../src/audio-net/MetaprogrammerCrdtSync.js';

const require = createRequire(import.meta.url);
const { createLatencyServer } = require('../../latency-instrument/server.js');

const ROOM = 'nc-sync';

// Human browser stand-in: peer-state.js's crdt-update/crdt-state contract
// over a raw ws, feeding the real provider (MetaprogrammerCrdtSync).
function connectHuman(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${ROOM}&role=player`);
    const listeners = new Set();
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'crdt-update' && typeof msg.update === 'string') {
        listeners.forEach(fn => fn('crdt-update', { update: msg.update, authorIndex: msg.authorIndex ?? null, modality: msg.modality }));
      } else if (msg.type === 'crdt-state' && Array.isArray(msg.updates)) {
        listeners.forEach(fn => fn('crdt-state', { updates: msg.updates }));
      }
    });
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'hello', jitsiId: 'human-1', displayName: 'human' }));
      const bus = {
        subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
        sendUpdate: (update, { snapshot = false, modality = 'keyboard', channel = 'metaprogram' } = {}) =>
          ws.send(JSON.stringify({ type: 'crdt-update', update, snapshot, modality, channel }))
      };
      resolve({ ws, sync: connectMetaprogramSync(createMetaprogramDoc(), bus) });
    });
    ws.on('error', reject);
  });
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Type into the shared doc the way the editor does: one setText per
// keystroke (every prefix, invalid intermediates included), modality
// 'keyboard'.
function typeText(sync, text) {
  for (let i = 1; i <= text.length; i++) sync.setText(text.slice(0, i));
}

// The editor's ▶ Apply: setText with the 'apply' origin; when typing already
// synced the exact text the diff is empty, so the RUN signal ships as a
// broadcastApplied snapshot (mirrors Metaprogrammer.applyProgramText).
function applyText(sync, text) {
  const changed = sync.setText(text, 'apply');
  if (!changed) sync.broadcastApplied();
}

test('typing never runs the metaprogram; applies (diff or empty-diff) and catch-up do', { timeout: 30000 }, async () => {
  const { wss } = createLatencyServer({ port: 0 });
  await new Promise(r => wss.once('listening', r));
  const port = wss.address().port;

  const human = await connectHuman(port);

  const bot = new AggregatorBot(
    { botId: 99999, name: 'agg', jitsiUrl: `http://127.0.0.1:${port}/${ROOM}`, ingestIntervalMs: 0, playbackIntervalMs: 0 },
    {
      launcher: { launch: async () => { throw new Error('no browser in this test'); } },
      connectSidecar: makeWsSidecarConnector(WebSocket),
      webSocketImpl: WebSocket,
      logIngest: false,
      isActive: () => true
    }
  );

  try {
    // The roster seed, written before the aggregator exists.
    human.sync.setText('$ participants <0>', 'roster');
    await sleep(150);

    // Aggregator comes up: the crdt-state catch-up adopts the room's program.
    await bot.interpretAndExecuteMetaprogram();
    await sleep(200);
    assert.equal(bot.programText, '$ participants <0>', 'catch-up adopted the seed');
    assert.deepEqual(bot.order.order(), ['0'], 'ring follows the seed');

    // Typing an edit (bots added to the text) syncs the shared doc but must
    // not touch the running program — half-typed programs never run.
    typeText(human.sync, '$ participants <0 0a 0b>');
    await sleep(300);
    assert.equal(bot.metaprogramDoc.getText(), '$ participants <0 0a 0b>', 'text synced per keystroke');
    assert.equal(bot.programText, '$ participants <0>', 'typing did not change the running program');
    assert.deepEqual(bot.order.order(), ['0'], 'typing did not reorder the ring');

    // ▶ Apply after typing: the diff is empty, the snapshot RUN signal lands.
    applyText(human.sync, '$ participants <0 0a 0b>');
    await sleep(300);
    assert.equal(bot.programText, '$ participants <0 0a 0b>', 'empty-diff apply ran the program');
    assert.deepEqual(bot.order.order(), ['0', '0a', '0b'], 'ring adopted the applied order');

    // A third and fourth update keep applying (regression: the program was
    // once observed stuck on the bots-add update in fleets running an image
    // without this sync wiring).
    typeText(human.sync, '$ participants <0b 0>');
    applyText(human.sync, '$ participants <0b 0>');
    await sleep(300);
    assert.equal(bot.programText, '$ participants <0b 0>');
    assert.deepEqual(bot.order.order(), ['0b', '0'], 'third update applied');

    applyText(human.sync, '$ participants <0a>');
    await sleep(300);
    assert.equal(bot.programText, '$ participants <0a>');
    assert.deepEqual(bot.order.order(), ['0a'], 'fourth update applied');
  } finally {
    await bot.stop().catch(() => {});
    human.ws.close();
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
});

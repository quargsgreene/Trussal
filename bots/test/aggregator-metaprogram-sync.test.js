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
import { RingBuffer } from '../src/bot/ring-buffer.js';
import { makeWsSidecarConnector } from '../src/orchestrator/fleet-service.js';
import {
  createMetaprogramDoc,
  connectMetaprogramSync
} from '../../src/audio-net/MetaprogrammerCrdtSync.js';

const require = createRequire(import.meta.url);
const { createLatencyServer } = require('../../latency-instrument/server.js');

const ROOM = 'jp-sync';

// Human browser stand-in: peer-state.js's crdt-update/crdt-state contract
// over a raw ws, feeding the real provider (MetaprogrammerCrdtSync).
function connectHuman(port, onActive) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?room=${ROOM}&role=player`);
    const listeners = new Set();
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'crdt-update' && typeof msg.update === 'string') {
        listeners.forEach(fn => fn('crdt-update', { update: msg.update, authorIndex: msg.authorIndex ?? null, modality: msg.modality }));
      } else if (msg.type === 'crdt-state' && Array.isArray(msg.updates)) {
        listeners.forEach(fn => fn('crdt-state', { updates: msg.updates }));
      } else if (msg.type === 'jp-active' && onActive) {
        onActive(msg);
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

// The metaprogram directive every buffer now opens with (program-directive.js).
// The fixtures below are bodies; mp() gives the full buffer the parser accepts.
const mp = (body) => `'metaprogram editor'\n${body}`;

// Type into the shared doc the way the editor does: one setText per
// keystroke (every prefix, invalid intermediates included), modality
// 'keyboard'.
function typeText(sync, body) {
  const text = mp(body);
  for (let i = 1; i <= text.length; i++) sync.setText(text.slice(0, i));
}

// The editor's ▶ Apply: setText with the 'apply' origin; when typing already
// synced the exact text the diff is empty, so the RUN signal ships as a
// broadcastApplied snapshot (mirrors Metaprogrammer.applyProgramText).
function applyText(sync, body) {
  const changed = sync.setText(mp(body), 'apply');
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
    human.sync.setText(mp('$ participants <0>'), 'roster');
    await sleep(150);

    // Aggregator comes up: the crdt-state catch-up adopts the room's program.
    await bot.interpretAndExecuteMetaprogram();
    await sleep(200);
    assert.equal(bot.programText, mp('$ participants <0>'), 'catch-up adopted the seed');
    assert.deepEqual(bot.order.order(), ['0'], 'ring follows the seed');

    // Typing an edit (bots added to the text) syncs the shared doc but must
    // not touch the running program — half-typed programs never run.
    typeText(human.sync, '$ participants <0 0a 0b>');
    await sleep(300);
    assert.equal(bot.metaprogramDoc.getText(), mp('$ participants <0 0a 0b>'), 'text synced per keystroke');
    assert.equal(bot.programText, mp('$ participants <0>'), 'typing did not change the running program');
    assert.deepEqual(bot.order.order(), ['0'], 'typing did not reorder the ring');

    // ▶ Apply after typing: the diff is empty, the snapshot RUN signal lands.
    applyText(human.sync, '$ participants <0 0a 0b>');
    await sleep(300);
    assert.equal(bot.programText, mp('$ participants <0 0a 0b>'), 'empty-diff apply ran the program');
    assert.deepEqual(bot.order.order(), ['0', '0a', '0b'], 'ring adopted the applied order');

    // A third and fourth update keep applying (regression: the program was
    // once observed stuck on the bots-add update in fleets running an image
    // without this sync wiring).
    typeText(human.sync, '$ participants <0b 0>');
    applyText(human.sync, '$ participants <0b 0>');
    await sleep(300);
    assert.equal(bot.programText, mp('$ participants <0b 0>'));
    assert.deepEqual(bot.order.order(), ['0b', '0'], 'third update applied');

    applyText(human.sync, '$ participants <0a>');
    await sleep(300);
    assert.equal(bot.programText, mp('$ participants <0a>'));
    assert.deepEqual(bot.order.order(), ['0a'], 'fourth update applied');
  } finally {
    await bot.stop().catch(() => {});
    human.ws.close();
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
});

test('a stop broadcast leaves the running program and ring untouched (silencing is presence-gated, not scheduler-driven)', { timeout: 30000 }, async () => {
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
    human.sync.setText(mp('$ participants <0 0a>'), 'roster');
    await sleep(150);
    await bot.interpretAndExecuteMetaprogram();
    await sleep(200);
    assert.equal(bot.programText, mp('$ participants <0 0a>'));
    assert.deepEqual(bot.order.order(), ['0', '0a']);

    // A human's ■ Stop: broadcastStopSignal ships this exact zero-diff
    // snapshot (modality 'stop', text unchanged) — see
    // src/audio-net/Metaprogrammer.js broadcastStopSignal /
    // MetaprogrammerCrdtSync.js broadcastStop. The aggregator's own
    // silencing is presence-gated (each stopped peer's `playing` flag going
    // false, read by page-scripts.js), not something the Node-side scheduler
    // reacts to directly — so this broadcast must be a no-op here.
    human.sync.broadcastStop();
    await sleep(300);
    assert.equal(bot.programText, mp('$ participants <0 0a>'), 'stop did not touch the running program');
    assert.deepEqual(bot.order.order(), ['0', '0a'], 'stop did not touch the ring');
  } finally {
    await bot.stop().catch(() => {});
    human.ws.close();
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
});

test('the Delayed Streaming toggle rides the settings map from a human to the aggregator', { timeout: 30000 }, async () => {
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
    human.sync.setText(mp('$ participants <0>'), 'roster');
    await sleep(150);
    await bot.interpretAndExecuteMetaprogram();
    await sleep(200);
    assert.equal(bot.delayedStreaming, false, 'off until the room asks for it');

    // The Studio button: a settings-map write, not a program edit — the
    // program text and ring are untouched.
    human.sync.setSetting('delayedStreaming', true);
    await sleep(300);
    assert.equal(bot.delayedStreaming, true, 'the aggregator adopted the room-wide toggle');
    assert.equal(bot.programText, mp('$ participants <0>'), 'the toggle did not touch the program');
    assert.deepEqual(bot.order.order(), ['0'], 'nor the ring');

    human.sync.setSetting('delayedStreaming', false);
    await sleep(300);
    assert.equal(bot.delayedStreaming, false, 'and the flip back reaches it too');
  } finally {
    await bot.stop().catch(() => {});
    human.ws.close();
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
});

test('aggregator broadcasts jp-active on each ring turn change; the browser receives it deduped', { timeout: 30000 }, async () => {
  const { wss } = createLatencyServer({ port: 0 });
  await new Promise(r => wss.once('listening', r));
  const port = wss.address().port;

  const ncActive = [];                       // tokens the human stand-in receives
  const human = await connectHuman(port, (m) => ncActive.push(m.token));

  let clock = 0;                             // injected so rotation is deterministic
  const bot = new AggregatorBot(
    { botId: 99999, name: 'agg', jitsiUrl: `http://127.0.0.1:${port}/${ROOM}`, ingestIntervalMs: 0, playbackIntervalMs: 0, slotMs: 4000 },
    {
      launcher: { launch: async () => { throw new Error('no browser in this test'); } },
      connectSidecar: makeWsSidecarConnector(WebSocket),
      webSocketImpl: WebSocket,
      logIngest: false,
      isActive: () => true,
      now: () => clock
    }
  );

  try {
    human.sync.setText(mp('$ participants <0 1>'), 'roster');
    await sleep(150);
    await bot.interpretAndExecuteMetaprogram();   // adopts the seed + connects the bus
    await sleep(200);
    assert.deepEqual(bot.order.order(), ['0', '1'], 'ring follows the seed');

    // Both participants have live audio, so the ring streams each on its turn.
    bot.buffers['0'] = new RingBuffer(1024); bot.buffers['0'].write(new Array(50).fill(0.5));
    bot.buffers['1'] = new RingBuffer(1024); bot.buffers['1'].write(new Array(50).fill(0.25));

    // Turns are paced by the metaprogram's cycle grid, not the config's slotMs,
    // so step the clock by the cycle length the scheduler actually computed. No
    // peer here reports rtt/jitter/loss, so the worst case is all zeros and the
    // cycle sits on its one-beat floor — read it rather than hardcode it.
    const turnMs = bot.scheduler.getCycleLength().seconds * 1000;

    clock = 0;             await bot.readAndAssembleMasterBuffer(); await sleep(80); // turn 0 → send '0'
    clock = turnMs;        await bot.readAndAssembleMasterBuffer(); await sleep(80); // turn 1 → send '1'
    clock = turnMs + 40;   await bot.readAndAssembleMasterBuffer(); await sleep(80); // same turn → deduped
    clock = turnMs * 2;    await bot.readAndAssembleMasterBuffer(); await sleep(80); // wraps → send '0'

    assert.deepEqual(ncActive, ['0', '1', '0'],
      'one jp-active per turn change, no repeat within a turn');

    // A late joiner must learn the CURRENT turn even though the aggregator only
    // emits on change (it won't re-send just for them): the sidecar replays its
    // cached last token on hello.
    const late = [];
    const human2 = await connectHuman(port, (m) => late.push(m.token));
    await sleep(150);
    assert.deepEqual(late, ['0'], 'late joiner gets the cached active token on hello');
    human2.ws.close();
  } finally {
    await bot.stop().catch(() => {});
    human.ws.close();
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
});

test('jp-active re-announces the current turn on the heartbeat even when unchanged', { timeout: 30000 }, async () => {
  const { wss } = createLatencyServer({ port: 0 });
  await new Promise(r => wss.once('listening', r));
  const port = wss.address().port;

  const ncActive = [];
  const human = await connectHuman(port, (m) => ncActive.push(m.token));

  const bot = new AggregatorBot(
    // Huge slotMs so the single participant never rotates — the token stays '0'.
    { botId: 99999, name: 'agg', jitsiUrl: `http://127.0.0.1:${port}/${ROOM}`, ingestIntervalMs: 0, playbackIntervalMs: 0, slotMs: 1e9 },
    {
      launcher: { launch: async () => { throw new Error('no browser in this test'); } },
      connectSidecar: makeWsSidecarConnector(WebSocket),
      webSocketImpl: WebSocket,
      logIngest: false,
      isActive: () => true
    }
  );

  try {
    human.sync.setText(mp('$ participants <0>'), 'roster');
    await sleep(150);
    await bot.interpretAndExecuteMetaprogram();
    await sleep(200);
    bot.buffers['0'] = new RingBuffer(1024); bot.buffers['0'].write(new Array(50).fill(0.5));

    await bot.readAndAssembleMasterBuffer(); await sleep(80); // sends '0' (change)
    await bot.readAndAssembleMasterBuffer(); await sleep(80); // deduped within the window
    assert.deepEqual(ncActive, ['0'], 'unchanged token is not re-sent within the heartbeat window');

    await sleep(2100);                                        // past NC_ACTIVE_HEARTBEAT_MS
    await bot.readAndAssembleMasterBuffer(); await sleep(80);
    assert.deepEqual(ncActive, ['0', '0'], 'the same token is re-announced after the heartbeat interval');
  } finally {
    await bot.stop().catch(() => {});
    human.ws.close();
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
});

test('jp-active carries the ring index so a repeated token is disambiguated', { timeout: 30000 }, async () => {
  const { wss } = createLatencyServer({ port: 0 });
  await new Promise(r => wss.once('listening', r));
  const port = wss.address().port;

  const got = [];
  const human = await connectHuman(port, (m) => got.push({ token: m.token, index: m.index }));

  let clock = 0;
  const bot = new AggregatorBot(
    { botId: 99999, name: 'agg', jitsiUrl: `http://127.0.0.1:${port}/${ROOM}`, ingestIntervalMs: 0, playbackIntervalMs: 0, slotMs: 4000 },
    {
      launcher: { launch: async () => { throw new Error('no browser in this test'); } },
      connectSidecar: makeWsSidecarConnector(WebSocket),
      webSocketImpl: WebSocket,
      logIngest: false,
      isActive: () => true,
      now: () => clock
    }
  );

  try {
    // `0` appears twice — a browser that keyed only on the token would jump back
    // to the first `0` at slot 2; the index (0,1,2) pins the exact occurrence.
    human.sync.setText(mp('$ participants <0 1 0>'), 'roster');
    await sleep(150);
    await bot.interpretAndExecuteMetaprogram();
    await sleep(200);
    assert.deepEqual(bot.order.order(), ['0', '1', '0'], 'ring keeps both occurrences of 0');
    bot.buffers['0'] = new RingBuffer(1024); bot.buffers['0'].write(new Array(50).fill(0.5));
    bot.buffers['1'] = new RingBuffer(1024); bot.buffers['1'].write(new Array(50).fill(0.25));

    const turnMs = bot.scheduler.getCycleLength().seconds * 1000;
    clock = 0;          await bot.readAndAssembleMasterBuffer(); await sleep(80);
    clock = turnMs;     await bot.readAndAssembleMasterBuffer(); await sleep(80);
    clock = turnMs * 2; await bot.readAndAssembleMasterBuffer(); await sleep(80);

    assert.deepEqual(got, [
      { token: '0', index: 0 },
      { token: '1', index: 1 },
      { token: '0', index: 2 },
    ], 'each turn carries its written-sequence index, so the repeated 0 is distinguishable');
  } finally {
    await bot.stop().catch(() => {});
    human.ws.close();
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
});

test('a rest reaches the browser as a rest, addressing the written `~`', { timeout: 30000 }, async () => {
  const { wss } = createLatencyServer({ port: 0 });
  await new Promise(r => wss.once('listening', r));
  const port = wss.address().port;

  const got = [];
  const human = await connectHuman(port, (m) => got.push({ token: m.token, index: m.index, kind: m.kind }));

  let clock = 0;
  const bot = new AggregatorBot(
    { botId: 99999, name: 'agg', jitsiUrl: `http://127.0.0.1:${port}/${ROOM}`, ingestIntervalMs: 0, playbackIntervalMs: 0, slotMs: 4000 },
    {
      launcher: { launch: async () => { throw new Error('no browser in this test'); } },
      connectSidecar: makeWsSidecarConnector(WebSocket),
      webSocketImpl: WebSocket,
      logIngest: false,
      isActive: () => true,
      now: () => clock
    }
  );

  try {
    // Two rests, so the browser needs the index to know WHICH one is resting —
    // the rests are numbered in their own space, independent of `0` and `1`.
    human.sync.setText(mp('$ participants <0 ~ 1 ~>'), 'roster');
    await sleep(150);
    await bot.interpretAndExecuteMetaprogram();
    await sleep(200);
    bot.buffers['0'] = new RingBuffer(1024); bot.buffers['0'].write(new Array(50).fill(0.5));
    bot.buffers['1'] = new RingBuffer(1024); bot.buffers['1'].write(new Array(50).fill(0.25));

    const turnMs = bot.scheduler.getCycleLength().seconds * 1000;
    for (let cycle = 0; cycle < 4; cycle++) {
      clock = turnMs * cycle;
      await bot.readAndAssembleMasterBuffer();
      await sleep(80);
    }

    assert.deepEqual(got, [
      { token: '0', index: 0, kind: null },
      { token: null, index: 0, kind: 'rest' },
      { token: '1', index: 1, kind: null },
      { token: null, index: 1, kind: 'rest' },
    ], 'played turns name their participant; rests name which `~` is resting');
  } finally {
    await bot.stop().catch(() => {});
    human.ws.close();
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
});

test('a joiner landing mid-rest is told the room is resting', { timeout: 30000 }, async () => {
  const { wss } = createLatencyServer({ port: 0 });
  await new Promise(r => wss.once('listening', r));
  const port = wss.address().port;

  // The aggregator broadcasts only on change, so the sidecar caches the last
  // turn and replays it on hello. A rest carries no token, so a cache keyed on
  // "token present" would leave a mid-rest joiner with no outline at all.
  const first = await connectHuman(port, () => {});

  let clock = 0;
  const bot = new AggregatorBot(
    { botId: 99999, name: 'agg', jitsiUrl: `http://127.0.0.1:${port}/${ROOM}`, ingestIntervalMs: 0, playbackIntervalMs: 0, slotMs: 4000 },
    {
      launcher: { launch: async () => { throw new Error('no browser in this test'); } },
      connectSidecar: makeWsSidecarConnector(WebSocket),
      webSocketImpl: WebSocket,
      logIngest: false,
      isActive: () => true,
      now: () => clock
    }
  );

  try {
    first.sync.setText(mp('$ participants <0 ~>'), 'roster');
    await sleep(150);
    await bot.interpretAndExecuteMetaprogram();
    await sleep(200);
    bot.buffers['0'] = new RingBuffer(1024); bot.buffers['0'].write(new Array(50).fill(0.5));

    const turnMs = bot.scheduler.getCycleLength().seconds * 1000;
    clock = 0;       await bot.readAndAssembleMasterBuffer(); await sleep(80);
    clock = turnMs;  await bot.readAndAssembleMasterBuffer(); await sleep(80);  // resting now

    const replayed = [];
    const late = await connectHuman(port, (m) => replayed.push({ token: m.token, index: m.index, kind: m.kind }));
    await sleep(200);
    assert.deepEqual(replayed, [{ token: null, index: 0, kind: 'rest' }],
      'the catch-up says "resting at the first ~", not "no turn"');
    late.ws.close();
  } finally {
    await bot.stop().catch(() => {});
    first.ws.close();
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
});

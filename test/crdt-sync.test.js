// CRDT metaprogram doc: convergence of concurrent edits (pure Yjs, fake
// bus) and the sidecar relay integration incl. bot permission gating.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import WebSocket from 'ws';

import {
  createMetaprogramDoc,
  connectMetaprogramSync,
  applyTextDiff,
  encodeUpdateB64,
  applyRemoteUpdate,
  encodeFullState
} from '../src/audio-net/MetaprogrammerCrdtSync.js';

const require = createRequire(import.meta.url);
const { createLatencyServer } = require('../latency-instrument/server.js');

// btoa/atob exist in Node >= 16 as globals.

// --- Pure convergence ---------------------------------------------------------

function fakeBusPair() {
  // Two buses cross-wired in memory.
  const subsA = new Set(), subsB = new Set();
  const busA = {
    subscribe: (fn) => { subsA.add(fn); return () => subsA.delete(fn); },
    sendUpdate: (update, opts) => subsB.forEach(fn => fn('crdt-update', { update, ...opts }))
  };
  const busB = {
    subscribe: (fn) => { subsB.add(fn); return () => subsB.delete(fn); },
    sendUpdate: (update, opts) => subsA.forEach(fn => fn('crdt-update', { update, ...opts }))
  };
  return [busA, busB];
}

test('two docs with concurrent divergent edits converge to identical text', () => {
  const a = createMetaprogramDoc();
  const b = createMetaprogramDoc();
  // Seed both with the same base through an initial exchange.
  applyTextDiff(a.text, '$ participants <0 1>\n# cycles wcl\n');
  applyRemoteUpdate(b.doc, encodeFullState(a.doc));

  // Now connect them through fake buses and edit concurrently at both ends.
  const [busA, busB] = fakeBusPair();
  const syncA = connectMetaprogramSync(a, busA);
  const syncB = connectMetaprogramSync(b, busB);

  // A edits the tempo line while B appends a directive — both offline-style
  // "simultaneous" (each keystroke relays immediately here, but the edits
  // target different regions and interleave).
  syncA.setText(syncA.getText() + '# tempo 90 bpm\n');
  syncB.setText(syncB.getText().replace('<0 1>', '<0 1 2>'));

  assert.equal(syncA.getText(), syncB.getText());
  assert.match(syncA.getText(), /<0 1 2>/);
  assert.match(syncA.getText(), /# tempo 90 bpm/);
  syncA.disconnect(); syncB.disconnect();
});

test('apply/roster origins ride the wire as their modality; typing stays keyboard; empty-diff apply broadcasts a snapshot', () => {
  const a = createMetaprogramDoc();
  const sent = [];
  const bus = {
    subscribe: () => () => {},
    sendUpdate: (update, opts) => sent.push({ update, ...opts })
  };
  const sync = connectMetaprogramSync(a, bus);

  sync.setText('$ participants <0>');                    // typing
  sync.setText('$ participants <0 1>', 'apply');          // explicit apply (real diff)
  sync.setText('$ participants <0 1>\n# room 2', 'roster'); // roster seed style write
  assert.deepEqual(sent.map(s => s.modality), ['keyboard', 'apply', 'roster']);
  assert.ok(sent.every(s => s.channel === 'metaprogram'));

  // Apply with no text change (typing already synced it): setText no-ops,
  // broadcastApplied still ships the RUN signal as a full-state snapshot.
  assert.equal(sync.setText(sync.getText(), 'apply'), false);
  assert.equal(sent.length, 3, 'no-op diff sends nothing by itself');
  sync.broadcastApplied();
  assert.equal(sent.length, 4);
  assert.equal(sent[3].modality, 'apply');
  assert.equal(sent[3].snapshot, true);
  // The snapshot reconstructs the full doc for a receiver.
  const b = createMetaprogramDoc();
  applyRemoteUpdate(b.doc, sent[3].update);
  assert.equal(b.text.toString(), sync.getText());
  sync.disconnect();
});

test('settings map: setSetting rides the metaprogram channel as a keyboard edit, converges, and notifies', () => {
  const a = createMetaprogramDoc();
  const sent = [];
  const bus = {
    subscribe: () => () => {},
    sendUpdate: (update, opts) => sent.push({ update, ...opts })
  };
  const sync = connectMetaprogramSync(a, bus);

  // A room-wide toggle is neither program text nor a network floor: it must
  // NOT stamp modality 'apply'/'roster' (no receiver should re-run the
  // program) and must NOT ride the 'modulation' channel (not gated by
  // canWriteModulation).
  sync.setSetting('delayedStreaming', true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].modality, 'keyboard');
  assert.equal(sent[0].channel, 'metaprogram');
  assert.deepEqual(sync.getSettings(), { delayedStreaming: true });
  assert.equal(sync.getText(), '', 'a settings write leaves the program text untouched');

  sync.disconnect();
});

test('settings map: two docs converge on a toggle and onSettingsChange fires on both ends', () => {
  const a = createMetaprogramDoc();
  const b = createMetaprogramDoc();
  const [busA, busB] = fakeBusPair();
  const syncA = connectMetaprogramSync(a, busA);
  const syncB = connectMetaprogramSync(b, busB);

  const seenA = [];
  const seenB = [];
  syncA.onSettingsChange((s) => seenA.push(!!s.delayedStreaming));
  syncB.onSettingsChange((s) => seenB.push(!!s.delayedStreaming));

  syncB.setSetting('delayedStreaming', true);   // remote peer flips it on
  assert.equal(syncA.getSettings().delayedStreaming, true, 'the flip reaches the other doc');
  assert.deepEqual(seenB, [true], 'the flipping peer is notified of its own change');
  assert.deepEqual(seenA, [true], 'the other peer is notified of the remote change');

  syncA.setSetting('delayedStreaming', false);  // and back off from the other end
  assert.equal(syncB.getSettings().delayedStreaming, false);
  assert.deepEqual(seenA, [true, false]);
  assert.deepEqual(seenB, [true, false]);

  syncA.disconnect(); syncB.disconnect();
});

test('broadcastStop ships a zero-diff snapshot stamped stop, leaving the text unchanged', () => {
  const a = createMetaprogramDoc();
  const sent = [];
  const bus = {
    subscribe: () => () => {},
    sendUpdate: (update, opts) => sent.push({ update, ...opts })
  };
  const sync = connectMetaprogramSync(a, bus);

  sync.setText('$ participants <0 1>', 'apply');
  assert.equal(sent.length, 1);
  const before = sync.getText();

  sync.broadcastStop();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].modality, 'stop');
  assert.equal(sent[1].snapshot, true);
  assert.equal(sent[1].channel, 'metaprogram');
  // No text mutation — a receiver merging this snapshot ends up with the
  // exact same program, ready for the next Apply to resume unchanged.
  assert.equal(sync.getText(), before);

  const b = createMetaprogramDoc();
  applyRemoteUpdate(b.doc, sent[1].update);
  assert.equal(b.text.toString(), before);
  sync.disconnect();
});

test('applyTextDiff produces minimal edits and no-ops on identical text', () => {
  const { text } = createMetaprogramDoc();
  assert.equal(applyTextDiff(text, 'hello world'), true);
  assert.equal(applyTextDiff(text, 'hello world'), false);
  applyTextDiff(text, 'hello brave world');
  assert.equal(text.toString(), 'hello brave world');
  applyTextDiff(text, 'hello world');
  assert.equal(text.toString(), 'hello world');
  applyTextDiff(text, '');
  assert.equal(text.toString(), '');
});

// --- Sidecar relay integration ---------------------------------------------------

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
  return (await waitFor(client, m => m.type === 'roster')).you;
}
function send(client, msg) { client.ws.send(JSON.stringify(msg)); }

async function withServer(fn) {
  const { wss } = createLatencyServer({ port: 0 });
  await new Promise(r => wss.once('listening', r));
  try { await fn(wss.address().port); }
  finally { wss.close(); for (const c of wss.clients) c.terminate(); }
}

test('edits from A appear at B; a late joiner receives the full doc history', async () => {
  await withServer(async (port) => {
    const a = await connect(port, 'crdt1');
    await hello(a, { jitsiId: 'ja' });
    const b = await connect(port, 'crdt1');
    await hello(b, { jitsiId: 'jb' });

    // Real Yjs payloads through the real relay.
    const docA = createMetaprogramDoc();
    let pendingUpdate = null;
    docA.doc.on('update', (u) => { pendingUpdate = encodeUpdateB64(u); });
    applyTextDiff(docA.text, '$ participants <0 1>\n');
    send(a, { type: 'crdt-update', update: pendingUpdate, modality: 'keyboard' });

    const got = await waitFor(b, m => m.type === 'crdt-update');
    assert.equal(got.authorIndex, '0');
    assert.equal(got.modality, 'keyboard');
    const docB = createMetaprogramDoc();
    applyRemoteUpdate(docB.doc, got.update);
    assert.equal(docB.text.toString(), '$ participants <0 1>\n');

    // Second edit, then a late joiner must be able to rebuild the whole doc.
    applyTextDiff(docA.text, '$ participants <0 1>\n# cycles wcpl\n');
    send(a, { type: 'crdt-update', update: pendingUpdate });
    send(a, { type: 'ping', sentAt: Date.now() });
    await waitFor(a, m => m.type === 'pong');

    const late = await connect(port, 'crdt1');
    late.ws.send(JSON.stringify({ type: 'hello', jitsiId: 'jl', displayName: 'late' }));
    const state = await waitFor(late, m => m.type === 'crdt-state');
    assert.equal(state.updates.length, 2);
    const docL = createMetaprogramDoc();
    for (const u of state.updates) applyRemoteUpdate(docL.doc, u);
    assert.equal(docL.text.toString(), '$ participants <0 1>\n# cycles wcpl\n');

    a.ws.close(); b.ws.close(); late.ws.close();
  });
});

test('a snapshot subsumes the log; read-only bot updates are dropped', async () => {
  await withServer(async (port) => {
    const a = await connect(port, 'crdt2');
    await hello(a, { jitsiId: 'ja' });
    const doc = createMetaprogramDoc();
    let lastUpdate = null;
    doc.doc.on('update', (u) => { lastUpdate = encodeUpdateB64(u); });
    applyTextDiff(doc.text, 'v1');
    send(a, { type: 'crdt-update', update: lastUpdate });
    applyTextDiff(doc.text, 'v1 v2');
    send(a, { type: 'crdt-update', update: lastUpdate });
    // Snapshot replaces both entries with one.
    send(a, { type: 'crdt-update', update: encodeFullState(doc.doc), snapshot: true });
    send(a, { type: 'ping', sentAt: Date.now() });
    await waitFor(a, m => m.type === 'pong');

    const late = await connect(port, 'crdt2');
    late.ws.send(JSON.stringify({ type: 'hello', jitsiId: 'jl', displayName: 'late' }));
    const state = await waitFor(late, m => m.type === 'crdt-state');
    assert.equal(state.updates.length, 1, 'snapshot subsumed the log');

    // Bot without edit permission: its update must reach nobody.
    const bot = await connect(port, 'crdt2');
    await hello(bot, { jitsiId: 'jbot', isBot: true, ownerIndex: '0' });
    send(bot, { type: 'crdt-update', update: encodeFullState(doc.doc) });
    send(bot, { type: 'ping', sentAt: Date.now() });
    await waitFor(bot, m => m.type === 'pong');
    assert.ok(!a.messages.some(m => m.type === 'crdt-update'), 'bot edit dropped');

    // Grant edit; now it relays.
    const botJoin = a.messages.find(m => m.type === 'peer-join' && m.peer.isBot);
    send(a, { type: 'bot-permission', targetPeerId: botJoin.peer.peerId, canEditMetaprogram: true });
    await waitFor(a, m => m.type === 'peer-update' && m.patch.canEditMetaprogram === true);
    send(bot, { type: 'crdt-update', update: encodeFullState(doc.doc), modality: 'bot' });
    const relayed = await waitFor(a, m => m.type === 'crdt-update');
    assert.equal(relayed.authorIndex, '0a');
    assert.equal(relayed.modality, 'bot');

    a.ws.close(); late.ws.close(); bot.ws.close();
  });
});

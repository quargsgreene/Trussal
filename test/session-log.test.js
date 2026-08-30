// Research session log: the sidecar appends one JSONL file per room-session
// covering joins/leaves, metrics, CRDT edits, and client research events. The
// standalone CSV roller (research/export.js) was removed in c684814, so this
// test parses the JSONL stream directly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import WebSocket from 'ws';

const require = createRequire(import.meta.url);
const { createLatencyServer } = require('../latency-instrument/server.js');

// One JSON object per line; a torn final line (partial write) is skipped.
function jsonlToRows(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* torn tail line */ }
  }
  return rows;
}

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
function send(c, m) { c.ws.send(JSON.stringify(m)); }
async function settled(c) { send(c, { type: 'ping', sentAt: Date.now() }); await waitFor(c, m => m.type === 'pong'); }

test('one JSONL file per session captures the event stream in server order', async () => {
  const logDir = mkdtempSync(join(tmpdir(), 'jp-session-'));
  const { wss } = createLatencyServer({ port: 0, logDir });
  await new Promise(r => wss.once('listening', r));
  const port = wss.address().port;
  try {
    const a = await connect(port, 'log1');
    send(a, { type: 'hello', jitsiId: 'ja', displayName: 'A' });
    await waitFor(a, m => m.type === 'roster');
    send(a, { type: 'metrics', rtt: 40, jitter: 2, packetLoss: 0.1, rtcRtt: 55 });
    send(a, { type: 'crdt-update', update: 'AAA=', modality: 'head-cursor' });
    send(a, { type: 'research-event', kind: 'cycle-start', data: { cycle: 4, seconds: 2.5, beats: 5 } });
    send(a, { type: 'fleet-request', action: 'spawn', count: 2 });
    await settled(a);
    await new Promise(r => { a.ws.on('close', r); a.ws.close(); });
    // Give the close handler a beat to write peer-leave.
    await new Promise(r => setTimeout(r, 50));

    const files = readdirSync(logDir).filter(f => f.endsWith('.jsonl'));
    assert.equal(files.length, 1, 'one file per session');
    const rows = jsonlToRows(readFileSync(join(logDir, files[0]), 'utf8'));
    const types = rows.map(r => r.type);
    for (const expected of ['peer-join', 'metrics', 'crdt-update', 'research-event', 'fleet-request', 'peer-leave']) {
      assert.ok(types.includes(expected), `log contains ${expected}`);
    }
    // One session id throughout; server-side timestamps are monotone.
    assert.equal(new Set(rows.map(r => r.session)).size, 1);
    for (let i = 1; i < rows.length; i++) assert.ok(rows[i].ts >= rows[i - 1].ts);

    const crdt = rows.find(r => r.type === 'crdt-update');
    assert.equal(crdt.authorIndex, '0');
    assert.equal(crdt.modality, 'head-cursor');
    assert.equal(crdt.updateBytes, 4);
    const research = rows.find(r => r.type === 'research-event');
    assert.equal(research.kind, 'cycle-start');
    assert.equal(research.data.beats, 5);
    const metrics = rows.find(r => r.type === 'metrics');
    assert.equal(metrics.packetLoss, 0.1);
  } finally {
    wss.close();
    for (const c of wss.clients) c.terminate();
  }
});

// MCP agent: queue ordering, instrument validation, theory utils, and a
// stdio round-trip against the real server (hand-rolled JSON-RPC client,
// same transport mcp-observer uses).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { UpdateQueues } from '../src/mcp-agent/queues.js';
import { loadInstrumentDefs, validateInstruments, extractInstrumentNames } from '../src/mcp-agent/validate.js';
import { scaleNotes, chordProgression, progressionToPattern } from '../src/mcp-agent/tools/theory_utils.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

// --- Queues -------------------------------------------------------------------

test('updates apply FIFO per target and never cross-contaminate', () => {
  const q = new UpdateQueues();
  q.enqueue('1a', 'first');
  q.enqueue('1b', 'other-bot');
  q.enqueue('1a', 'second');
  q.enqueue('metaprogram', '$ participants <0>');
  assert.equal(q.depth('1a'), 2);
  assert.equal(q.drain('1a').code, 'first');
  assert.equal(q.drain('1a').code, 'second');
  assert.equal(q.drain('1a'), null);
  assert.equal(q.drain('1b').code, 'other-bot');
  assert.deepEqual(q.targets(), ['metaprogram']);
});

test('queue depth is bounded — oldest updates fall off', () => {
  const q = new UpdateQueues({ maxPerTarget: 2 });
  q.enqueue('1a', 'v1');
  q.enqueue('1a', 'v2');
  q.enqueue('1a', 'v3');
  assert.equal(q.depth('1a'), 2);
  assert.equal(q.drain('1a').code, 'v2');
});

// --- Instrument validation --------------------------------------------------------

test('accept piano, reject random_noise (plan example)', () => {
  const defs = loadInstrumentDefs();
  assert.equal(validateInstruments('s("piano")', defs).ok, true);
  const bad = validateInstruments('s("random_noise")', defs);
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unknown, ['random_noise']);
});

test('mini-notation inside s("…") is tolerated; gm_ prefix allowed', () => {
  const defs = loadInstrumentDefs();
  const names = extractInstrumentNames('n("0 1").s("bd sd, hh*4 <casio jazz:2>").sound(`gm_lead_6_voice`)');
  assert.deepEqual(names.sort(), ['bd', 'casio', 'gm_lead_6_voice', 'hh', 'jazz', 'sd']);
  assert.equal(validateInstruments('s("bd ~ <sd cp>*2")', defs).ok, true);
  assert.equal(validateInstruments('note("c3").s("gm_acoustic_bass")', defs).ok, true);
  assert.equal(validateInstruments('s("0 1 2")', defs).ok, true, 'numeric tokens are not instrument names');
  assert.equal(validateInstruments('note("c e g")', defs).ok, true, 'no s() call → nothing to validate');
});

// --- Theory utils --------------------------------------------------------------------

test('scales and progressions', () => {
  assert.deepEqual(scaleNotes('g', 'minor', 4), ['g4', 'a4', 'a#4', 'c5', 'd5', 'd#5', 'f5']);
  assert.deepEqual(scaleNotes('c', 'major', 3).slice(0, 3), ['c3', 'd3', 'e3']);
  assert.throws(() => scaleNotes('h', 'major'), RangeError);
  assert.throws(() => scaleNotes('c', 'klingon'), RangeError);

  const prog = chordProgression('a', 'minor', ['i', 'VI', 'III', 'VII']);
  assert.equal(prog.length, 4);
  assert.deepEqual(prog[0], ['a4', 'c5', 'e5']); // a minor triad
  const pattern = progressionToPattern('a', 'minor', ['i', 'VI']);
  assert.match(pattern, /^<\[a4,c5,e5\] \[.+\]>$/);
});

// --- stdio round-trip --------------------------------------------------------------------

function rpcClient(child) {
  let buffer = '';
  const pending = new Map();
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch { /* partial line */ }
    }
  });
  let nextId = 1;
  return (method, params) => new Promise((resolve, reject) => {
    const id = nextId++;
    const t = setTimeout(() => reject(new Error(`rpc timeout: ${method}`)), 8000);
    pending.set(id, (msg) => { clearTimeout(t); resolve(msg); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

test('MCP stdio round-trip: list tools, compose valid + invalid patterns, inspect queue', async () => {
  const child = spawn(process.execPath, [join(repoRoot, 'src/mcp-agent/server.js')], {
    env: { ...process.env, SIDECAR_WS_URL: '' }, // queue-only: no sockets in tests
    stdio: ['pipe', 'pipe', 'pipe']
  });
  try {
    const rpc = rpcClient(child);
    const init = await rpc('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '0' }
    });
    assert.equal(init.result.serverInfo.name, 'trussal-mcp-agent');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

    const tools = await rpc('tools/list', {});
    const names = tools.result.tools.map(t => t.name);
    for (const expected of ['compose_pattern', 'get_update_queue', 'list_targets', 'theory_scale', 'theory_progression']) {
      assert.ok(names.includes(expected), `tool ${expected}`);
    }

    const ok = await rpc('tools/call', {
      name: 'compose_pattern',
      arguments: { target: '1a', code: 's("bd sd hh*2")', note: 'test beat' }
    });
    const okBody = JSON.parse(ok.result.content[0].text);
    assert.equal(okBody.queued, true);
    assert.equal(okBody.target, '1a');

    const bad = await rpc('tools/call', {
      name: 'compose_pattern',
      arguments: { target: '1a', code: 's("random_noise")' }
    });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /unknown instruments: random_noise/);

    const badMeta = await rpc('tools/call', {
      name: 'compose_pattern',
      arguments: { target: 'metaprogram', code: '# cycles wcl\n# cycles wcj\n' }
    });
    assert.equal(badMeta.result.isError, true);
    assert.match(badMeta.result.content[0].text, /invalid NetCycles program/);

    const goodMeta = await rpc('tools/call', {
      name: 'compose_pattern',
      arguments: { target: 'metaprogram', code: '$ participants <0 1a>\n# cycles wcj 2\n' }
    });
    assert.equal(JSON.parse(goodMeta.result.content[0].text).queued, true);

    const queue = await rpc('tools/call', { name: 'get_update_queue', arguments: { target: '1a' } });
    const entries = JSON.parse(queue.result.content[0].text);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].code, 's("bd sd hh*2")');
    assert.equal(entries[0].note, 'test beat');

    const scale = await rpc('tools/call', { name: 'theory_scale', arguments: { root: 'g', mode: 'minor' } });
    assert.deepEqual(JSON.parse(scale.result.content[0].text).notes[0], 'g4');
  } finally {
    child.kill();
  }
});

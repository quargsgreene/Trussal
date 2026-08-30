#!/usr/bin/env node
// ARCHIVED 2026-08-29 — the whole `src/mcp-agent/` package (this server, its
// queues/validate/theory_utils helpers and instrument_defs) was moved out when
// the MCP Cycles feature was removed. It was a standalone MCP server started by
// an external LLM client (`claude mcp add`), never imported by the bundle, the
// sidecar or the bots. Removed alongside it: the root package.json `pretest`
// hook (`npm --prefix src/mcp-agent install`), `test/mcp-agent.test.js`, and the
// architecture-diagram references in src/features/netcycles.md + CLAUDE.md.
// Revive by moving the directory back and restoring the `pretest` hook.
//
// MCP server exposing Strudel control to Claude.
//
// Tools compose/update patterns for a target bot (cluster index like '1a')
// or the shared metaprogram. Every update goes through the instrument
// whitelist (instrument_defs.json — defaults to what strudel.js actually
// prebakes) and, for the metaprogram, the NetCycles parser; valid updates
// land in per-target ordered queues (queues.js) that the delivery worker
// drains FIFO over the sidecar:
//   - bot targets ride the existing remote-control path (the sidecar only
//     ever applies these to bots — humans can't be driven);
//   - 'metaprogram' rides /nc/apply on the O2 relay, landing at every
//     client's next cycle boundary.
//
// Run: node server.js   (stdio transport; configure via env or .env)
//   SIDECAR_WS_URL  ws://localhost:8081/ws   (empty → queue-only, no delivery)
//   O2_WS_URL       ws://localhost:8082/o2
//   ROOM            0
//   DRAIN_MS        3000

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), '.env') });

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import { UpdateQueues } from './queues.js';
import { loadInstrumentDefs, validateInstruments } from './validate.js';
import { scaleNotes, chordProgression, progressionToPattern, SCALE_INTERVALS } from './tools/theory_utils.js';
import { parseMetaprogram } from '../audio-net/MetaprogrammerParser.js';

const require = createRequire(import.meta.url);

const SIDECAR_WS_URL = process.env.SIDECAR_WS_URL ?? '';
const O2_WS_URL = process.env.O2_WS_URL || 'ws://localhost:8082/o2';
const ROOM = process.env.ROOM || '0';
const DRAIN_MS = Number(process.env.DRAIN_MS || 3000);

const defs = loadInstrumentDefs(process.env.INSTRUMENT_DEFS || undefined);
const queues = new UpdateQueues();

const log = (...args) => console.error('[mcp-agent]', ...args);

// ─── Delivery worker (optional — needs ws + a reachable sidecar) ────────────

const roster = new Map(); // peerId → peer
let sidecarWs = null;

function startDelivery() {
  if (!SIDECAR_WS_URL) { log('no SIDECAR_WS_URL — queue-only mode'); return; }
  const WebSocket = require('ws');

  const connect = () => {
    sidecarWs = new WebSocket(`${SIDECAR_WS_URL}?room=${encodeURIComponent(ROOM)}&role=observer`);
    sidecarWs.on('open', () => {
      sidecarWs.send(JSON.stringify({ type: 'hello', jitsiId: '_mcp_agent', displayName: '[MCP Agent]' }));
    });
    sidecarWs.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === 'roster') for (const p of msg.peers) roster.set(p.peerId, p);
      else if (msg.type === 'peer-join') roster.set(msg.peer.peerId, msg.peer);
      else if (msg.type === 'peer-leave') roster.delete(msg.peerId);
      else if (msg.type === 'peer-update') Object.assign(roster.get(msg.peerId) || {}, msg.patch);
    });
    sidecarWs.on('close', () => setTimeout(connect, 3000));
    sidecarWs.on('error', () => { try { sidecarWs.close(); } catch {} });
  };
  connect();

  setInterval(drainOnce, DRAIN_MS).unref();
}

function botPeerForIndex(index) {
  for (const p of roster.values()) {
    if (p.isBot && String(p.roomIndex) === index) return p;
  }
  return null;
}

async function sendMetaprogramApply(text) {
  const WebSocket = require('ws');
  const { serializeMessage } = require('../../latency-instrument/o2lite-format.js');
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`${O2_WS_URL}?room=${encodeURIComponent(ROOM)}`);
    ws.on('open', () => {
      ws.send(serializeMessage({ address: '/nc/apply', typespec: ',s', args: [text] }));
      ws.close();
      resolve();
    });
    ws.on('error', reject);
  });
}

function drainOnce() {
  for (const target of queues.targets()) {
    if (target === 'metaprogram') {
      const entry = queues.drain(target);
      if (entry) sendMetaprogramApply(entry.code).catch(e => log('metaprogram delivery failed:', e.message));
      continue;
    }
    const peer = botPeerForIndex(target);
    if (!peer) continue; // bot not (yet) in the room — keep the queue
    const entry = queues.drain(target);
    if (entry && sidecarWs && sidecarWs.readyState === 1) {
      sidecarWs.send(JSON.stringify({
        type: 'remote-control',
        targetPeerId: peer.peerId,
        action: 'pattern',
        code: entry.code
      }));
      log(`delivered update seq ${entry.seq} → bot ${target}`);
    }
  }
}

// ─── Tools ───────────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'compose_pattern',
    description: "Queue a Strudel pattern update for a target bot (cluster index like '1a') or 'metaprogram' (the shared Net Cycles program). Instruments are validated against the loaded whitelist; metaprogram text is validated with the NetCycles parser. Updates apply in queue order at the target's next opportunity.",
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', description: "bot cluster index ('1a') or 'metaprogram'" },
        code: { type: 'string', description: 'Strudel pattern code, or NetCycles program text for the metaprogram target' },
        note: { type: 'string', description: 'optional annotation for the queue inspector' }
      },
      required: ['target', 'code']
    }
  },
  {
    name: 'get_update_queue',
    description: 'Inspect the pending update queue for a target (FIFO order).',
    inputSchema: {
      type: 'object',
      properties: { target: { type: 'string' } },
      required: ['target']
    }
  },
  {
    name: 'list_targets',
    description: "List controllable targets: every bot currently in the room (with cluster index and owner) plus 'metaprogram'.",
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'list_instruments',
    description: 'The instrument whitelist AI patterns must draw from.',
    inputSchema: { type: 'object', properties: {} }
  },
  {
    name: 'theory_scale',
    description: 'Notes of a scale in Strudel-friendly names, e.g. root=g mode=minor octave=4.',
    inputSchema: {
      type: 'object',
      properties: {
        root: { type: 'string' },
        mode: { type: 'string', description: Object.keys(SCALE_INTERVALS).join('|') },
        octave: { type: 'number' }
      },
      required: ['root']
    }
  },
  {
    name: 'theory_progression',
    description: "Diatonic chord progression as triads and as a ready Strudel pattern, e.g. key=a mode=minor numerals=['i','VI','III','VII'].",
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string' },
        mode: { type: 'string' },
        numerals: { type: 'array', items: { type: 'string' } }
      },
      required: ['key', 'numerals']
    }
  }
];

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const err = (message) => ({ content: [{ type: 'text', text: message }], isError: true });

async function callTool(name, args = {}) {
  switch (name) {
    case 'compose_pattern': {
      const { target, code, note } = args;
      if (!target || typeof code !== 'string') return err('target and code are required');
      if (target === 'metaprogram') {
        const { errors } = parseMetaprogram(code);
        if (errors.length) {
          return err(`invalid NetCycles program:\n${errors.map(e => `${e.line}:${e.col} ${e.message}`).join('\n')}`);
        }
      } else {
        if (!/^\d+[a-z]+$/.test(target)) return err(`'${target}' is not a bot cluster index (like '1a') or 'metaprogram'`);
        const check = validateInstruments(code, defs);
        if (!check.ok) {
          return err(`unknown instruments: ${check.unknown.join(', ')} — allowed: ${[...defs.instruments].join(', ')} (+ prefixes ${defs.prefixes.join(', ')})`);
        }
      }
      const { position, seq } = queues.enqueue(target, code, note || '');
      return text({ queued: true, target, position, seq, deliveredBy: SIDECAR_WS_URL ? `drain every ${DRAIN_MS} ms` : 'queue-only mode (no sidecar configured)' });
    }
    case 'get_update_queue':
      return text(queues.peekAll(args.target));
    case 'list_targets': {
      const bots = [...roster.values()]
        .filter(p => p.isBot)
        .map(p => ({ index: p.roomIndex, name: p.displayName, muted: p.muted, canEditMetaprogram: p.canEditMetaprogram }));
      return text({ metaprogram: true, bots, queued: queues.targets().map(t => ({ target: t, depth: queues.depth(t) })) });
    }
    case 'list_instruments':
      return text({ instruments: [...defs.instruments], prefixes: defs.prefixes });
    case 'theory_scale':
      return text({ notes: scaleNotes(args.root, args.mode || 'major', args.octave ?? 4) });
    case 'theory_progression':
      return text({
        triads: chordProgression(args.key, args.mode || 'major', args.numerals),
        pattern: progressionToPattern(args.key, args.mode || 'major', args.numerals)
      });
    default:
      return err(`unknown tool: ${name}`);
  }
}

// ─── MCP wiring ────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'trussal-mcp-agent', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  try {
    return await callTool(req.params.name, req.params.arguments);
  } catch (e) {
    return err(`tool failed: ${e.message}`);
  }
});

startDelivery();
const transport = new StdioServerTransport();
await server.connect(transport);
log(`ready — room ${ROOM}, ${defs.instruments.size} instruments whitelisted`);

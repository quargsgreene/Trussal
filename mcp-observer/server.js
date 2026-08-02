#!/usr/bin/env node
// MCP server that surfaces live state from all three Trussal VMs as tools.
// Run with: node server.js
// Configure via .env in this directory or environment variables.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), '.env') });

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import WebSocket from 'ws';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ─── Config ────────────────────────────────────────────────────────────────
const VIDEO_WS_URL   = process.env.VIDEO_WS_URL   || 'ws://localhost:8081';
const BOTS_ADMIN_URL = process.env.BOTS_ADMIN_URL || 'http://localhost:7777';
const VIDEO_VM_SSH   = process.env.VIDEO_VM_SSH;
const AUDIO_VM_SSH   = process.env.AUDIO_VM_SSH;
const BOTS_VM_SSH    = process.env.BOTS_VM_SSH;
const OBSERVE_ROOMS  = (process.env.OBSERVE_ROOMS || '0').split(',').map(r => r.trim());
const SESSION_LOG_DIR = process.env.SESSION_LOG_DIR || '';

// ─── State ─────────────────────────────────────────────────────────────────
// roomName → Map<peerId, peerRecord>
const roomPeers = new Map();
// circular event buffer
const eventLog = [];
const MAX_EVENTS = 300;

function logEvent(room, type, payload) {
  eventLog.push({ ts: Date.now(), room, type, ...payload });
  if (eventLog.length > MAX_EVENTS) eventLog.shift();
}

// ─── WebSocket observer ────────────────────────────────────────────────────
function observeRoom(roomName) {
  if (!roomPeers.has(roomName)) roomPeers.set(roomName, new Map());
  const peers = roomPeers.get(roomName);
  let ws, reconnectTimer;

  function connect() {
    const url = `${VIDEO_WS_URL}?room=${encodeURIComponent(roomName)}&role=observer`;
    ws = new WebSocket(url);

    ws.on('open', () => {
      log(`connected room=${roomName}`);
      ws.send(JSON.stringify({ type: 'hello', jitsiId: '_mcp_observer', displayName: '[MCP Observer]' }));
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      switch (msg.type) {
        case 'roster':
          peers.clear();
          for (const p of msg.peers) peers.set(p.peerId, p);
          break;

        case 'peer-join':
          peers.set(msg.peer.peerId, { ...msg.peer });
          logEvent(roomName, 'peer-join', { peerId: msg.peer.peerId, displayName: msg.peer.displayName });
          break;

        case 'peer-leave':
          peers.delete(msg.peerId);
          logEvent(roomName, 'peer-leave', { peerId: msg.peerId });
          break;

        case 'peer-update': {
          const peer = peers.get(msg.peerId);
          if (!peer) break;
          Object.assign(peer, msg.patch);
          if (msg.patch.pattern !== undefined)
            logEvent(roomName, 'pattern', { peerId: msg.peerId, pattern: msg.patch.pattern });
          if (msg.patch.playing !== undefined)
            logEvent(roomName, msg.patch.playing ? 'play' : 'stop', { peerId: msg.peerId });
          // Log the media-path fields too, not just the WS ping/pong leg:
          // WCRTT and WCJ are derived from rtcRtt/rtcJitter wherever those
          // exist, so a log carrying only rtt/jitter cannot explain the
          // worst-case numbers a room is actually running on. Keyed off the
          // patch carrying ANY metric, since an RTCStats-only poll sends no
          // rtt at all.
          if (msg.patch.rtt !== undefined || msg.patch.rtcRtt !== undefined ||
              msg.patch.rtcJitter !== undefined || msg.patch.packetLoss !== undefined)
            logEvent(roomName, 'metrics', {
              peerId: msg.peerId,
              rtt: msg.patch.rtt, jitter: msg.patch.jitter,
              rtcRtt: msg.patch.rtcRtt, rtcJitter: msg.patch.rtcJitter,
              packetLoss: msg.patch.packetLoss,
              jitterBufferMs: msg.patch.jitterBufferMs, pipelineMs: msg.patch.pipelineMs
            });
          break;
        }
      }
    });

    ws.on('close', () => {
      log(`disconnected room=${roomName}, reconnecting in 5s`);
      reconnectTimer = setTimeout(connect, 5000);
    });

    ws.on('error', (err) => log(`error room=${roomName}: ${err.message}`));
  }

  connect();
}

for (const room of OBSERVE_ROOMS) observeRoom(room);

// ─── Helpers ───────────────────────────────────────────────────────────────
function log(msg) { process.stderr.write(`[trussal-observer] ${msg}\n`); }

async function fetchJson(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return res.json();
}

async function sshExec(target, command) {
  if (!target) throw new Error('SSH target not configured — set the matching *_VM_SSH env var');
  const { stdout } = await execFileAsync('ssh', [
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
    '-o', 'BatchMode=yes',
    target,
    command,
  ], { timeout: 20_000 });
  return stdout.trim();
}

const SSH_COMMANDS = {
  video: [
    'cd ~/Trussal/docker-jitsi-meet && docker compose ps --format "table {{.Name}}\\t{{.Status}}\\t{{.Ports}}" 2>/dev/null',
    'echo "--- disk ---" && df -h / | tail -1',
    'echo "--- memory ---" && free -h | grep Mem',
  ].join(' && '),

  audio: [
    'systemctl list-units "jamulus@*" --no-legend --plain 2>/dev/null | head -20',
    'echo "--- disk ---" && df -h / | tail -1',
    'echo "--- memory ---" && free -h | grep Mem',
  ].join(' && '),

  bots: [
    'cd ~/Trussal/bots && docker compose ps --format "table {{.Name}}\\t{{.Status}}" 2>/dev/null',
    'echo "--- bot containers ---" && docker ps --filter name=trussal-bot --format "{{.Names}} {{.Status}}" 2>/dev/null',
    'echo "--- disk ---" && df -h / | tail -1',
    'echo "--- memory ---" && free -h | grep Mem',
  ].join(' && '),
};

// ─── MCP tools ─────────────────────────────────────────────────────────────
const TOOLS = [
  {
    name: 'get_peer_state',
    description:
      'Returns the current Strudel pattern, play state, effects, and network metrics (RTT/jitter) for every peer in a room. ' +
      'Data comes from the live-buffered peer-state WebSocket bus. ' +
      `Currently observing rooms: ${OBSERVE_ROOMS.join(', ')}.`,
    inputSchema: {
      type: 'object',
      properties: {
        room: { type: 'string', description: 'Room name (default: "0")' },
      },
    },
  },
  {
    name: 'list_rooms',
    description: 'Lists all rooms currently being observed, with peer counts and how many peers are playing.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_recent_events',
    description:
      'Returns the most recent peer-state events (pattern changes, play/stop, peer joins/leaves, metrics) ' +
      `across all observed rooms. Buffers up to ${MAX_EVENTS} events.`,
    inputSchema: {
      type: 'object',
      properties: {
        room:  { type: 'string', description: 'Filter to a specific room (optional)' },
        limit: { type: 'number', description: 'Max events to return (default 50)' },
        type:  { type: 'string', description: 'Filter by event type: peer-join | peer-leave | pattern | play | stop | metrics' },
      },
    },
  },
  {
    name: 'get_bot_metrics',
    description:
      'Returns each bot\'s Strudel script, start time, and last reported health metrics (FPS, RAM, Jitsi latency, jitter). ' +
      'Fetches from the conductor admin API.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_conductor_config',
    description: 'Returns the conductor\'s current configuration: maxBots, roles, health thresholds, Jitsi URL, Jamulus server.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'get_session_log',
    description:
      'Returns events from the Net Cycles research session log (JSONL written by the latency sidecar: ' +
      'joins/leaves with indices, metrics, CRDT edits with author/modality, fleet actions, scheduler cycle samples, health actions). ' +
      'Reads SESSION_LOG_DIR; defaults to the newest session file.',
    inputSchema: {
      type: 'object',
      properties: {
        session: { type: 'string', description: 'Session UUID (default: newest file)' },
        limit:   { type: 'number', description: 'Max events from the tail (default 100)' },
        type:    { type: 'string', description: 'Filter by event type (metrics | crdt-update | research-event | …)' },
      },
    },
  },
  {
    name: 'check_vm_health',
    description:
      'SSHes into a VM and returns service health. ' +
      'video: Docker Compose service table, disk, memory. ' +
      'audio: Jamulus systemd instance statuses, disk, memory. ' +
      'bots: Docker Compose table, running bot containers, disk, memory.',
    inputSchema: {
      type: 'object',
      properties: {
        vm: { type: 'string', enum: ['video', 'audio', 'bots'], description: 'Which VM to check' },
      },
      required: ['vm'],
    },
  },
];

const server = new Server(
  { name: 'trussal-observer', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
  const err  = (t) => ({ content: [{ type: 'text', text: t }], isError: true });

  switch (name) {
    case 'get_peer_state': {
      const room = args?.room ?? '0';
      const peers = roomPeers.get(room);
      if (!peers) return err(`Room "${room}" is not being observed. Configured rooms: ${OBSERVE_ROOMS.join(', ')}`);
      return text({
        room,
        observedAt: new Date().toISOString(),
        peerCount: peers.size,
        peers: [...peers.values()].map(({ ws: _ws, ...p }) => p),
      });
    }

    case 'list_rooms':
      return text([...roomPeers.entries()].map(([room, peers]) => ({
        room,
        peerCount: peers.size,
        playingCount: [...peers.values()].filter(p => p.playing).length,
      })));

    case 'get_recent_events': {
      const limit = args?.limit ?? 50;
      let events = eventLog;
      if (args?.room) events = events.filter(e => e.room === args.room);
      if (args?.type) events = events.filter(e => e.type === args.type);
      return text(events.slice(-limit).map(e => ({ ...e, ts: new Date(e.ts).toISOString() })));
    }

    case 'get_bot_metrics':
      try {
        return text(await fetchJson(`${BOTS_ADMIN_URL}/api/bots`));
      } catch (e) {
        return err(`Conductor /api/bots failed: ${e.message}`);
      }

    case 'get_conductor_config':
      try {
        return text(await fetchJson(`${BOTS_ADMIN_URL}/api/config`));
      } catch (e) {
        return err(`Conductor /api/config failed: ${e.message}`);
      }

    case 'check_vm_health': {
      const vm = args?.vm;
      const targets = { video: VIDEO_VM_SSH, audio: AUDIO_VM_SSH, bots: BOTS_VM_SSH };
      try {
        const output = await sshExec(targets[vm], SSH_COMMANDS[vm]);
        return text(output || '(no output)');
      } catch (e) {
        return err(`SSH to ${vm} VM failed: ${e.message}`);
      }
    }

    case 'get_session_log': {
      if (!SESSION_LOG_DIR) return err('SESSION_LOG_DIR is not configured for the observer.');
      try {
        const { readdirSync, readFileSync, statSync } = await import('node:fs');
        const { join } = await import('node:path');
        let files = readdirSync(SESSION_LOG_DIR).filter(f => f.endsWith('.jsonl'));
        if (args?.session) files = files.filter(f => f.includes(args.session));
        if (!files.length) return err('No session log files found.');
        files.sort((a, b) => statSync(join(SESSION_LOG_DIR, b)).mtimeMs - statSync(join(SESSION_LOG_DIR, a)).mtimeMs);
        const lines = readFileSync(join(SESSION_LOG_DIR, files[0]), 'utf8').trim().split('\n');
        let events = lines.map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
        if (args?.type) events = events.filter(e => e.type === args.type);
        const limit = args?.limit ?? 100;
        return text({ file: files[0], totalEvents: events.length, events: events.slice(-limit) });
      } catch (e) {
        return err(`session log read failed: ${e.message}`);
      }
    }

    default:
      return err(`Unknown tool: ${name}`);
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
log('MCP server ready');

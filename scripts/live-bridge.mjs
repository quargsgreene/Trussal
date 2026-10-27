// live-bridge.mjs — hands the personal editor's code to live coding languages
// that run in the performer's own terminal (TidalCycles, Sonic Pi, sclang,
// Renardo, zwirn, Sardine). The studio connects to it over a localhost
// WebSocket when one of those languages is picked in the editor's dropdown.
//
//   node scripts/live-bridge.mjs [--port 7171]
//
// Every interpreter is started on its first evaluation and kept running;
// its output comes back to the editor's status line. Sonic Pi is the
// exception: it is never started here, the code is sent to the receiver
// buffer you run in Sonic Pi as an OSC cue.
//
// Anything that reaches this socket runs as you, so it is guarded twice:
// it listens on 127.0.0.1 only, and every connection must open with the token
// printed at startup (paste it into the editor once — it is remembered).
//
// Environment (all optional):
//   TRUSSAL_BRIDGE_TOKEN    fixed token instead of a random one per run
//   TRUSSAL_BRIDGE_ORIGINS  comma-separated page origins allowed to connect
//                           (default: any origin holding the token)
//   TIDAL_CMD               default: ghci -ghci-script <BootTidal.hs>
//   TIDAL_BOOT              path to BootTidal.hs (default: found via Paths_tidal)
//   SCLANG_CMD              default: sclang -i trussal
//   RENARDO_CMD             default: renardo --pipe
//   ZWIRN_CMD               default: zwirnzi --ci.cli=true
//   SARDINE_CMD             default: sardine
//   SONIC_PI_HOST / SONIC_PI_PORT   default: 127.0.0.1 / 4560

import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createSocket } from 'node:dgram';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from 'ws';
import {
  BRIDGE_LANGUAGES,
  bridgeFrames,
  bridgeStopFrame,
  encodeOscMessage,
  getLanguage,
} from '../src/editor-languages-core.js';

const argPort = process.argv.indexOf('--port');
const PORT = Number(argPort !== -1 ? process.argv[argPort + 1] : 7171);
const TOKEN = process.env.TRUSSAL_BRIDGE_TOKEN || randomBytes(16).toString('hex');
const ORIGINS = (process.env.TRUSSAL_BRIDGE_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
const SONIC_PI_HOST = process.env.SONIC_PI_HOST || '127.0.0.1';
const SONIC_PI_PORT = Number(process.env.SONIC_PI_PORT || 4560);

// BootTidal.hs ships in the tidal package's data dir; ask GHC where that is,
// the same way the Tidal editor plugins do.
function findBootTidal() {
  if (process.env.TIDAL_BOOT) return process.env.TIDAL_BOOT;
  try {
    const dir = execFileSync('ghc', ['-e', 'import Paths_tidal', '-e', 'getDataDir>>=putStr'], { encoding: 'utf8', timeout: 20000 });
    const file = join(dir.trim(), 'BootTidal.hs');
    if (existsSync(file)) return file;
  } catch { /* reported below */ }
  return null;
}

// The shell command that starts each interpreter, or an error to report.
function commandFor(id) {
  switch (id) {
    case 'tidal': {
      if (process.env.TIDAL_CMD) return { cmd: process.env.TIDAL_CMD };
      const boot = findBootTidal();
      if (!boot) return { error: 'BootTidal.hs not found — set TIDAL_BOOT=/path/to/BootTidal.hs' };
      return { cmd: `ghci -ghci-script ${JSON.stringify(boot)}` };
    }
    case 'sclang': return { cmd: process.env.SCLANG_CMD || 'sclang -i trussal' };
    case 'renardo': return { cmd: process.env.RENARDO_CMD || 'renardo --pipe' };
    case 'zwirn': return { cmd: process.env.ZWIRN_CMD || 'zwirnzi --ci.cli=true' };
    case 'sardine': return { cmd: process.env.SARDINE_CMD || 'sardine' };
    default: return { error: `no interpreter for '${id}'` };
  }
}

const clients = new Set();
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === ws.OPEN) ws.send(data);
}

// One interpreter per language, shared by every connected tab.
const procs = new Map();

function ensureProcess(id) {
  const running = procs.get(id);
  if (running) return running;
  const { cmd, error } = commandFor(id);
  if (error) throw new Error(error);
  console.log(`[bridge] starting ${id}: ${cmd}`);
  const child = spawn(cmd, { shell: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const forward = (stream) => (chunk) => {
    const text = String(chunk);
    process.stdout.write(`[${id}] ${text}`);
    broadcast({ type: 'output', language: id, text });
  };
  child.stdout.on('data', forward('stdout'));
  child.stderr.on('data', forward('stderr'));
  child.on('error', (e) => broadcast({ type: 'error', language: id, text: `${id} failed to start: ${e.message}` }));
  child.on('exit', (code, signal) => {
    procs.delete(id);
    console.log(`[bridge] ${id} exited (${signal || code})`);
    broadcast({ type: 'exit', language: id, text: `${id} exited (${signal || code}) — it restarts on the next eval` });
  });
  // A missing executable surfaces as the shell's exit 127, not 'error'.
  child.stdin.on('error', () => {});
  procs.set(id, child);
  return child;
}

const udp = createSocket('udp4');
function sendSonicPi(code) {
  return new Promise((resolve, reject) => {
    udp.send(encodeOscMessage('/trussal/run', [code]), SONIC_PI_PORT, SONIC_PI_HOST, (e) => (e ? reject(e) : resolve()));
  });
}

async function handle(msg) {
  const id = msg.language;
  if (!Object.hasOwn(BRIDGE_LANGUAGES, id)) throw new Error(`unknown language '${id}'`);
  const label = getLanguage(id).label;
  if (msg.type === 'eval') {
    const frame = bridgeFrames(id, msg.code);
    if (id === 'sonicpi') {
      await sendSonicPi(frame);
      return `sent to Sonic Pi on ${SONIC_PI_HOST}:${SONIC_PI_PORT}`;
    }
    ensureProcess(id).stdin.write(frame);
    return `sent to ${label}`;
  }
  if (msg.type === 'stop') {
    const frame = bridgeStopFrame(id, msg.code);
    if (!frame) return `${label}: nothing to stop`;
    if (id === 'sonicpi') {
      await sendSonicPi(frame);
      return 'Sonic Pi loops stopped';
    }
    const child = procs.get(id);
    if (!child) return `${label} is not running`;
    child.stdin.write(frame);
    return `${label} stopped`;
  }
  throw new Error(`unknown message '${msg.type}'`);
}

function tokenMatches(given) {
  const a = Buffer.from(String(given ?? ''));
  const b = Buffer.from(TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const wss = new WebSocketServer({
  host: '127.0.0.1',
  port: PORT,
  maxPayload: 1 << 20,
  verifyClient: ({ origin }) => !ORIGINS.length || ORIGINS.includes(origin),
});

wss.on('connection', (ws) => {
  let authed = false;
  // A connection that never presents the token is not left open.
  const authTimer = setTimeout(() => { if (!authed) ws.close(4001, 'token required'); }, 5000);
  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (!authed) {
      if (msg.type !== 'hello' || !tokenMatches(msg.token)) {
        ws.send(JSON.stringify({ type: 'denied', text: 'wrong bridge token' }));
        ws.close(4003, 'wrong token');
        return;
      }
      authed = true;
      clearTimeout(authTimer);
      clients.add(ws);
      ws.send(JSON.stringify({ type: 'ready', languages: Object.keys(BRIDGE_LANGUAGES) }));
      return;
    }
    try {
      ws.send(JSON.stringify({ type: 'ok', language: msg.language, text: await handle(msg) }));
    } catch (e) {
      ws.send(JSON.stringify({ type: 'error', language: msg.language, text: e.message }));
    }
  });
  ws.on('close', () => { clearTimeout(authTimer); clients.delete(ws); });
});

wss.on('listening', () => {
  console.log(`Trussal live bridge on ws://127.0.0.1:${PORT}`);
  console.log(`Token: ${TOKEN}`);
  console.log('Paste the token into the personal editor\'s bridge field, then pick a language and press Play.');
});

const shutdown = () => {
  for (const child of procs.values()) child.kill();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

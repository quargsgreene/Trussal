// Jamulus relay — WebSocket audio bridge.
//
// For each active room, manages a chain:
//   jackd (dummy driver)  →  Jamulus (headless UDP client)  →  ffmpeg (JACK→PCM stdout)
//
// Raw Int16 stereo 48 kHz PCM is fanned out as binary WebSocket frames to every
// connected browser. Browsers decode it through an AudioWorklet ring-buffer
// player and route the stream into the Trussal per-peer effects chain.
//
// A room's processes are kept alive as long as at least one subscriber is
// connected; they are torn down after a 5-second grace period once the last
// subscriber disconnects.

'use strict';

const { WebSocketServer } = require('ws');
const { URL } = require('url');
const { spawn, execFileSync } = require('child_process');

const WSS_PORT       = 8082;
const JACK_RATE      = 48000;
const JACK_PERIOD    = 2048;          // samples per JACK period (~42 ms)
const IDLE_GRACE_MS  = 5_000;        // wait before killing idle room processes

const JAMULUS_HOST      = process.env.JAMULUS_HOST      || 'jamulus.trussal.com';
const JAMULUS_BASE_PORT = parseInt(process.env.JAMULUS_BASE_PORT || '22000', 10);
const MAX_ROOM_IDX      = 10;

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function jamulusAddr(room) {
  const idx = parseInt(room, 10);
  if (!Number.isFinite(idx) || idx < 0 || idx > MAX_ROOM_IDX) return null;
  return { host: JAMULUS_HOST, port: JAMULUS_BASE_PORT + idx };
}

// ---- Per-room relay state ---------------------------------------------------

const rooms = new Map(); // roomName → RoomRelay

class RoomRelay {
  constructor(room) {
    this.room        = room;
    this.subscribers = new Set();
    this.jackd       = null;
    this.jamulus     = null;
    this.ffmpeg      = null;
    this.stopping    = false;
    this.idleTimer   = null;
  }
}

// ---- Process helpers --------------------------------------------------------

function jackEnv(room) {
  return { ...process.env, JACK_DEFAULT_SERVER: `jack_r${room}` };
}

// Poll jack_lsp until the named client's ports appear (or timeout).
async function waitForPorts(room, clientPrefix, timeoutMs = 12_000) {
  const env   = jackEnv(room);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const out = execFileSync('jack_lsp', [], { env, timeout: 2000 }).toString();
      if (out.includes(clientPrefix + ':')) return true;
    } catch (_) { /* not ready yet */ }
    await sleep(600);
  }
  return false;
}

function tryJackConnect(room, src, dst) {
  try {
    execFileSync('jack_connect', [src, dst], { env: jackEnv(room), timeout: 3000 });
    return true;
  } catch (_) {
    return false;
  }
}

// ---- Relay lifecycle --------------------------------------------------------

async function startRelay(room) {
  const addr = jamulusAddr(room);
  if (!addr) throw new Error(`No Jamulus server mapped for room "${room}"`);

  const relay      = new RoomRelay(room);
  const serverName = `jack_r${room}`;
  const capName    = `ffcap_r${room}`;

  console.log(`[relay] room=${room}  starting jackd server=${serverName}`);
  relay.jackd = spawn('jackd', [
    '--no-realtime',          // must come before -d or jackd ignores it
    '-n', serverName,
    '-d', 'dummy',
    '-r', String(JACK_RATE),
    '-p', String(JACK_PERIOD),
  ], { env: jackEnv(room), stdio: 'ignore' });

  relay.jackd.on('exit', (code) => {
    console.warn(`[relay] room=${room}  jackd exited code=${code}`);
    if (!relay.stopping) teardownRelay(room, 'jackd exit');
  });

  await sleep(1200); // wait for jackd to initialise

  if (relay.stopping) throw new Error('jackd failed to start (exited during init)');

  console.log(`[relay] room=${room}  starting Jamulus → ${addr.host}:${addr.port}`);
  relay.jamulus = spawn('jamulus', [
    '-n',
    '-c', `${addr.host}:${addr.port}`,
  ], { env: jackEnv(room), stdio: 'ignore' });

  relay.jamulus.on('exit', (code) => {
    console.warn(`[relay] room=${room}  Jamulus exited code=${code}`);
    if (!relay.stopping) teardownRelay(room, 'Jamulus exit');
  });

  // Wait for Jamulus to register its JACK output ports.
  const jamReady = await waitForPorts(room, 'Jamulus');
  if (!jamReady) {
    teardownRelay(room, 'Jamulus ports timeout');
    throw new Error(`Jamulus did not register JACK ports for room "${room}" in time`);
  }

  console.log(`[relay] room=${room}  starting ffmpeg capture client=${capName}`);
  relay.ffmpeg = spawn('ffmpeg', [
    '-f', 'jack', '-i', capName,
    '-vn',
    '-c:a', 'pcm_s16le',
    '-ar', String(JACK_RATE),
    '-ac', '2',
    '-f', 's16le', 'pipe:1',
  ], { env: jackEnv(room), stdio: ['ignore', 'pipe', 'ignore'] });

  relay.ffmpeg.on('exit', (code) => {
    console.warn(`[relay] room=${room}  ffmpeg exited code=${code}`);
    if (!relay.stopping) teardownRelay(room, 'ffmpeg exit');
  });

  // Wait for ffmpeg to register its JACK input ports.
  const ffReady = await waitForPorts(room, capName);
  if (!ffReady) {
    teardownRelay(room, 'ffmpeg ports timeout');
    throw new Error(`ffmpeg did not register JACK ports for room "${room}" in time`);
  }

  // Connect Jamulus output → ffmpeg input.
  for (let i = 0; i < 6; i++) {
    const ok1 = tryJackConnect(room, 'Jamulus:out_1', `${capName}:input_1`);
    const ok2 = tryJackConnect(room, 'Jamulus:out_2', `${capName}:input_2`);
    if (ok1 && ok2) {
      console.log(`[relay] room=${room}  JACK ports connected`);
      break;
    }
    if (i === 5) console.warn(`[relay] room=${room}  could not connect all JACK ports`);
    await sleep(500);
  }

  // Fan out PCM chunks from ffmpeg stdout to all WebSocket subscribers.
  relay.ffmpeg.stdout.on('data', (chunk) => {
    if (relay.subscribers.size === 0) return;
    // Transfer the underlying ArrayBuffer to each subscriber (zero-copy for the
    // first; subsequent subscribers receive a copy via slice).
    const subs = Array.from(relay.subscribers);
    for (let i = 0; i < subs.length; i++) {
      const ws = subs[i];
      if (ws.readyState !== ws.OPEN) continue;
      try {
        const buf = i === 0
          ? chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength)
          : chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength);
        ws.send(buf, { binary: true });
      } catch (_) { /* slow/closed client — drop frame */ }
    }
  });

  return relay;
}

function teardownRelay(room, reason) {
  const relay = rooms.get(room);
  if (!relay || relay.stopping) return;
  relay.stopping = true;
  if (relay.idleTimer) { clearTimeout(relay.idleTimer); relay.idleTimer = null; }
  rooms.delete(room);
  console.log(`[relay] room=${room}  teardown (${reason})`);

  [relay.ffmpeg, relay.jamulus, relay.jackd].forEach(proc => {
    if (!proc) return;
    try { proc.kill('SIGTERM'); } catch (_) {}
  });

  const msg = JSON.stringify({ type: 'relay-stopped', reason });
  for (const ws of relay.subscribers) {
    try { ws.send(msg); ws.close(); } catch (_) {}
  }
  relay.subscribers.clear();
}

// ---- WebSocket server -------------------------------------------------------

const wss = new WebSocketServer({ port: WSS_PORT });

wss.on('connection', async (ws, req) => {
  let room;
  try {
    room = new URL(req.url, 'http://localhost').searchParams.get('room') || '';
  } catch (_) { ws.close(); return; }

  if (!jamulusAddr(room)) {
    ws.send(JSON.stringify({ type: 'error', message: `Unknown room: ${room}` }));
    ws.close();
    return;
  }

  console.log(`[relay] room=${room}  client connected`);

  // Cancel any pending idle teardown for this room.
  const existing = rooms.get(room);
  if (existing && existing.idleTimer) {
    clearTimeout(existing.idleTimer);
    existing.idleTimer = null;
  }

  let relay = existing;
  if (!relay || relay.stopping) {
    try {
      relay = await startRelay(room);
      rooms.set(room, relay);
    } catch (err) {
      console.error(`[relay] room=${room}  failed to start:`, err.message);
      ws.send(JSON.stringify({ type: 'error', message: err.message }));
      ws.close();
      return;
    }
  }

  ws.send(JSON.stringify({
    type: 'relay-ready',
    sampleRate: JACK_RATE,
    channels: 2,
    encoding: 'pcm_s16le',
  }));

  relay.subscribers.add(ws);

  ws.on('close', () => {
    console.log(`[relay] room=${room}  client disconnected`);
    relay.subscribers.delete(ws);
    if (relay.subscribers.size === 0) {
      relay.idleTimer = setTimeout(() => {
        if (rooms.get(room) === relay && relay.subscribers.size === 0) {
          teardownRelay(room, 'idle timeout');
        }
      }, IDLE_GRACE_MS);
    }
  });

  ws.on('error', (e) => console.warn(`[relay] room=${room}  ws error:`, e.message));
});

// ---- Cleanup on exit --------------------------------------------------------

function shutdown() {
  console.log('[relay] shutting down');
  for (const room of rooms.keys()) teardownRelay(room, 'server shutdown');
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT',  shutdown);

console.log(`[relay] listening on ws://0.0.0.0:${WSS_PORT}`);

#!/usr/bin/env node
// Joins a Trussal room as a player peer and plays a Strudel pattern.
//
// Usage:
//   node strudel-bot.js [options]
//
// Options:
//   --url      WebSocket base URL  (default: ws://localhost:8081)
//              For a deployed instance use e.g. wss://your-host/ws
//   --room     Room name           (default: default)
//   --name     Display name        (default: strudel-bot)
//   --pattern  Strudel code        (default: s("bd ~ sd ~"))

import { WebSocket } from 'ws';
import { randomUUID } from 'crypto';

const args = parseArgs(process.argv.slice(2));
const baseUrl = args.url ?? 'ws://localhost:8081';
const room    = args.room    ?? 'default';
const name    = args.name    ?? 'strudel-bot';
const pattern = args.pattern ?? 's("bd ~ sd ~")';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

let ws = null;
let stopping = false;

process.on('SIGINT', () => {
  stopping = true;
  console.log('\nstopping...');
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: 'stop' }));
    ws.close();
  }
  process.exit(0);
});

function connect() {
  const url = `${baseUrl}?room=${encodeURIComponent(room)}&role=player`;
  console.log(`connecting  room=${room}  url=${url}`);
  ws = new WebSocket(url);

  ws.on('open', () => {
    console.log('connected');
    // Keep the connection alive; server uses ping/pong for RTT tracking.
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping', sentAt: Date.now() }));
      } else {
        clearInterval(pingInterval);
      }
    }, 5000);
  });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data.toString()); } catch { return; }

    switch (msg.type) {
      case 'welcome':
        console.log(`peerId=${msg.peerId}`);
        ws.send(JSON.stringify({ type: 'hello', jitsiId: randomUUID(), displayName: name }));
        break;

      case 'roster':
        console.log(`roster received (${msg.peers.length} other peer(s))`);
        ws.send(JSON.stringify({ type: 'pattern', code: pattern }));
        ws.send(JSON.stringify({ type: 'play' }));
        console.log(`playing: ${pattern}`);
        break;

      case 'pong':
        // Server reflects RTT; broadcast it so our effects chain is driven
        // by real latency like a normal peer.
        if (typeof msg.rtt === 'number') {
          ws.send(JSON.stringify({ type: 'metrics', rtt: msg.rtt, jitter: 0 }));
        }
        break;
    }
  });

  ws.on('close', () => {
    if (stopping) return;
    console.log('disconnected — reconnecting in 3 s...');
    setTimeout(connect, 3000);
  });

  ws.on('error', (err) => {
    console.warn('ws error:', err.message);
  });
}

connect();

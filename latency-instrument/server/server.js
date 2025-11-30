/*
const path = require('path');
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const base = 'https://latency.trussal.com';

const PORT = process.env.LATENCY_PORT || 8081;

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

function nowMs() {
  return Date.now();
}

// clients keyed by roomId
const rooms = new Map(); // roomId -> Map(clientId -> clientInfo)

//app.use( '/', express.static(path.join(__dirname, '../client')));
app.get('/health', (req, res) => {res.json({ok: true, service: 'latency', time: new Date().toISOString()})});
function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
  }
  return rooms.get(roomId);
}

function broadcastBeat(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.size === 0) return;
  if (room.hasComposer) return;

  const baseTime = nowMs();

  for (const [id, client] of room.entries()) {
    if (client.socket.readyState !== WebSocket.OPEN) continue;
    if (client.role !== 'player') continue;
    // Example: “use latency as the instrument”
    const rtt = client.rttMs || 150;
    const jitter = Math.random() * 120;
    const delayMs = 0.5 * rtt + jitter;

    const eventTime = baseTime + delayMs;

    client.socket.send(JSON.stringify({
      type: 'play',
      at: eventTime,
      voice: 'click',
      // e.g. encode rtt in pitch
      pitch: 60 + Math.round((rtt % 240) / 20),
      debug: { baseTime, delayMs, rtt }
    }));
  }
}

// Periodically emit room “beats”
setInterval(() => {
  for (const roomId of rooms.keys()) {
    broadcastBeat(roomId);
  }
}, 600); // ≈ 100BPM, 1 beat every 600ms

wss.on('connection', (ws, req) => {
  // Parse ?room= & ?client= from the URL
  const url = new URL(req.url, `http://${req.headers.host}`);
  const roomId = url.searchParams.get('room') || 'default';
  const clientId = url.searchParams.get('client') || Math.random().toString(36).slice(2);
  const role = url.searchParams.get('role') || 'player';  // NEW
  console.log(`server.js ${url}`);

  console.log(`Client ${clientId} joined room ${roomId} as ${role}`);

  const room = getRoom(roomId);
  const clientInfo = {
    id: clientId,
    roomId,
    role,
    socket: ws,
    lastPing: null,
    rttMs: null
  };

  room.set(clientId, clientInfo);
  if (role === 'composer') {
    room.hasComposer = true;
  }
}
);

wss.on('message', (data) => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch (e) {
      return;
    }

    if (msg.type === 'ping') {
      const now = nowMs();
      const rtt = now - msg.sentAt;
      clientInfo.rttMs = rtt;
      clientInfo.lastPing = now;

      wss.send(JSON.stringify({ type: 'pong', at: now, rtt }));
    }

   if (msg.type === 'patternEvent' && clientInfo.role === 'composer') {
      handlePatternEvent(roomId, msg);
   }


  });

  wss.on('close', () => {
    console.log(`Client ${clientId} left room ${roomId}`);
    const r = rooms.get(roomId);
    if (!r) return;
    r.clients.delete(clientId);
    if (clientInfo.role === 'composer') {
      // No more composers? revert to metronome mode
      const stillHasComposer = Array.from(r.clients.values()).some(c => c.role === 'composer');
      r.hasComposer = stillHasComposer;
    }
    if (r.clients.size === 0) rooms.delete(roomId);
});

server.listen(PORT, () => {
  console.log(`Latency instrument server listening on :${PORT}`);
});

function getRoomState(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      clients: new Map(),
      hasComposer: false
    });
  }
  return rooms.get(roomId);
}

function handlePatternEvent(roomId, msg) {
  const room = rooms.get(roomId);
  if (!room) return;

  const baseTime = nowMs();
  const baseDelayMs = msg.delayMs || 0;

  for (const client of room.clients.values()) {
    if (client.socket.readyState !== WebSocket.OPEN) continue;
    if (client.role !== 'player') continue;

    const rtt = client.rttMs || 30;

    // Example: composer-specified delay + function of rtt
    const delayMs = baseDelayMs + (msg.useRtt ? rtt * (msg.rttScale || 0.5) : 0);

    const eventTime = baseTime + delayMs;

    client.socket.send(JSON.stringify({
      type: 'play',
      at: eventTime,
      voice: msg.voice || 'click',
      pitch: msg.pitch ?? (60 + Math.round((rtt % 240) / 20)),
      meta: msg.meta || {}
    }));
  }
}
*/
/*import express from 'express';
import http from 'http';
import { WebSocketServer } from 'ws';

const PORT = process.env.PORT || 8081;

const app = express();
const server = http.createServer(app);

// Basic health endpoint so you can curl it from the web container
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'latency', time: new Date().toISOString() });
});

// WebSocket server mounted at /ws
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const room = url.searchParams.get('room') || 'unknown';
  const role = url.searchParams.get('role') || 'player';

  console.log(`[latency] WS connect room=${room} role=${role}`);

  socket.on('message', data => {
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }

    // Respond to RTT pings from the client
    if (msg.type === 'ping' && typeof msg.sentAt === 'number') {
      const rtt = performance.now() - msg.sentAt;
      socket.send(JSON.stringify({ type: 'pong', rtt }));
    }

    // If you later implement a conductor UI, you can broadcast "play" messages:
    if (msg.type === 'play') {
      for (const client of wss.clients) {
        if (client.readyState === client.OPEN) {
          client.send(JSON.stringify({
            type: 'play',
            at: msg.at,
            pitch: msg.pitch
          }));
        }
      }
    }
  });

  socket.on('close', () => {
    console.log(`[latency] WS close room=${room} role=${role}`);
  });
});

server.listen(PORT, () => {
  console.log(`[latency] listening on port ${PORT}`);
});

*/
// latency/server.js
const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');

const app = express();
app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'latency', time: new Date().toISOString() });
});

const server = http.createServer(app);

// Accept WS upgrades on /ws
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  console.log('[latency] WS connection', req.url);
  ws.on('close', () => console.log('[latency] WS closed', req.url));
  ws.on('error', (err) => console.log('[latency] WS error', err));
});

server.listen(8081, () => {
  console.log('[latency] listening on 8081');
});


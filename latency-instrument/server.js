// server.js
//
// Per-room fan-out for the distributed instrument:
//   - Each ws connects with ?room=<name>.
//   - The client sends `hello` with their Jitsi identity; we assign a peerId.
//   - We mirror the room's roster back to the new peer and announce them to
//     everyone else.
//   - Pattern/effect/play/rtt updates are stored on the peer record and
//     broadcast to the other peers in the same room.
//   - Ping/pong is point-to-point and keeps the existing RTT semantics.
//
// Exported as a factory so tests can run the server in-process on an
// ephemeral port; `node server.js` keeps the original standalone behavior.

const { WebSocketServer } = require('ws');
const { randomUUID } = require('crypto');
const { URL } = require('url');

function createLatencyServer({ port = 8081, server } = {}) {
  const wss = server ? new WebSocketServer({ server }) : new WebSocketServer({ port });

  const rooms = new Map(); // roomName -> Map<peerId, peerRecord>

  function getRoom(name) {
    let room = rooms.get(name);
    if (!room) {
      room = new Map();
      rooms.set(name, room);
    }
    return room;
  }

  function publicView(record) {
    return {
      peerId: record.peerId,
      jitsiId: record.jitsiId,
      displayName: record.displayName,
      pattern: record.pattern,
      effects: record.effects,
      playing: record.playing,
      rtt: record.rtt,
      jitter: record.jitter,
      packetLoss: record.packetLoss,
      rtcRtt: record.rtcRtt,
      isBot: record.isBot,
      muted: record.muted
    };
  }

  function broadcast(room, exceptPeerId, msg) {
    const data = JSON.stringify(msg);
    for (const peer of room.values()) {
      if (peer.peerId === exceptPeerId) continue;
      if (peer.ws.readyState === peer.ws.OPEN) {
        try { peer.ws.send(data); } catch (e) { /* ignore */ }
      }
    }
  }

  function send(ws, msg) {
    if (ws.readyState !== ws.OPEN) return;
    try { ws.send(JSON.stringify(msg)); } catch (e) { /* ignore */ }
  }

  wss.on('connection', (ws, req) => {
    let roomName = 'default';
    try {
      const url = new URL(req.url, 'http://localhost');
      roomName = url.searchParams.get('room') || 'default';
    } catch (e) {
      console.warn('[latency] bad request url:', req.url);
    }

    const peerId = randomUUID();
    const record = {
      peerId,
      ws,
      roomName,
      jitsiId: null,
      displayName: null,
      pattern: '',
      effects: { distortion: false, noise: false, reverb: false },
      playing: false,
      rtt: null,
      jitter: null,
      packetLoss: null,
      rtcRtt: null,
      isBot: false,
      muted: false
    };

    console.log(`[latency] connection room=${roomName} peerId=${peerId}`);

    // Welcome — tell client its own peerId so subsequent broadcasts can be
    // matched up.
    send(ws, { type: 'welcome', peerId });

    ws.on('message', (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); }
      catch (e) { return; }

      switch (msg.type) {
        case 'hello': {
          record.jitsiId = typeof msg.jitsiId === 'string' ? msg.jitsiId : null;
          record.displayName = typeof msg.displayName === 'string' ? msg.displayName : null;
          record.isBot = !!msg.isBot;

          const room = getRoom(roomName);

          // Evict any stale entry with the same jitsiId (e.g. a lingering connection
          // from a reconnect or a re-hello on the same socket after displayName change).
          // Broadcast peer-leave first so existing peers remove the old entry.
          if (record.jitsiId) {
            for (const [stalePeerId, staleRecord] of room.entries()) {
              if (stalePeerId !== peerId && staleRecord.jitsiId === record.jitsiId) {
                room.delete(stalePeerId);
                broadcast(room, peerId, { type: 'peer-leave', peerId: stalePeerId });
                break;
              }
            }
          }

          // Exclude this peer's own record from the roster (guards against re-hello
          // on the same socket where the record is already present in the room).
          const roster = Array.from(room.values())
            .filter(r => r.peerId !== peerId)
            .map(publicView);
          room.set(peerId, record);

          send(ws, { type: 'roster', peers: roster });
          broadcast(room, peerId, { type: 'peer-join', peer: publicView(record) });
          break;
        }

        case 'pattern': {
          if (typeof msg.code !== 'string') break;
          record.pattern = msg.code;
          const room = rooms.get(roomName);
          if (room) broadcast(room, peerId, { type: 'peer-update', peerId, patch: { pattern: record.pattern } });
          break;
        }

        case 'effects': {
          if (!msg.state || typeof msg.state !== 'object') break;
          record.effects = {
            distortion: !!msg.state.distortion,
            noise: !!msg.state.noise,
            reverb: !!msg.state.reverb
          };
          const room = rooms.get(roomName);
          if (room) broadcast(room, peerId, { type: 'peer-update', peerId, patch: { effects: record.effects } });
          break;
        }

        case 'play':
        case 'stop': {
          record.playing = msg.type === 'play';
          const room = rooms.get(roomName);
          if (room) broadcast(room, peerId, { type: 'peer-update', peerId, patch: { playing: record.playing } });
          break;
        }

        case 'remote-control': {
          // Operator-driven control of another peer (the studio editing/muting a
          // bot's tile). Only bots can be driven remotely — humans own their own
          // state and are never overridden. The action is relayed to the target's
          // socket (so it re-evaluates / mutes) and the resulting state change is
          // broadcast so every studio reflects it.
          const room = rooms.get(roomName);
          if (!room) break;
          const target = room.get(msg.targetPeerId);
          if (!target || !target.isBot) break;
          if (msg.action === 'pattern' && typeof msg.code === 'string') {
            target.pattern = msg.code;
            send(target.ws, { type: 'remote-control', action: 'pattern', code: target.pattern });
            broadcast(room, target.peerId, { type: 'peer-update', peerId: target.peerId, patch: { pattern: target.pattern } });
          } else if (msg.action === 'mute') {
            target.muted = !!msg.muted;
            send(target.ws, { type: 'remote-control', action: 'mute', muted: target.muted });
            broadcast(room, target.peerId, { type: 'peer-update', peerId: target.peerId, patch: { muted: target.muted } });
          }
          break;
        }

        case 'metrics': {
          // Network metrics broadcast so each peer's effects chain (and the
          // shared worst-case cycle math) everywhere uses that peer's own
          // network conditions rather than the viewer's. rtt/jitter come from
          // the WS ping/pong fallback; packetLoss (0..1) and rtcRtt (ms) come
          // from RTCStatsReport polling when available.
          if (typeof msg.rtt === 'number') record.rtt = msg.rtt;
          if (typeof msg.jitter === 'number') record.jitter = msg.jitter;
          if (typeof msg.packetLoss === 'number') record.packetLoss = msg.packetLoss;
          if (typeof msg.rtcRtt === 'number') record.rtcRtt = msg.rtcRtt;
          const room = rooms.get(roomName);
          if (room) broadcast(room, peerId, {
            type: 'peer-update',
            peerId,
            patch: { rtt: record.rtt, jitter: record.jitter, packetLoss: record.packetLoss, rtcRtt: record.rtcRtt }
          });
          break;
        }

        case 'ping': {
          if (typeof msg.sentAt !== 'number') break;
          send(ws, { type: 'pong', clientSentAt: msg.sentAt, rtt: Date.now() - msg.sentAt });
          break;
        }

        default:
          break;
      }
    });

    ws.on('close', () => {
      const room = rooms.get(roomName);
      if (room && room.has(peerId)) {
        room.delete(peerId);
        broadcast(room, peerId, { type: 'peer-leave', peerId });
        if (room.size === 0) rooms.delete(roomName);
      }
      console.log(`[latency] close room=${roomName} peerId=${peerId}`);
    });

    ws.on('error', (err) => {
      console.warn('[latency] socket error:', err.message);
    });
  });

  return { wss, rooms };
}

module.exports = { createLatencyServer };

if (require.main === module) {
  console.log('[latency] BOOT: latency WS server starting');
  createLatencyServer({ port: 8081 });
  console.log('[latency] listening on ws://0.0.0.0:8081');
}

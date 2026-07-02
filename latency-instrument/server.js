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
const { botSuffix } = require('./room-indices.js');

function createLatencyServer({ port = 8081, server } = {}) {
  const wss = server ? new WebSocketServer({ server }) : new WebSocketServer({ port });

  const rooms = new Map(); // roomName -> Map<peerId, peerRecord>
  // roomName -> { nextIndex, botCounters: Map<ownerIndex, count>, crdtLog }.
  // Index counters are the meeting's source of truth: indices are
  // join-ordered, immutable for the meeting, and never reused after a leave.
  // crdtLog holds the metaprogram doc's update history (opaque base64 Yjs
  // updates — the relay never interprets them); a client-sent snapshot
  // subsumes and replaces the log. The meta record dies with the room.
  const roomMeta = new Map();
  const CRDT_LOG_MAX = 500; // hard cap; clients snapshot long before this

  function getRoom(name) {
    let room = rooms.get(name);
    if (!room) {
      room = new Map();
      rooms.set(name, room);
    }
    return room;
  }

  function getRoomMeta(name) {
    let meta = roomMeta.get(name);
    if (!meta) {
      meta = { nextIndex: 0, botCounters: new Map(), crdtLog: [] };
      roomMeta.set(name, meta);
    }
    return meta;
  }

  // Sequential identifying index, assigned once at hello. Humans (and bots
  // that arrive without an owner) get the next integer in join order. Bots
  // that declare an ownerIndex get `<ownerIndex><suffix>` with the cluster's
  // next letter suffix (also never reused).
  function assignRoomIndex(roomName, { isBot, ownerIndex }) {
    const meta = getRoomMeta(roomName);
    if (isBot && typeof ownerIndex === 'string' && /^\d+$/.test(ownerIndex)) {
      const count = meta.botCounters.get(ownerIndex) || 0;
      meta.botCounters.set(ownerIndex, count + 1);
      return `${ownerIndex}${botSuffix(count)}`;
    }
    return String(meta.nextIndex++);
  }

  function publicView(record) {
    return {
      peerId: record.peerId,
      roomIndex: record.roomIndex,
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
      muted: record.muted,
      canEditMetaprogram: record.canEditMetaprogram,
      canWriteModulation: record.canWriteModulation
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
      roomIndex: null,
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
      isFleet: false,
      muted: false,
      // Metaprogram permissions. Humans always read+edit; bots default to
      // read-only until their owner grants edit (Phase 8 UI, enforced here).
      canEditMetaprogram: true,
      canWriteModulation: true
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
          // The fleet service joins the bus to receive fleet-requests and
          // roster events, but is not a participant: no index, invisible in
          // rosters, never announced.
          record.isFleet = !!msg.isFleet;
          if (record.isBot) {
            record.canEditMetaprogram = false;
            record.canWriteModulation = false;
          }

          const room = getRoom(roomName);

          // Evict any stale entry with the same jitsiId (e.g. a lingering connection
          // from a reconnect or a re-hello on the same socket after displayName change).
          // Broadcast peer-leave first so existing peers remove the old entry.
          // Same jitsiId = same participant session, so the new connection
          // inherits the stale record's roomIndex (indices are immutable for
          // the meeting). A genuine rejoin arrives with a fresh Jitsi id and
          // gets a fresh index below.
          if (record.jitsiId) {
            for (const [stalePeerId, staleRecord] of room.entries()) {
              if (stalePeerId !== peerId && staleRecord.jitsiId === record.jitsiId) {
                if (record.roomIndex == null) record.roomIndex = staleRecord.roomIndex;
                room.delete(stalePeerId);
                broadcast(room, peerId, { type: 'peer-leave', peerId: stalePeerId });
                break;
              }
            }
          }

          if (record.roomIndex == null && !record.isFleet) {
            record.roomIndex = assignRoomIndex(roomName, {
              isBot: record.isBot,
              ownerIndex: typeof msg.ownerIndex === 'string' ? msg.ownerIndex : null
            });
          }

          // Exclude this peer's own record from the roster (guards against re-hello
          // on the same socket where the record is already present in the room).
          const roster = Array.from(room.values())
            .filter(r => r.peerId !== peerId && !r.isFleet)
            .map(publicView);
          room.set(peerId, record);

          // `you` carries the client's own assigned index (the server never
          // echoes a peer's own record in later broadcasts).
          send(ws, { type: 'roster', peers: roster, you: publicView(record) });
          // Late-joiner catch-up: the full metaprogram doc history.
          const meta = getRoomMeta(roomName);
          if (meta.crdtLog.length) {
            send(ws, { type: 'crdt-state', updates: meta.crdtLog.map(e => e.update) });
          }
          if (!record.isFleet) {
            broadcast(room, peerId, { type: 'peer-join', peer: publicView(record) });
          }
          break;
        }

        case 'fleet-request': {
          // A human asks their fleet service for cluster changes (spawn N
          // bots, remove a subset, …). Relayed to the whole room with the
          // requester's index attached; the fleet service consumes it, other
          // clients may display it. Bots cannot drive the fleet.
          if (record.isBot || record.isFleet) break;
          const room = rooms.get(roomName);
          if (!room) break;
          broadcast(room, peerId, {
            type: 'fleet-request',
            fromIndex: record.roomIndex,
            action: msg.action,
            count: msg.count,
            targets: msg.targets
          });
          break;
        }

        case 'fleet-status': {
          // Fleet service reports back (spawned counts, ceiling hits, owner
          // teardown). Broadcast so every studio can surface the reason.
          if (!record.isFleet) break;
          const room = rooms.get(roomName);
          if (!room) break;
          broadcast(room, peerId, { ...msg, type: 'fleet-status' });
          break;
        }

        case 'crdt-update': {
          // Shared metaprogram doc sync. Updates are opaque base64 Yjs
          // payloads; the relay fans them out and keeps the log for late
          // joiners. Bots need edit permission (granted by their owner) —
          // a denied edit is dropped and logged, never applied.
          if (typeof msg.update !== 'string' || !msg.update) break;
          if (record.isBot && !record.canEditMetaprogram) {
            console.log(`[latency] dropped crdt-update from read-only bot ${record.roomIndex ?? peerId}`);
            break;
          }
          const meta = getRoomMeta(roomName);
          if (msg.snapshot) {
            // A full-state snapshot subsumes prior history.
            meta.crdtLog = [{ update: msg.update }];
          } else {
            meta.crdtLog.push({ update: msg.update });
            if (meta.crdtLog.length > CRDT_LOG_MAX) meta.crdtLog.shift();
          }
          const room = rooms.get(roomName);
          if (room) {
            broadcast(room, peerId, {
              type: 'crdt-update',
              update: msg.update,
              authorIndex: record.roomIndex,
              modality: typeof msg.modality === 'string' ? msg.modality : 'keyboard'
            });
          }
          break;
        }

        case 'bot-permission': {
          // Owner grants/revokes a bot's metaprogram-edit or modulation-write
          // rights. Only humans may grant, only bots may be targets.
          if (record.isBot) break;
          const room = rooms.get(roomName);
          if (!room) break;
          const target = room.get(msg.targetPeerId);
          if (!target || !target.isBot) break;
          if (typeof msg.canEditMetaprogram === 'boolean') target.canEditMetaprogram = msg.canEditMetaprogram;
          if (typeof msg.canWriteModulation === 'boolean') target.canWriteModulation = msg.canWriteModulation;
          broadcast(room, null, {
            type: 'peer-update',
            peerId: target.peerId,
            patch: {
              canEditMetaprogram: target.canEditMetaprogram,
              canWriteModulation: target.canWriteModulation
            }
          });
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
        if (!record.isFleet) broadcast(room, peerId, { type: 'peer-leave', peerId });
        if (room.size === 0) {
          rooms.delete(roomName);
          roomMeta.delete(roomName); // meeting over — counters reset with it
        } else if (![...room.values()].some(r => !r.isFleet)) {
          // Only the fleet service is left: the meeting is over even though
          // the room object survives — reset indices and the shared doc.
          roomMeta.delete(roomName);
        }
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
  const { createO2Relay } = require('./o2-relay.js');
  createO2Relay({ port: 8082 });
  console.log('[latency] O2 relay listening on ws://0.0.0.0:8082');
}

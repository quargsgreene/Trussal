// O2Relay — WebSocket relay for O2lite clients, plus the room's clock
// reference.
//
// Each binary WS frame is one O2lite message (latency-instrument/
// o2lite-format.js). Two behaviors:
//   - `/_cs/get` (,it seqno clientTime): answered point-to-point with
//     `/_cs/rply` (,itt seqno clientTime serverTime). The relay's monotonic
//     clock is the shared reference every ClockSync maps its
//     audioCtx.currentTime onto.
//   - anything else: fanned out verbatim to every other client in the same
//     ?room= — the relay never needs to understand performance traffic.
//
// Exported as a factory (like createLatencyServer) so tests run it
// in-process on an ephemeral port; the sidecar main starts it on :8082.

const { WebSocketServer } = require('ws');
const { deserializeMessage, serializeMessage, CS_GET, CS_REPLY } = require('./o2lite-format.js');

function createO2Relay({ port = 8082, server, now } = {}) {
  const wss = server ? new WebSocketServer({ server }) : new WebSocketServer({ port });
  // Monotonic reference clock in seconds. hrtime-based so wall-clock steps
  // (NTP jumps) can't yank every client's cycle grid.
  const t0 = process.hrtime.bigint();
  const refNow = now || (() => Number(process.hrtime.bigint() - t0) / 1e9);

  const rooms = new Map(); // roomName -> Set<ws>

  wss.on('connection', (ws, req) => {
    let roomName = 'default';
    try {
      const url = new URL(req.url, 'http://localhost');
      roomName = url.searchParams.get('room') || 'default';
    } catch (e) { /* keep default */ }

    let room = rooms.get(roomName);
    if (!room) { room = new Set(); rooms.set(roomName, room); }
    room.add(ws);

    ws.on('message', (data, isBinary) => {
      if (!isBinary) return; // O2lite is binary-only
      let msg;
      try { msg = deserializeMessage(data); }
      catch (e) { return; }

      if (msg.address === CS_GET) {
        const [seqno, clientTime] = msg.args;
        const reply = serializeMessage({
          address: CS_REPLY,
          typespec: ',itt',
          args: [seqno | 0, clientTime, refNow()]
        });
        try { ws.send(reply); } catch (e) { /* ignore */ }
        return;
      }

      // Fan out to everyone else in the room, verbatim.
      for (const peer of room) {
        if (peer === ws || peer.readyState !== peer.OPEN) continue;
        try { peer.send(data); } catch (e) { /* ignore */ }
      }
    });

    ws.on('close', () => {
      room.delete(ws);
      if (room.size === 0) rooms.delete(roomName);
    });
    ws.on('error', () => { /* close handler cleans up */ });
  });

  return { wss, rooms, now: refNow };
}

module.exports = { createO2Relay };

if (require.main === module) {
  createO2Relay({ port: 8082 });
  console.log('[o2relay] listening on ws://0.0.0.0:8082');
}

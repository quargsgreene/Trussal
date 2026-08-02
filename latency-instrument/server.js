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
const { randomUUID, timingSafeEqual } = require('crypto');
const { URL } = require('url');
const { appendFileSync, mkdirSync } = require('fs');
const { join } = require('path');
const { botSuffix, AGGREGATOR_ROOM_INDEX, parseParticipantToken } = require('./room-indices.js');

// Request header carrying the control channel's shared secret. Lower-case
// because Node normalises incoming header names; the fleet sends the same name
// (see makeWsSidecarConnector in bots/src/orchestrator/fleet-service.js).
const CONTROL_TOKEN_HEADER = 'x-trussal-control-token';

function createLatencyServer({ port = 8081, server, logDir = null, controlToken = null } = {}) {
  const wss = server ? new WebSocketServer({ server }) : new WebSocketServer({ port });

  const rooms = new Map(); // roomName -> Map<peerId, peerRecord>
  // roomName -> { nextIndex, indexByStableId: Map<stableId, roomIndex>, crdtLog }.
  // nextIndex is the meeting's source of truth for HUMAN indices: join-ordered,
  // immutable for the meeting, and never reused after a leave. Bot cluster
  // suffixes are NOT counted here — they gap-refill from the live roster (see
  // lowestFreeBotOrdinal), so a departed bot's suffix is reused by the next spawn.
  // indexByStableId gives a participant identity CONTINUITY across a genuine
  // rejoin: a returning client arrives with a fresh Jitsi id (so the stale-
  // eviction path can't recover its index), but carries a persistent stableId,
  // and is handed back the SAME room index it last held — so the aggregator's
  // rotation and the metaprogram, both keyed on the immutable index, fold it
  // back into its old slot instead of stranding it at a new, unlisted one.
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
      // aggregatorClaimPeerId: the connection currently holding the room's
      // single aggregator slot (see the 'aggregator-claim' handler). A losing
      // aggregator bot never joins Jitsi, so a room can only ever contain one.
      meta = { nextIndex: 0, indexByStableId: new Map(), crdtLog: [], sessionId: randomUUID(), aggregatorClaimPeerId: null, lastActiveToken: null, lastActiveIndex: null, lastActiveKind: null };
      roomMeta.set(name, meta);
    }
    return meta;
  }

  // Research session log: one timestamped JSONL file per room-session,
  // written server-side so client clock skew can't corrupt event ordering.
  // Disabled unless a logDir is configured (production main passes
  // SESSION_LOG_DIR, tests pass a temp dir).
  if (logDir) {
    try { mkdirSync(logDir, { recursive: true }); } catch (e) { /* exists */ }
  }
  function logEvent(roomName, type, payload = {}) {
    if (!logDir) return;
    const meta = getRoomMeta(roomName);
    const line = JSON.stringify({ ts: Date.now(), session: meta.sessionId, room: roomName, type, ...payload });
    try {
      appendFileSync(join(logDir, `session-${meta.sessionId}.jsonl`), line + '\n');
    } catch (e) { /* logging must never take the relay down */ }
  }

  // Lowest cluster ordinal not currently held by a LIVE bot of this owner. Bot
  // suffixes are gap-refilled (unlike human integer indices, which are join-
  // ordered and never reused): a departed bot frees its suffix, and the next
  // spawn for that owner takes the lowest free one (0a,0b,0c; 0b leaves; the
  // next spawn is 0b again, not 0d). Derived from the live roster, so it needs
  // no counter to reset when a cluster empties — an owner with no live bots
  // yields ordinal 0 ('a'). The record being assigned is not yet in the room
  // (room.set happens after assignRoomIndex), so it never counts itself.
  function lowestFreeBotOrdinal(roomName, ownerIndex) {
    const room = getRoom(roomName);
    const used = new Set();
    for (const r of room.values()) {
      const parsed = parseParticipantToken(String(r.roomIndex));
      if (parsed && parsed.suffix != null && String(parsed.ownerIndex) === String(ownerIndex)) {
        used.add(parsed.ordinal);
      }
    }
    let ordinal = 0;
    while (used.has(ordinal)) ordinal++;
    return ordinal;
  }

  // Sequential identifying index, assigned once at hello. Humans (and bots
  // that arrive without an owner) get the next integer in join order (immutable,
  // never reused). Bots that declare an ownerIndex get `<ownerIndex><suffix>`
  // with the cluster's lowest FREE suffix (gap-refilled — see lowestFreeBotOrdinal).
  // The audio aggregator gets the reserved AGGREGATOR_ROOM_INDEX: it is not a
  // performer, so it must not consume an integer from the human join-order
  // sequence — `$ participants` integer tokens must keep addressing humans.
  function assignRoomIndex(roomName, { isBot, isAggregator, ownerIndex }) {
    if (isAggregator) return AGGREGATOR_ROOM_INDEX;
    const meta = getRoomMeta(roomName);
    if (isBot && typeof ownerIndex === 'string' && /^\d+$/.test(ownerIndex)) {
      return `${ownerIndex}${botSuffix(lowestFreeBotOrdinal(roomName, ownerIndex))}`;
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
      rtcJitter: record.rtcJitter,
      jitterBufferMs: record.jitterBufferMs,
      pipelineMs: record.pipelineMs,
      isBot: record.isBot,
      isAggregator: record.isAggregator,
      muted: record.muted,
      canEditMetaprogram: record.canEditMetaprogram,
      canWriteModulation: record.canWriteModulation
    };
  }

  // Control connections (`?role=control`) watch the whole relay instead of one
  // room. The fleet service needs them because a room name is free-form — any
  // string is a valid meeting — so the fleet cannot know ahead of time which
  // rooms to join, and a fleet pinned to one configured name only ever serves
  // that one room (which is exactly why the aggregator used to appear only in
  // room "0"). A control connection is never put in a `rooms` Map, so it takes
  // no room index, appears in no roster, and broadcast() can never reach it.
  const controlConns = new Set();

  // Rooms that currently hold at least one real participant. Fleet/observer
  // connections don't count: a room containing only them is an empty meeting
  // that nobody has left yet (the same test the session-reset branch uses).
  function activeRooms() {
    return [...rooms.entries()]
      .filter(([, room]) => [...room.values()].some(r => !r.isFleet))
      .map(([name]) => name);
  }

  function announceRoomActive(name) {
    for (const ws of controlConns) send(ws, { type: 'room-active', room: name });
  }

  // The control channel is PRIVILEGED and must be authenticated: nginx proxies
  // /ws to the public internet with no auth of its own (see ws-route.conf), and
  // with ENABLE_GUESTS a room's NAME is the only thing gating entry to a
  // meeting. An open control channel would therefore hand any anonymous client
  // a live directory of every meeting in progress. A per-room connection needs
  // no such gate — you must already know the room name to ask for it.
  //
  // Fails CLOSED: with no token configured, control connections are refused
  // rather than served, because the failure mode of guessing wrong here is
  // silent public disclosure. Set SIDECAR_CONTROL_TOKEN on the sidecar and the
  // matching FLEET_CONTROL_TOKEN on the conductor.
  function controlTokenAccepted(presented) {
    if (!controlToken) return false;
    const expected = Buffer.from(String(controlToken));
    const actual = Buffer.from(String(presented ?? ''));
    // Equal-length requirement first: timingSafeEqual throws on a length
    // mismatch, and the length of a shared secret is not the secret.
    return expected.length === actual.length && timingSafeEqual(expected, actual);
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
    let connRole = 'player';
    try {
      const url = new URL(req.url, 'http://localhost');
      roomName = url.searchParams.get('room') || 'default';
      connRole = url.searchParams.get('role') || 'player';
    } catch (e) {
      console.warn('[latency] bad request url:', req.url);
    }
    // Deliberately a HEADER, never a query parameter: nginx logs the full
    // request line (`$request` in the default combined format), so a token in
    // the URL would be written in clear text to the video VM's access log on
    // every connect and every 2s reconnect. Only the Node conductor opens this
    // channel, so there is no browser WebSocket API constraint to work around.
    const connToken = req.headers[CONTROL_TOKEN_HEADER];

    const peerId = randomUUID();

    // Control channel: room discovery only, no participant semantics at all.
    // It gets the current active-room snapshot up front (so a fleet that
    // starts, restarts, or reconnects mid-meeting adopts rooms already in
    // progress) and a `room-active` on every subsequent join.
    if (connRole === 'control') {
      if (!controlTokenAccepted(connToken)) {
        console.warn('[latency] control connection REFUSED (bad or missing token)' +
          (controlToken ? '' : ' — no controlToken configured; set SIDECAR_CONTROL_TOKEN to enable room discovery'));
        send(ws, { type: 'control-denied' });
        ws.close();
        return;
      }
      controlConns.add(ws);
      send(ws, { type: 'welcome', peerId });
      send(ws, { type: 'rooms', rooms: activeRooms() });
      console.log(`[latency] control connection peerId=${peerId}`);
      ws.on('close', () => {
        controlConns.delete(ws);
        console.log(`[latency] control close peerId=${peerId}`);
      });
      ws.on('error', (err) => console.warn('[latency] control socket error:', err.message));
      return;
    }

    const record = {
      peerId,
      ws,
      roomName,
      roomIndex: null,
      // Persistent per-browser identity (humans only); used to reclaim the
      // returning identity's index and to evict its own lingering record.
      stableId: null,
      jitsiId: null,
      displayName: null,
      pattern: '',
      effects: { distortion: false, noise: false, reverb: false },
      playing: false,
      rtt: null,
      jitter: null,
      packetLoss: null,
      jitterBufferMs: null,
      pipelineMs: null,
      rtcRtt: null,
      rtcJitter: null,
      isBot: false,
      // The one bot per room that gathers every participant's audio and streams
      // back the assembled master. Listening clients silence every OTHER peer so
      // the aggregator's mix is the sole audio source (see latency-instrument).
      isAggregator: false,
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
          record.isAggregator = !!msg.isAggregator;
          // The fleet service and observers (e.g. mcp-observer) join the bus
          // for events but are not participants: no index, invisible in
          // rosters, never announced.
          record.isFleet = !!msg.isFleet || connRole === 'observer' || connRole === 'fleet';
          if (record.isBot) {
            record.canEditMetaprogram = false;
            record.canWriteModulation = false;
          }

          // A persistent per-browser identity (localStorage 'trussal:clientId'),
          // sent by humans. ONE stableId = ONE identity — we no longer treat two
          // connections that share one as distinct people (that only happened
          // when testing with incognito tabs, which share localStorage). The
          // aggregator always takes the reserved index, so it neither carries a
          // stableId nor reclaims by one.
          const stableId = typeof msg.stableId === 'string' && msg.stableId ? msg.stableId : null;
          if (!record.isAggregator) record.stableId = stableId;

          const room = getRoom(roomName);

          // Evict any stale entry with the same jitsiId (e.g. a lingering connection
          // from a reconnect or a re-hello on the same socket after displayName change).
          // Broadcast peer-leave first so existing peers remove the old entry.
          // Same jitsiId = same participant session, so the new connection
          // inherits the stale record's roomIndex (indices are immutable for
          // the meeting). A genuine rejoin arrives with a fresh Jitsi id and
          // reclaims its index by stableId below.
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

          // Evict any lingering record of the SAME identity. A real leave→rejoin
          // mints a fresh Jitsi id (so the jitsiId path above can't catch it) and
          // can RACE the old socket's close — the prior record may still be in the
          // room, holding the very index this rejoin wants to reclaim. Since one
          // stableId is one identity, that record is this participant's own dying
          // session: drop it (freeing its index) so the reclaim below succeeds
          // instead of being mistaken for a collision and stranded at a fresh,
          // unlisted index. Iterate a snapshot since we mutate the room.
          if (stableId && !record.isFleet) {
            for (const [otherPeerId, other] of [...room.entries()]) {
              if (otherPeerId !== peerId && other.stableId === stableId) {
                room.delete(otherPeerId);
                broadcast(room, peerId, { type: 'peer-leave', peerId: otherPeerId });
              }
            }
          }

          if (record.roomIndex == null && !record.isFleet) {
            const meta = getRoomMeta(roomName);
            // Identity-stable reclaim, now UNCONDITIONAL: the same-stableId
            // eviction above freed the remembered index, human integer indices are
            // never reassigned to anyone else (nextIndex only climbs), and a bot's
            // suffixed index (0a) is never a bare human integer (0) — so nothing
            // else can legitimately hold what this identity last held. A first-ever
            // join has nothing stored and takes a fresh index.
            const claimed = (!record.isAggregator && stableId) ? meta.indexByStableId.get(stableId) : undefined;
            if (claimed != null) {
              record.roomIndex = claimed;
            } else {
              record.roomIndex = assignRoomIndex(roomName, {
                isBot: record.isBot,
                isAggregator: record.isAggregator,
                ownerIndex: typeof msg.ownerIndex === 'string' ? msg.ownerIndex : null
              });
              if (!record.isAggregator && stableId && !meta.indexByStableId.has(stableId)) {
                meta.indexByStableId.set(stableId, record.roomIndex);
              }
            }
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
          // …and the aggregator's current ring turn, which is only broadcast on
          // change (so a joiner that missed the last change needs the cache).
          // A REST is a turn too — it has no token, so it is recognised by its
          // kind; without that a joiner landing mid-rest would see no outline
          // until the next participant slot.
          if (!record.isFleet && (meta.lastActiveToken != null || meta.lastActiveKind === 'rest')) {
            send(ws, {
              type: 'nc-active',
              token: meta.lastActiveToken,
              index: meta.lastActiveIndex,
              kind: meta.lastActiveKind,
            });
          }
          if (!record.isFleet) {
            broadcast(room, peerId, { type: 'peer-join', peer: publicView(record) });
            logEvent(roomName, 'peer-join', {
              roomIndex: record.roomIndex, isBot: record.isBot, displayName: record.displayName
            });
            // Level-triggered on purpose: announced on EVERY real join, not
            // just the first one into an empty room. A control watcher that
            // reconnected, restarted, or dropped an edge still learns the room
            // exists from the next person through the door, and a watcher that
            // already knows it treats the repeat as a no-op.
            announceRoomActive(roomName);
          }
          break;
        }

        case 'aggregator-claim': {
          // Pre-join gate for aggregator bots. A room may only ever hold ONE
          // aggregator: two of them each solo the other and tap + re-emit the
          // other's master, so both mixes feed back and mute. An aggregator bot
          // asks for the slot BEFORE it launches its browser; if it loses it
          // never joins the meeting at all (it exits). Because the relay handles
          // messages one at a time, this election is race-free — the first claim
          // to arrive wins even if several bots start together.
          //
          // Granted iff no OTHER connection already holds the claim and no
          // aggregator has already joined (its bundle announced isAggregator in
          // the roster). The claim is held by this connection — the probe never
          // sends `hello`, so it is not a roster participant (no ghost) — and is
          // released when the socket closes (see ws.on('close')). The winner
          // keeps the probe open for its lifetime so nothing can claim during the
          // ~seconds between winning and its browser joining.
          const meta = getRoomMeta(roomName);
          const existingRoom = rooms.get(roomName);
          const claimHeldByOther = meta.aggregatorClaimPeerId != null
            && meta.aggregatorClaimPeerId !== peerId;
          const aggregatorJoined = existingRoom
            && [...existingRoom.values()].some(r => r.isAggregator && r.peerId !== peerId);
          const granted = !claimHeldByOther && !aggregatorJoined;
          if (granted) meta.aggregatorClaimPeerId = peerId;
          send(ws, { type: 'aggregator-claim-result', granted });
          logEvent(roomName, 'aggregator-claim', { peerId, granted });
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
          logEvent(roomName, 'fleet-request', { fromIndex: record.roomIndex, action: msg.action, count: msg.count });
          break;
        }

        case 'fleet-status': {
          // Fleet service reports back (spawned counts, ceiling hits, owner
          // teardown). Broadcast so every studio can surface the reason.
          if (!record.isFleet) break;
          const room = rooms.get(roomName);
          if (!room) break;
          broadcast(room, peerId, { ...msg, type: 'fleet-status' });
          logEvent(roomName, 'fleet-status', {
            action: msg.action, ownerIndex: msg.ownerIndex, spawned: msg.spawned,
            removed: msg.removed, reason: msg.reason
          });
          break;
        }

        case 'crdt-update': {
          // Shared metaprogram doc sync. Updates are opaque base64 Yjs
          // payloads; the relay fans them out and keeps the log for late
          // joiners. Bots need permission (granted by their owner):
          // metaprogram edits require canEditMetaprogram, artificial network
          // modulation writes (channel 'modulation') require
          // canWriteModulation. Denied updates are dropped and logged.
          if (typeof msg.update !== 'string' || !msg.update) break;
          const isModulation = msg.channel === 'modulation';
          if (record.isBot && (isModulation ? !record.canWriteModulation : !record.canEditMetaprogram)) {
            console.log(`[latency] dropped ${isModulation ? 'modulation' : 'metaprogram'} crdt-update from unpermissioned bot ${record.roomIndex ?? peerId}`);
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
              channel: isModulation ? 'modulation' : 'metaprogram',
              modality: typeof msg.modality === 'string' ? msg.modality : 'keyboard'
            });
          }
          logEvent(roomName, 'crdt-update', {
            authorIndex: record.roomIndex,
            channel: isModulation ? 'modulation' : 'metaprogram',
            modality: typeof msg.modality === 'string' ? msg.modality : 'keyboard',
            snapshot: !!msg.snapshot,
            updateBytes: msg.update.length
          });
          break;
        }

        case 'nc-active': {
          // Aggregator publishing which participant token is streaming this ring
          // turn, so browsers can outline it in the shared metaprogram editor.
          // Fleet-only (the aggregator owns the ring); relayed to the room as-is.
          // Cached per room (not logged): the aggregator only emits on CHANGE, so
          // with a single static participant it sends once — a late joiner would
          // otherwise never learn the current turn. hello replays the cache.
          if (!record.isFleet) break;
          const token = typeof msg.token === 'string' ? msg.token : null;
          // Ring-slot index — distinguishes repeated tokens so the browser
          // outlines the occurrence actually playing (see nc-active on hello).
          const index = Number.isInteger(msg.index) ? msg.index : null;
          // 'rest': the turn is a written `~` rather than a participant, and
          // `index` addresses the program's rests instead of its participants.
          const kind = msg.kind === 'rest' ? 'rest' : null;
          const ncMeta = getRoomMeta(roomName);
          ncMeta.lastActiveToken = token;
          ncMeta.lastActiveIndex = index;
          ncMeta.lastActiveKind = kind;
          const room = rooms.get(roomName);
          if (room) broadcast(room, peerId, { type: 'nc-active', token, index, kind });
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
          logEvent(roomName, 'bot-permission', {
            fromIndex: record.roomIndex, targetIndex: target.roomIndex,
            canEditMetaprogram: target.canEditMetaprogram, canWriteModulation: target.canWriteModulation
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
          // the WS ping/pong fallback (the signalling leg to this sidecar);
          // packetLoss (0..1), rtcRtt and rtcJitter (ms) come from
          // RTCStatsReport polling of the media path when available.
          //
          // The RTCStats fields are three-state: a number sets, an explicit
          // null CLEARS (the client looked and found nothing), and an absent
          // key leaves the last value alone. Relaying the clear is what stops
          // a peer that has stopped receiving media from pinning the room's
          // worst-case metrics to a reading nothing stands behind.
          if (typeof msg.rtt === 'number') record.rtt = msg.rtt;
          if (typeof msg.jitter === 'number') record.jitter = msg.jitter;
          for (const key of ['packetLoss', 'jitterBufferMs', 'pipelineMs', 'rtcRtt', 'rtcJitter']) {
            if (msg[key] === undefined) continue;
            record[key] = typeof msg[key] === 'number' ? msg[key] : null;
          }
          const room = rooms.get(roomName);
          if (room) broadcast(room, peerId, {
            type: 'peer-update',
            peerId,
            patch: {
              rtt: record.rtt, jitter: record.jitter, packetLoss: record.packetLoss,
              rtcRtt: record.rtcRtt, rtcJitter: record.rtcJitter,
              jitterBufferMs: record.jitterBufferMs,
              pipelineMs: record.pipelineMs
            }
          });
          logEvent(roomName, 'metrics', {
            roomIndex: record.roomIndex,
            rtt: record.rtt, jitter: record.jitter, packetLoss: record.packetLoss,
            rtcRtt: record.rtcRtt, rtcJitter: record.rtcJitter,
            jitterBufferMs: record.jitterBufferMs, pipelineMs: record.pipelineMs
          });
          break;
        }

        case 'research-event': {
          // Client-side research telemetry (scheduler cycle boundaries,
          // health actions, …): appended to the session log, never relayed.
          if (typeof msg.kind !== 'string') break;
          logEvent(roomName, 'research-event', {
            kind: msg.kind, fromIndex: record.roomIndex, data: msg.data ?? null
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
      // Release the aggregator claim if this socket held it, so a replacement
      // aggregator can take the slot. Done before the room cleanup below (which
      // may delete the meta entirely when the room empties).
      const meta = roomMeta.get(roomName);
      if (meta && meta.aggregatorClaimPeerId === peerId) meta.aggregatorClaimPeerId = null;

      const room = rooms.get(roomName);
      if (room && room.has(peerId)) {
        room.delete(peerId);
        if (!record.isFleet) {
          broadcast(room, peerId, { type: 'peer-leave', peerId });
          logEvent(roomName, 'peer-leave', { roomIndex: record.roomIndex });
        }
        if (room.size === 0) {
          rooms.delete(roomName);
          roomMeta.delete(roomName); // meeting over — counters reset with it
        } else if (![...room.values()].some(r => !r.isFleet)) {
          // Only the fleet service is left: the meeting is over even though
          // the room object survives — reset indices and the shared doc.
          roomMeta.delete(roomName);
          // Tell whoever's left (only fleet connections, by this branch's own
          // condition) so it can clear its own bot clusters. Without this, a
          // fleet whose human rejoins fast enough to cancel its own
          // meetingEndGraceMs teardown never learns the room was actually
          // fully vacated in between — old bots (and the old aggregator)
          // would otherwise silently carry over into whatever reuses this
          // room name next, rather than the fresh start a genuinely new
          // meeting should be.
          broadcast(room, null, { type: 'session-reset' });
        }
        // A departed bot needs no counter bookkeeping: cluster suffixes are
        // derived from the live roster (lowestFreeBotOrdinal), so its suffix is
        // simply free again for the owner's next spawn.
      } else if (!room || room.size === 0) {
        // A probe-only connection (an aggregator claim that never became a
        // participant) closing on an empty room: drop the meta it created so an
        // idle room doesn't leak.
        roomMeta.delete(roomName);
      }
      console.log(`[latency] close room=${roomName} peerId=${peerId}`);
    });

    ws.on('error', (err) => {
      console.warn('[latency] socket error:', err.message);
    });
  });

  return { wss, rooms };
}

module.exports = { createLatencyServer, CONTROL_TOKEN_HEADER };

if (require.main === module) {
  console.log('[latency] BOOT: latency WS server starting');
  if (!process.env.SIDECAR_CONTROL_TOKEN) {
    console.warn('[latency] SIDECAR_CONTROL_TOKEN unset — fleet room discovery is DISABLED ' +
      '(no aggregator will spawn). Set it here and FLEET_CONTROL_TOKEN on the conductor.');
  }
  createLatencyServer({
    port: 8081,
    logDir: process.env.SESSION_LOG_DIR || './session-logs',
    controlToken: process.env.SIDECAR_CONTROL_TOKEN || null,
  });
  console.log('[latency] listening on ws://0.0.0.0:8081');
  const { createO2Relay } = require('./o2-relay.js');
  createO2Relay({ port: 8082 });
  console.log('[latency] O2 relay listening on ws://0.0.0.0:8082');
}

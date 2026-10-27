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
const { compileScss } = require('./scss-compile.js');

// Data packs (JSON/CSV/TSV uploads) are relayed to the whole room, so they are
// re-validated here rather than trusted. These ceilings mirror the caps in
// src/data-samples-core.js, which is the authority — a client that respects
// them never notices this code. It exists so a buggy or hostile client cannot
// push an unbounded payload into every other browser in the meeting. The
// duplication is unavoidable: the sidecar is CommonJS in its own package and
// cannot import the bundle's ESM module.
const PACK_MAX_SAMPLES = 64;
const PACK_MAX_VALUES_PER_SAMPLE = 1024;
const PACK_MAX_VALUES_TOTAL = 16384;
const PACK_MAX_PACKS = 32;

// File-attachment patterns (image()/video()/document()/soundFile(), see
// src/file-cycles.js): the 10MB cap the feature spec requires, mirrored from
// src/file-cycles-core.js — the client enforces it too, at upload time, so an
// honest client never notices this check. It exists so a buggy or hostile
// client cannot push an unbounded payload into every other browser in the
// meeting, the same reasoning as sanitizeDataPacks above.
const CHAT_FILE_MAX_BYTES = 10 * 1024 * 1024;
// The kinds src/file-cycles-core.js's FILE_KINDS names (textFile/pdfFile/
// soundFile), plus the older 'document'/'sound' spellings an earlier bundle
// may still send.
const CHAT_FILE_KINDS = new Set(['image', 'video', 'textFile', 'pdfFile', 'soundFile', 'document', 'sound']);

// A backing() file (src/backing-core.js) on its way to the aggregator, which
// plays it. Kept on the room so an aggregator that (re)joins later still gets
// it, so the room's total is capped too: past BACKING_MAX_FILES the oldest
// file is dropped (its author's next reconnect re-sends it if still declared).
const BACKING_KINDS = new Set(['audio', 'video']);
const BACKING_MAX_FILES = 16;

// A meeting prebake (src/meeting-prebake-core.js): the room's whole starting
// setup as one JSON object, kept for the life of the room so every late joiner
// is sent it too. Mirrors PREBAKE_MAX_BYTES there, which the client enforces
// before upload; this is the same ceiling against a buggy or hostile client.
const PREBAKE_MAX_BYTES = 64 * 1024 * 1024;

// The No Code window (src/no-code-core.js): the room's snippet library and
// its shared whiteboard, both kept for the life of the room so a late joiner
// opens the same board. Mirrors NO_CODE_MAX_BYTES there; the board is a tree
// of snippet ids, so it gets a far smaller ceiling.
const NO_CODE_MAX_BYTES = 64 * 1024 * 1024;
const NO_CODE_BOARD_MAX_BYTES = 256 * 1024;

// Decoded byte length of a base64 string, without the cost of actually
// decoding it (cheap enough to check unconditionally on every attachment).
function base64ByteLength(b64) {
  const len = b64.length;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.floor((len * 3) / 4) - padding;
}

// Uploaded emoji (src/custom-emoji-core.js): a name, an image type and its
// base64 bytes, held on the uploader's record so late joiners get them in the
// roster. Mirrors MAX_EMOJI / MAX_EMOJI_BYTES / EMOJI_MIMES there — the client
// scales uploads down to fit, so an honest client never trips these.
const EMOJI_MAX = 64;
const EMOJI_MAX_BYTES = 64 * 1024;
const EMOJI_MIMES = new Set(['image/png', 'image/gif', 'image/webp', 'image/jpeg']);

function sanitizeCustomEmoji(list) {
  if (!Array.isArray(list)) return null;
  const seen = new Set();
  const out = [];
  for (const e of list) {
    if (out.length >= EMOJI_MAX) break;
    if (!e || typeof e.name !== 'string' || !/^[a-z0-9_]{1,32}$/.test(e.name) || seen.has(e.name)) continue;
    if (!EMOJI_MIMES.has(e.mime) || typeof e.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(e.data)) continue;
    if (base64ByteLength(e.data) > EMOJI_MAX_BYTES) continue;
    seen.add(e.name);
    out.push({ name: e.name, mime: e.mime, data: e.data });
  }
  return out;
}

function sanitizeDataPacks(packs) {
  if (!Array.isArray(packs)) return null;
  let budget = PACK_MAX_VALUES_TOTAL;
  const out = [];
  for (const pack of packs.slice(0, PACK_MAX_PACKS)) {
    if (!pack || typeof pack.name !== 'string' || !Array.isArray(pack.samples)) continue;
    const samples = [];
    for (const sample of pack.samples.slice(0, PACK_MAX_SAMPLES)) {
      if (!sample || !Array.isArray(sample.values)) continue;
      const limit = Math.min(PACK_MAX_VALUES_PER_SAMPLE, budget);
      if (limit <= 0) break;
      // Numbers pass through; the only strings a pack may carry are the note
      // names and rests data-samples-core leaves uncast, so anything else is
      // dropped to a number rather than relayed as arbitrary text.
      const values = sample.values.slice(0, limit).map((v) => {
        if (typeof v === 'number' && Number.isFinite(v)) return v;
        if (typeof v === 'string' && /^(~|[a-gA-G](#|b|s|es|is)*-?[0-9]?)$/.test(v)) return v;
        return 0;
      });
      budget -= values.length;
      samples.push({
        label: String(sample.label ?? '').slice(0, 64),
        values,
        truncated: !!sample.truncated
      });
    }
    if (samples.length) {
      out.push({ name: pack.name.slice(0, 64), kind: String(pack.kind ?? '').slice(0, 8), samples });
    }
  }
  return out;
}

// Request header carrying the control channel's shared secret. Lower-case
// because Node normalises incoming header names; the fleet sends the same name
// (see makeWsSidecarConnector in bots/src/orchestrator/fleet-service.js).
const CONTROL_TOKEN_HEADER = 'x-trussal-control-token';

// How long a room's aggregator slot stays reserved for a claim holder whose
// probe connection dropped WITHOUT releasing it (see the 'aggregator-claim'
// handler). The probe is a long-lived socket that sends nothing between
// renewals, so proxies, heartbeats and sidecar restarts routinely close it for
// a moment; releasing the slot on that close is what used to open the window a
// second aggregator slipped through. Renewals (every AGGREGATOR_CLAIM_RENEW_MS
// from the bot) keep the lease alive, an explicit
// 'aggregator-claim-release' frees the slot immediately, and a holder that
// dies outright only holds the room for this long.
const DEFAULT_AGGREGATOR_CLAIM_LEASE_MS = 30000;

function createLatencyServer({ port = 8081, server, logDir = null, controlToken = null, aggregatorClaimLeaseMs = DEFAULT_AGGREGATOR_CLAIM_LEASE_MS } = {}) {
  const wss = server ? new WebSocketServer({ server }) : new WebSocketServer({ port });

  // Dead-peer sweep: a clean disconnect (browser tab close, `docker stop`)
  // fires 'close' and the room-cleanup below runs normally. A connection that
  // dies without a TCP FIN — a bot container hard-killed with `docker rm -f`,
  // or a network drop — leaves the server-side socket registered forever,
  // since nothing else ever notices it's gone: the app-level `ping` message
  // (see the 'ping' case below) is client-initiated RTT telemetry, not a
  // liveness probe, so a dead client simply stops sending it and nothing
  // times out. That peer keeps its roomIndex and keeps taking NetCycles
  // rotation turns indefinitely — reproduced live as bot ghosts still
  // `playing:true` in the roster long after their containers were gone.
  // Standard `ws` heartbeat: ping everyone every 30s, terminate() anyone who
  // didn't pong since the last sweep. terminate() closes the raw socket,
  // which fires the same per-connection 'close' handler as a graceful
  // disconnect, so cleanup (room.delete, peer-leave broadcast, index
  // release) is unchanged.
  const HEARTBEAT_MS = 30000;
  const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      try { ws.ping(); } catch (e) { /* ignore */ }
    }
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(heartbeatInterval));

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
  // Inhabited personal editors (src/inhabit.js): one Yjs doc per HOST token,
  // its update log kept like crdtLog so a guest arriving mid-session catches
  // up. Bounded per doc, per update, and in how many docs one room may hold.
  const EDITOR_LOG_MAX = 200;
  const EDITOR_DOCS_MAX = 256;
  const EDITOR_UPDATE_MAX = 512 * 1024;
  const INHABIT_RELAY_MAX = 256 * 1024;

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
      meta = { nextIndex: 0, indexByStableId: new Map(), crdtLog: [], sessionId: randomUUID(), lastActiveToken: null, lastActiveIndex: null, lastActiveKind: null, prebake: null, noCodeLibrary: null, noCodeBoard: null,
        // `# inhabit` (src/inhabit-core.js): the guest → host map in force —
        // what was reported, less every pair its host's permissionsConfig
        // refuses — which aggregator connection is reporting it (null: none
        // is), and each inhabited editor's CRDT log.
        inhabit: {}, inhabitReported: {}, inhabitReporter: null, editorLogs: new Map() };
      roomMeta.set(name, meta);
    }
    return meta;
  }

  // roomName -> { token, peerId, expiresAt }: the room's single aggregator slot.
  //
  // Deliberately its OWN map, not a field on roomMeta: roomMeta dies whenever a
  // room empties (or becomes fleet-only), and wiping the claim with it let a
  // second aggregator be admitted while the first was still sitting in the
  // Jitsi meeting — its roster record and its probe both hiccup around exactly
  // those transitions. A claim instead outlives room churn and expires only by
  // lease: renewed by re-claims (same token, from the same aggregator's
  // reconnecting probe or its periodic renewals) and freed immediately by an
  // explicit release.
  const roomClaims = new Map();

  // origin roomName -> Set of meeting names meeting() requests from it have
  // named: where to relay its later requests so they reach the people it
  // already moved. Its own map, like roomClaims, because the origin room
  // may well empty out (everyone sent elsewhere) and still need it after.
  const meetingSatellites = new Map();
  const MAX_MEETING_SATELLITES = 32;
  // The last meeting-move stamp handed out: stamps strictly increase, so two
  // requests in the same millisecond still have an order.
  let lastMeetingMoveAt = 0;

  // The room's live aggregator claim, or null once its lease has run out.
  function liveClaim(roomName, now = Date.now()) {
    const claim = roomClaims.get(roomName);
    if (!claim) return null;
    if (claim.expiresAt <= now) {
      logEvent(roomName, 'aggregator-claim-expired', { token: claim.token });
      roomClaims.delete(roomName);
      return null;
    }
    return claim;
  }

  // Expiry sweep so an abandoned room's claim doesn't linger in memory. Claims
  // are also dropped lazily by liveClaim, so this is housekeeping, not a
  // correctness dependency.
  const claimSweep = setInterval(() => {
    const now = Date.now();
    for (const [name, claim] of [...roomClaims.entries()]) {
      if (claim.expiresAt <= now) roomClaims.delete(name);
    }
  }, Math.max(1000, aggregatorClaimLeaseMs));
  if (claimSweep.unref) claimSweep.unref();
  wss.on('close', () => clearInterval(claimSweep));

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

  // --- `# inhabit` -------------------------------------------------------------
  //
  // The map is resolved from the applied metaprogram each cycle by the
  // aggregator (bots/src/bot/aggregator-bot.js) and reported here; with no
  // aggregator in the room, a human browser that may edit the metaprogram
  // reports the program's static map instead (they could have written any
  // `# inhabit` line themselves). The relay never parses the program — it
  // only holds the map, re-validates it with src/inhabit-core.js's rules, and
  // uses it to decide who may talk to whom and with whose permissions.
  const INHABIT_TOKEN_RE = /^\d+(?:z*[a-z])?$/;
  const MAX_INHABIT_PAIRS = 200;
  const INHABIT_GUEST_KINDS = new Set(['chat', 'route', 'join']);
  const INHABIT_HOST_KINDS = new Set(['snapshot']);

  function isInhabitToken(token) {
    return typeof token === 'string' && token.length <= 32 && INHABIT_TOKEN_RE.test(token);
  }

  function sanitizeInhabitMap(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    let n = 0;
    for (const [guest, host] of Object.entries(raw)) {
      if (n >= MAX_INHABIT_PAIRS) break;
      if (!isInhabitToken(guest) || !isInhabitToken(host) || guest === host) continue;
      out[guest] = host;
      n++;
    }
    return out;
  }

  function sameInhabitMap(a, b) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
  }

  function recordByIndex(room, token) {
    if (!room || token == null) return null;
    for (const r of room.values()) {
      if (!r.isFleet && r.roomIndex != null && String(r.roomIndex) === String(token)) return r;
    }
    return null;
  }

  // A guest acts with its HOST's metaprogram permissions for as long as it is
  // inside it: a bot inside a human may edit the program, a human inside a
  // bot may not. Its own grants are untouched and come back when it leaves.
  function permissionsOf(record) {
    return record.effective || {
      canEditMetaprogram: record.canEditMetaprogram,
      canWriteModulation: record.canWriteModulation,
    };
  }

  // Recompute every participant's effective permissions against the room's
  // map, telling the room about each one that changed.
  function refreshInhabitPermissions(roomName) {
    const room = rooms.get(roomName);
    if (!room) return;
    const meta = roomMeta.get(roomName);
    const map = meta ? meta.inhabit : {};
    for (const r of room.values()) {
      if (r.isFleet || r.roomIndex == null) continue;
      const host = recordByIndex(room, map[String(r.roomIndex)]);
      const next = host ? { canEditMetaprogram: host.canEditMetaprogram, canWriteModulation: host.canWriteModulation } : null;
      if (JSON.stringify(next) === JSON.stringify(r.effective || null)) continue;
      r.effective = next;
      broadcast(room, null, { type: 'peer-update', peerId: r.peerId, patch: permissionsOf(r) });
    }
  }

  // --- permissionsConfig (src/permissions-config.js) -----------------------
  //
  // What a participant's own editor says others may do with them, as their
  // browser parsed it from what they announced. Re-validated here: the
  // relay enforces allowInhabitFrom itself and shares the whole config with
  // the room, whose browsers enforce allowClipping.
  function sanitizePermissionsConfig(raw) {
    const out = { allowInhabitFrom: 'all', allowClipping: true };
    if (!raw || typeof raw !== 'object') return out;
    const from = raw.allowInhabitFrom;
    if (from === 'all' || from === 'none') out.allowInhabitFrom = from;
    else if (Array.isArray(from) && from.length <= MAX_INHABIT_PAIRS && from.every((t) => isInhabitToken(t))) {
      out.allowInhabitFrom = [...new Set(from)];
    }
    if (raw.allowClipping === false) out.allowClipping = false;
    return out;
  }

  function allowsInhabitFrom(record, guestToken) {
    const from = record && record.permissionsConfig ? record.permissionsConfig.allowInhabitFrom : 'all';
    if (from === 'all') return true;
    if (from === 'none') return false;
    return Array.isArray(from) && from.includes(guestToken);
  }

  // The reported map less every pair a PRESENT host refuses. A host who is
  // not here takes nobody in anyway; its config is applied when it returns.
  function filterInhabitMap(room, reported) {
    const out = {};
    for (const [guest, host] of Object.entries(reported)) {
      if (allowsInhabitFrom(recordByIndex(room, host), guest)) out[guest] = host;
    }
    return out;
  }

  // Recompute the map in force from the last report, telling the room when
  // it moved: on every report, and whenever a host's config or presence
  // changes what it lets through.
  function applyInhabitMap(roomName) {
    const meta = roomMeta.get(roomName);
    const room = rooms.get(roomName);
    if (!meta) return;
    const map = filterInhabitMap(room, meta.inhabitReported);
    if (sameInhabitMap(meta.inhabit, map)) return;
    meta.inhabit = map;
    if (room) broadcast(room, null, { type: 'inhabit', map });
    refreshInhabitPermissions(roomName);
    logEvent(roomName, 'inhabit', { map, reported: meta.inhabitReported });
  }

  function setInhabitMap(roomName, reported) {
    getRoomMeta(roomName).inhabitReported = reported;
    applyInhabitMap(roomName);
  }

  // May the participant holding `token` read and write `host`'s editor doc?
  // Its owner always; a guest only while the map has it inside that host.
  function mayWriteEditor(meta, token, host) {
    if (token == null) return false;
    const t = String(token);
    return t === host || meta.inhabit[t] === host;
  }

  function publicView(record) {
    return {
      peerId: record.peerId,
      roomIndex: record.roomIndex,
      jitsiId: record.jitsiId,
      displayName: record.displayName,
      pattern: record.pattern,
      compiledCss: record.compiledCss,
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
      videoOn: record.videoOn,
      canEditMetaprogram: permissionsOf(record).canEditMetaprogram,
      canWriteModulation: permissionsOf(record).canWriteModulation,
      dataPacks: record.dataPacks,
      customEmoji: record.customEmoji,
      walkie: record.walkie,
      permissionsConfig: record.permissionsConfig || sanitizePermissionsConfig(null)
    };
  }

  // Walkie Talkie Mode (src/walkie-talkie.js). A human who turns it on stays
  // connected — their socket, their room index and their Jitsi session all
  // survive — but to the rest of the meeting they have LEFT: every ordinary
  // participant (and the aggregator, both its page and its metaprogram bus)
  // is sent a peer-leave and then hears nothing more about them until they
  // turn it off, when a fresh peer-join brings them back with their current
  // record. Other walkie peers still see everything, and so does any bus
  // connection that says `seesWalkie` in its hello (the fleet service): it
  // must keep counting a walkie human as present, because Walkie Talkie Mode
  // is not a reason to end the meeting even when every human is using it.
  // It hears `peer-walkie` instead and decides for itself what "left" means.
  function hiddenFrom(recipient, subject) {
    return !!(subject && subject.walkie && recipient !== subject
      && !recipient.walkie && !recipient.seesWalkie);
  }

  // Room-wide state rather than presence: delivered even when its sender is a
  // walkie peer. A metaprogram edit that skipped some browsers would split the
  // shared doc for good (the sidecar's own crdtLog still records it), and a
  // panic is a safety signal that must always get through.
  const WALKIE_PASSTHROUGH = new Set(['crdt-update', 'panic', 'session-reset']);

  function sendWhere(room, accept, msg) {
    const data = JSON.stringify(msg);
    for (const peer of room.values()) {
      if (!accept(peer) || peer.ws.readyState !== peer.ws.OPEN) continue;
      try { peer.ws.send(data); } catch (e) { /* ignore */ }
    }
  }

  // Who is currently in Walkie Talkie Mode, sent to every participant on each
  // change: walkie peers dial each other from it, and everyone else hides the
  // listed jitsiIds' Jitsi tiles and audio (the Jitsi session itself is still
  // up, so without this their tile would linger after the peer-leave).
  function walkieRosterMessage(room) {
    return {
      type: 'walkie-roster',
      peers: [...room.values()].filter((r) => r.walkie)
        .map((r) => ({ peerId: r.peerId, jitsiId: r.jitsiId, displayName: r.displayName, roomIndex: r.roomIndex })),
    };
  }

  function broadcastWalkieRoster(room) {
    sendWhere(room, (r) => !r.isFleet, walkieRosterMessage(room));
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
    // The peer this message is about — the record a peer-update/-join/-leave
    // names, otherwise its sender — so a walkie peer's traffic stops at the
    // edge of the walkie group (see hiddenFrom).
    const subjectId = msg.peerId ?? (msg.peer && msg.peer.peerId) ?? exceptPeerId;
    const subject = WALKIE_PASSTHROUGH.has(msg.type) ? null : room.get(subjectId);
    for (const peer of room.values()) {
      if (peer.peerId === exceptPeerId) continue;
      if (hiddenFrom(peer, subject)) continue;
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
      // Jitsi's XMPP layer lowercases the MUC room name regardless of the URL's
      // casing, so two people who load /sdA and /sda land in the identical
      // meeting. Lowercasing here is what makes every Map key, the fleet's
      // room-discovery announcements, and every broadcast agree on that same
      // one room — without it, differently-cased URLs to the same meeting
      // silently split into two rosters and two independently-spawned bot
      // clusters fighting over one real conference.
      roomName = (url.searchParams.get('room') || 'default').toLowerCase();
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

    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

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
      // CSS Cycles: the peer's SCSS compiled here and mirrored to the room, so
      // one compile per edit serves every browser.
      compiledCss: '',
      // JSON/CSV/TSV packs this peer has loaded, mirrored to the whole room so
      // a "Weather:3" in anyone's code resolves to the same values on every
      // client and in the aggregator. Held on the record so a late joiner gets
      // them in the roster rather than only hearing about later uploads.
      dataPacks: [],
      // Emoji this peer uploaded, mirrored like dataPacks so a late joiner
      // can draw a :shortcode: someone used before they arrived.
      customEmoji: [],
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
      // Every non-aggregator participant joins with video off; a bot's owner
      // turns its tile on from the studio (remote-control action 'video').
      videoOn: false,
      // Metaprogram permissions. Humans always read+edit; bots default to
      // read-only until their owner grants edit (Phase 8 UI, enforced here).
      canEditMetaprogram: true,
      canWriteModulation: true,
      // Walkie Talkie Mode — see hiddenFrom. `seesWalkie` marks a bus
      // connection (the fleet service) that is told about walkie peers
      // rather than having them hidden from it.
      walkie: false,
      seesWalkie: false
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
          // Only the aggregator's own bus connection asks for backing files;
          // the fleet service and observers have no use for the bytes.
          record.wantsBacking = record.isFleet && !!msg.wantsBacking;
          record.seesWalkie = record.isFleet && !!msg.seesWalkie;
          // A reconnecting walkie peer says so up front, so the room never
          // briefly sees it rejoin before a separate 'walkie' message.
          record.walkie = !record.isBot && !record.isAggregator && !record.isFleet && !!msg.walkie;
          // An aggregator's page carries the claim token its bot won the slot
          // with, so the roster record can be tied back to that claim: the
          // claim gate then tells the aggregator's OWN page (which speaks over
          // this socket, a different connection than its probe) apart from a
          // second aggregator trying to get in. Without it every aggregator in
          // the room looked like a rival to every re-claim the same bot made.
          record.claimToken = (record.isAggregator && typeof msg.claimToken === 'string' && msg.claimToken)
            ? msg.claimToken : null;
          if (record.isBot) {
            record.canEditMetaprogram = false;
            record.canWriteModulation = false;
          }
          // A reconnecting browser's permissionsConfig, so it never spends a
          // moment under the defaults (see 'permissions-config').
          if (msg.permissionsConfig) record.permissionsConfig = sanitizePermissionsConfig(msg.permissionsConfig);

          // Last line of admission control: a page announcing isAggregator while
          // ANOTHER token holds the room's live aggregator claim never becomes a
          // roster participant at all — no index, invisible to the room (and
          // therefore never tapped by the aggregator that does hold the slot, so
          // the two can't feed back into each other). It is told why
          // ('aggregator-slot-taken'), which the bundle turns into a permanent
          // stand-down and its bot into an exit: a duplicate that got this far
          // still leaves the meeting, it just doesn't get to disturb it first.
          // This is the backstop for everything the pre-join claim can't see —
          // a claim that expired between claim and join, a room reset mid-boot,
          // or a fleet that lost its state and spawned a second aggregator.
          if (record.isAggregator && !record.isFleet) {
            const held = liveClaim(roomName);
            if (held && held.token && held.token !== record.claimToken) {
              record.isAggregator = false;
              record.isFleet = true; // invisible: takes no index, appears in no roster
              send(ws, { type: 'aggregator-slot-taken', heldForMs: Math.max(0, held.expiresAt - Date.now()) });
              logEvent(roomName, 'aggregator-join-refused', { jitsiId: record.jitsiId });
            }
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
            .filter(r => r.peerId !== peerId && !r.isFleet && !hiddenFrom(record, r))
            .map(publicView);
          room.set(peerId, record);

          // `you` carries the client's own assigned index (the server never
          // echoes a peer's own record in later broadcasts).
          send(ws, { type: 'roster', peers: roster, you: publicView(record) });
          // Late-joiner catch-up: the full metaprogram doc history. Sent
          // unconditionally (even with an empty log) — the client needs this
          // as a definitive "no history is coming" signal before it may seed
          // a default program; otherwise a client that is briefly its own
          // roster leader can seed into a fresh local doc that a moment
          // later gets a real history merged into it, duplicating every line
          // (see Metaprogrammer.js maybeSeedDefaultProgram).
          const meta = getRoomMeta(roomName);
          send(ws, { type: 'crdt-state', updates: meta.crdtLog.map(e => e.update) });
          // …and the aggregator's current ring turn, which is only broadcast on
          // change (so a joiner that missed the last change needs the cache).
          // A REST is a turn too — it has no token, so it is recognised by its
          // kind; without that a joiner landing mid-rest would see no outline
          // until the next participant slot.
          if (!record.isFleet && (meta.lastActiveToken != null || meta.lastActiveKind === 'rest')) {
            send(ws, {
              type: 'jp-active',
              token: meta.lastActiveToken,
              index: meta.lastActiveIndex,
              kind: meta.lastActiveKind,
            });
          }
          // …and the room's prebake, if one was uploaded: each browser applies
          // its own token's part of it, so a joiner who missed the upload
          // still needs the whole thing.
          // `elapsed` is how long ago it was uploaded, by this server's clock,
          // so the joiner's alternatives rotation lines up with everyone's.
          if (!record.isFleet && meta.prebake) send(ws, { ...meta.prebake, elapsed: Date.now() - meta.prebake.sentAt });
          // …and every backing file the room's performers have declared.
          if (record.wantsBacking && meta.backingFiles) {
            for (const file of meta.backingFiles.values()) send(ws, file);
          }
          // …and the No Code library and board, which every human renders.
          if (!record.isFleet && meta.noCodeLibrary) send(ws, meta.noCodeLibrary);
          if (!record.isFleet && meta.noCodeBoard) send(ws, meta.noCodeBoard);
          if (record.walkie) broadcastWalkieRoster(room);
          else if (!record.isFleet) send(ws, walkieRosterMessage(room));
          // …and the `# inhabit` map in force, which is likewise only sent on
          // change — sent even when empty, so a reconnecting browser drops an
          // inhabitation that ended while it was away. A joiner the map
          // already names (a guest who reloaded) takes up its host's
          // permissions again below.
          if (!record.isFleet) send(ws, { type: 'inhabit', map: meta.inhabit });
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
            applyInhabitMap(roomName);
            refreshInhabitPermissions(roomName);
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
          // The holder is a TOKEN, not this socket. A claim keyed to the socket
          // could not survive the socket: the probe reconnects (proxies,
          // heartbeats, sidecar restarts) as a NEW connection with a new peerId,
          // and the old one's close used to release the slot — so a single blip
          // opened a window a second aggregator could claim through. Worse, the
          // re-claim was answered "denied" by the roster check below (the
          // aggregator's own roster record lives on its SEPARATE page socket, so
          // its peerId never matches the probe's) and ignored by the bot, which
          // left the slot unheld for the rest of a live aggregator's life.
          // Re-presenting the same token therefore RE-HOLDS unconditionally:
          // it is the same aggregator reconnecting, not a rival.
          //
          // Granted iff no other token holds an unexpired lease and no OTHER
          // aggregator has already joined (its bundle announced isAggregator in
          // the roster — a record carrying our own claimToken is us, not a
          // rival). The lease outlives a reconnect gap; an explicit
          // 'aggregator-claim-release' (sent by a stopping bot) frees the slot
          // at once, and a bot that dies without releasing holds it only until
          // the lease runs out. `heldForMs` tells a denied claimant how long
          // that is, so it can wait out a predecessor's stale lease instead of
          // giving the room up for good.
          const now = Date.now();
          const claim = liveClaim(roomName, now);
          const token = typeof msg.token === 'string' && msg.token ? msg.token : null;
          const sameHolder = !!(claim && token && claim.token === token);
          const existingRoom = rooms.get(roomName);
          // A roster record carrying OUR token is our own page (its socket is a
          // different connection, so peerId can't identify it) — never a rival.
          // A tokenless claim exempts nothing: it can't prove anything is itself.
          const otherAggregator = existingRoom
            && [...existingRoom.values()].some(r => r.isAggregator && r.peerId !== peerId && !(token && r.claimToken === token));
          const granted = sameHolder || (!claim && !otherAggregator);
          if (granted) {
            roomClaims.set(roomName, { token, peerId, expiresAt: now + aggregatorClaimLeaseMs });
          }
          send(ws, {
            type: 'aggregator-claim-result',
            granted,
            leaseMs: aggregatorClaimLeaseMs,
            // On a denial: how long the current holder's lease still has to run
            // (0 when the denial came from an already-joined aggregator rather
            // than from a lease).
            heldForMs: granted ? 0 : Math.max(0, (claim ? claim.expiresAt : now) - now),
          });
          logEvent(roomName, 'aggregator-claim', { peerId, granted: !!granted, reheld: sameHolder });
          break;
        }

        case 'aggregator-claim-release': {
          // A stopping aggregator frees its slot at once rather than making a
          // replacement wait out the lease. Only the holder may release: a
          // late release from a bot that already lost the slot must not free
          // whoever holds it now.
          const held = liveClaim(roomName);
          const token = typeof msg.token === 'string' && msg.token ? msg.token : null;
          if (held && ((token && held.token === token) || held.peerId === peerId)) {
            roomClaims.delete(roomName);
            logEvent(roomName, 'aggregator-claim-released', { peerId });
          }
          break;
        }

        case 'sample-file': {
          // One uploaded sample on its way to a performer's bots. Sent only by
          // humans, and forwarded ONLY to the fleet: this is file bytes, and
          // broadcasting a sample library at every participant in the room
          // would cost each of them the whole library for nothing. The fleet
          // caps and stores it (see bots/src/orchestrator/sample-store.js) and
          // reports rejections back as a fleet-status.
          if (record.isBot || record.isFleet) break;
          if (typeof msg.bank !== 'string' || typeof msg.name !== 'string') break;
          if (typeof msg.data !== 'string') break;
          const room = rooms.get(roomName);
          if (!room) break;
          const forward = JSON.stringify({
            type: 'sample-file',
            fromIndex: record.roomIndex,
            bank: msg.bank,
            name: msg.name,
            data: msg.data,
          });
          for (const peer of room.values()) {
            if (!peer.isFleet) continue;
            if (peer.ws.readyState === peer.ws.OPEN) {
              try { peer.ws.send(forward); } catch (e) { /* ignore */ }
            }
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
            targets: msg.targets,
            // The requester's editor text at the moment they asked. The fleet
            // builds their cluster from it and reads their botConfig(...) out
            // of it, so a spawn that loses this field would silently produce
            // generic bots instead of the ones the performer configured.
            code: typeof msg.code === 'string' ? msg.code : undefined,
            // The in-room Conductor panel's request payload (only for
            // conductor-settings-get/set). The fleet accepts only its
            // ROOM_TUNABLE keys and stores them on THIS room alone, so
            // forwarding the object here cannot widen what a participant is
            // allowed to change, nor reach another meeting.
            settings: msg.settings && typeof msg.settings === 'object' && !Array.isArray(msg.settings)
              ? msg.settings
              : undefined,
            requestId: typeof msg.requestId === 'string' ? msg.requestId.slice(0, 64) : undefined
          });
          // The middle of the three botConfig prints (the browser logs what it
          // sent, the fleet logs what it built). This relay is the one hop that
          // can drop `code` — an old bundle omits the field, and only the
          // explicit forward above carries it — so log its size rather than its
          // content: the declaration itself is free text the author may not
          // want in the video VM's logs, and a length is enough to bracket the
          // hop against the browser's own line.
          const codeChars = typeof msg.code === 'string' ? `${msg.code.length} chars` : 'ABSENT';
          console.log(`[latency] fleet-request ${msg.action} from ${record.roomIndex} — code ${codeChars}`);
          logEvent(roomName, 'fleet-request', {
            fromIndex: record.roomIndex, action: msg.action, count: msg.count, codeChars
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
          // A guest is held to its host's permissions (permissionsOf), so a
          // human inside a bot is as restricted as the bot.
          const perms = permissionsOf(record);
          if ((record.isBot || record.effective) && (isModulation ? !perms.canWriteModulation : !perms.canEditMetaprogram)) {
            console.log(`[latency] dropped ${isModulation ? 'modulation' : 'metaprogram'} crdt-update from unpermissioned ${record.effective ? 'guest' : 'bot'} ${record.roomIndex ?? peerId}`);
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

        case 'jp-active': {
          // Aggregator publishing which participant token is streaming this ring
          // turn, so browsers can outline it in the shared metaprogram editor.
          // Fleet-only (the aggregator owns the ring); relayed to the room as-is.
          // Cached per room (not logged): the aggregator only emits on CHANGE, so
          // with a single static participant it sends once — a late joiner would
          // otherwise never learn the current turn. hello replays the cache.
          if (!record.isFleet) break;
          const token = typeof msg.token === 'string' ? msg.token : null;
          // Ring-slot index — distinguishes repeated tokens so the browser
          // outlines the occurrence actually playing (see jp-active on hello).
          const index = Number.isInteger(msg.index) ? msg.index : null;
          // 'rest': the turn is a written `~` rather than a participant, and
          // `index` addresses the program's rests instead of its participants.
          const kind = msg.kind === 'rest' ? 'rest' : null;
          const ncMeta = getRoomMeta(roomName);
          ncMeta.lastActiveToken = token;
          ncMeta.lastActiveIndex = index;
          ncMeta.lastActiveKind = kind;
          const room = rooms.get(roomName);
          if (room) broadcast(room, peerId, { type: 'jp-active', token, index, kind });
          break;
        }

        case 'walkie': {
          const on = !!msg.on;
          if (record.isBot || record.isAggregator || record.isFleet || record.walkie === on) break;
          const room = rooms.get(roomName);
          if (!room || !room.has(peerId)) { record.walkie = on; break; }
          // Exactly the recipients hiddenFrom would screen this peer from
          // once it is walkie — computed while it still isn't.
          const viewers = (r) => r !== record && !r.walkie && !r.seesWalkie;
          if (on) sendWhere(room, viewers, { type: 'peer-leave', peerId });
          record.walkie = on;
          if (!on) sendWhere(room, viewers, { type: 'peer-join', peer: publicView(record) });
          sendWhere(room, (r) => r.seesWalkie, { type: 'peer-walkie', peerId, on });
          broadcastWalkieRoster(room);
          logEvent(roomName, 'walkie', { roomIndex: record.roomIndex, on });
          break;
        }

        case 'walkie-signal': {
          // WebRTC offer/answer/ICE between two walkie peers — relayed point
          // to point, never broadcast, and only inside the walkie group.
          if (!record.walkie || typeof msg.to !== 'string') break;
          const room = rooms.get(roomName);
          const target = room && room.get(msg.to);
          if (!target || !target.walkie || target === record) break;
          if (JSON.stringify(msg.data ?? null).length > 64 * 1024) break;
          send(target.ws, { type: 'walkie-signal', from: peerId, data: msg.data ?? null });
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
          // A bot that is itself inside a host keeps acting with the host's
          // permissions; the grant takes effect when it leaves.
          broadcast(room, null, {
            type: 'peer-update',
            peerId: target.peerId,
            patch: permissionsOf(target)
          });
          // Anyone inhabiting this bot holds its permissions too.
          refreshInhabitPermissions(roomName);
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

        case 'scss': {
          // CSS Cycles: the authoring browser sends SCSS, we compile once and
          // mirror the CSS to the whole room. Peers do NOT trust this output —
          // every receiving browser re-checks it against the guardrails before
          // installing it (see sanitizeCompiledCss), because nothing here can
          // tell an honest client from a patched one.
          if (typeof msg.source !== 'string') break;
          const room = rooms.get(roomName);
          // A bot's own connection never runs the CSS Cycles pipeline (its REPL
          // is a bare @strudel/repl with none of Trussal's controls), so no
          // browser is ever "local" to a bot's peer id — every viewer's own
          // program parrots the bot's css() statements instead and any of them
          // may compile+send on its behalf. Only a peer already recorded as a
          // bot may be targeted this way; a human's compiledCss can only ever
          // come from their own connection.
          let target = record;
          if (typeof msg.targetPeerId === 'string' && msg.targetPeerId !== peerId) {
            const candidate = room && room.get(msg.targetPeerId);
            if (!candidate || !candidate.isBot) break;
            target = candidate;
          }
          const { css, error } = compileScss(msg.source);
          if (error) {
            send(ws, { type: 'scss-error', message: error });
            break;
          }
          target.compiledCss = css;
          // Self case: exclude the sender from the broadcast (they get the
          // direct echo below instead). Bot-target case: the sender has no
          // local record of the bot's compiledCss, so they need the broadcast
          // like every other viewer — nobody is excluded.
          if (room) broadcast(room, target === record ? peerId : null, { type: 'peer-update', peerId: target.peerId, patch: { compiledCss: css } });
          // The author needs it too, but their own roster echo is skipped
          // client-side in favour of the local record, so a peer-update back
          // to the sender would land where nothing reads it.
          if (target === record) send(ws, { type: 'scss-compiled', css });
          break;
        }

        case 'datapacks': {
          const packs = sanitizeDataPacks(msg.packs);
          if (!packs) break;
          record.dataPacks = packs;
          const room = rooms.get(roomName);
          if (room) broadcast(room, peerId, { type: 'peer-update', peerId, patch: { dataPacks: packs } });
          logEvent(roomName, 'datapacks', {
            index: record.roomIndex,
            packs: packs.map(p => ({ name: p.name, kind: p.kind, samples: p.samples.length }))
          });
          break;
        }

        case 'custom-emoji': {
          if (record.isBot || record.isFleet) break;
          const emoji = sanitizeCustomEmoji(msg.emoji);
          if (!emoji) break;
          record.customEmoji = emoji;
          const room = rooms.get(roomName);
          if (room) broadcast(room, peerId, { type: 'peer-update', peerId, patch: { customEmoji: emoji } });
          logEvent(roomName, 'custom-emoji', { index: record.roomIndex, names: emoji.map((e) => e.name) });
          break;
        }

        case 'chat-file': {
          // A performer's image()/video()/document()/soundFile() pattern
          // fired: the bytes travel over the wire exactly once (broadcast,
          // never re-sent on a repeat trigger of the same file — the
          // browser-side cache in file-cycles.js is what makes that true),
          // so every OTHER browser can render the same chat attachment the
          // author's own browser already has locally. Unlike sample-file
          // (fleet-only — a sample library would cost every human nothing
          // and every bot a copy of a library it will never play), a chat
          // attachment's whole point is that everyone in the room sees it.
          if (record.isBot || record.isFleet) break;
          if (typeof msg.name !== 'string' || typeof msg.mime !== 'string' || typeof msg.data !== 'string') break;
          if (!CHAT_FILE_KINDS.has(msg.kind)) break;
          if (base64ByteLength(msg.data) > CHAT_FILE_MAX_BYTES) break;
          const room = rooms.get(roomName);
          if (!room) break;
          broadcast(room, peerId, {
            type: 'chat-file',
            fromIndex: record.roomIndex,
            kind: msg.kind,
            name: msg.name.slice(0, 200),
            mime: msg.mime.slice(0, 100),
            data: msg.data,
            post: !!msg.post,
          });
          logEvent(roomName, 'chat-file', { index: record.roomIndex, kind: msg.kind, name: msg.name, bytes: base64ByteLength(msg.data) });
          break;
        }

        case 'backing-file': {
          // A performer's backing() declaration names a file the aggregator
          // must play (it mixes the file in after the turn gate, which is
          // what lets it sound off-turn). Sent only by humans, forwarded only
          // to connections that asked for it, and kept on the room keyed by
          // (author, filename) so a re-send replaces rather than accumulates.
          if (record.isBot || record.isFleet || record.roomIndex == null) break;
          if (typeof msg.name !== 'string' || typeof msg.mime !== 'string' || typeof msg.data !== 'string') break;
          if (!BACKING_KINDS.has(msg.kind)) break;
          if (base64ByteLength(msg.data) > CHAT_FILE_MAX_BYTES) break;
          const room = rooms.get(roomName);
          if (!room) break;
          const out = {
            type: 'backing-file',
            fromIndex: record.roomIndex,
            kind: msg.kind,
            name: msg.name.slice(0, 200),
            mime: msg.mime.slice(0, 100),
            data: msg.data,
          };
          const meta = getRoomMeta(roomName);
          if (!meta.backingFiles) meta.backingFiles = new Map();
          const key = `${out.fromIndex}\u0000${out.name}`;
          meta.backingFiles.delete(key);
          meta.backingFiles.set(key, out);
          while (meta.backingFiles.size > BACKING_MAX_FILES) {
            meta.backingFiles.delete(meta.backingFiles.keys().next().value);
          }
          for (const peer of room.values()) {
            if (peer.wantsBacking) send(peer.ws, out);
          }
          logEvent(roomName, 'backing-file', { index: record.roomIndex, kind: msg.kind, name: msg.name, bytes: base64ByteLength(msg.data) });
          break;
        }

        case 'prebake': {
          // A human uploaded a meeting prebake. Stored on the room (replacing
          // any earlier one) and sent to EVERYONE, uploader included, so every
          // browser applies the same id — the id is what stops a reconnect
          // from applying the same prebake twice.
          if (record.isBot || record.isFleet) break;
          if (!msg.prebake || typeof msg.prebake !== 'object' || Array.isArray(msg.prebake)) break;
          const bytes = Buffer.byteLength(typeof data === 'string' ? data : data.toString());
          if (bytes > PREBAKE_MAX_BYTES) break;
          const room = rooms.get(roomName);
          if (!room) break;
          const out = { type: 'prebake', id: randomUUID(), fromIndex: record.roomIndex, sentAt: Date.now(), elapsed: 0, prebake: msg.prebake };
          getRoomMeta(roomName).prebake = out;
          // Participants only (bots included — a bot names itself from its
          // own entry); the fleet has no use for the file's bytes.
          for (const peer of room.values()) {
            if (!peer.isFleet) send(peer.ws, out);
          }
          logEvent(roomName, 'prebake', { fromIndex: record.roomIndex, bytes });
          break;
        }

        case 'no-code-library': {
          // A human uploaded snippets into the No Code library. The client
          // merges its upload into the library it holds and sends the whole
          // thing; it replaces the room's copy and goes to everyone, uploader
          // included, so every browser shows the same library.
          if (record.isBot || record.isFleet) break;
          if (!Array.isArray(msg.snippets)) break;
          const bytes = Buffer.byteLength(typeof data === 'string' ? data : data.toString());
          if (bytes > NO_CODE_MAX_BYTES) break;
          const room = rooms.get(roomName);
          if (!room) break;
          const out = { type: 'no-code-library', fromIndex: record.roomIndex, snippets: msg.snippets };
          getRoomMeta(roomName).noCodeLibrary = out;
          for (const peer of room.values()) {
            if (!peer.isFleet) send(peer.ws, out);
          }
          logEvent(roomName, 'no-code-library', { fromIndex: record.roomIndex, count: msg.snippets.length, bytes });
          break;
        }

        case 'no-code-board': {
          // An edit to the shared No Code whiteboard: the whole board, last
          // writer wins. Relayed to everyone else; the editor already has it.
          if (record.isBot || record.isFleet) break;
          if (!msg.board || typeof msg.board !== 'object' || !Array.isArray(msg.board.lines)) break;
          const bytes = Buffer.byteLength(typeof data === 'string' ? data : data.toString());
          if (bytes > NO_CODE_BOARD_MAX_BYTES) break;
          const room = rooms.get(roomName);
          if (!room) break;
          const out = { type: 'no-code-board', fromIndex: record.roomIndex, board: msg.board };
          getRoomMeta(roomName).noCodeBoard = out;
          broadcast(room, peerId, out);
          break;
        }

        case 'no-code-run': {
          // "Run for room": every other human runs the board as it stands in
          // their own browser. Not cached — a late joiner was not asked.
          if (record.isBot || record.isFleet) break;
          if (!Number.isInteger(msg.rev)) break;
          const room = rooms.get(roomName);
          if (!room) break;
          broadcast(room, peerId, { type: 'no-code-run', fromIndex: record.roomIndex, rev: msg.rev });
          logEvent(roomName, 'no-code-run', { fromIndex: record.roomIndex, rev: msg.rev });
          break;
        }

        case 'poll-vote': {
          // A meeting-poll click-to-vote (see src/polls.js): relayed to the
          // whole room so every viewer's tally agrees. No server-side tally
          // is kept here — a late joiner starts from the poll's own seeded
          // votes rather than the room's current live count; see polls.js's
          // doc comment for that accepted limitation.
          if (record.isBot || record.isFleet) break;
          if (typeof msg.pollId !== 'string' || typeof msg.voterToken !== 'string') break;
          if (msg.option != null && typeof msg.option !== 'string') break;
          if (msg.previousOption != null && typeof msg.previousOption !== 'string') break;
          const room = rooms.get(roomName);
          if (!room) break;
          broadcast(room, peerId, {
            type: 'poll-vote',
            pollId: msg.pollId.slice(0, 500),
            option: msg.option ? msg.option.slice(0, 200) : null,
            previousOption: msg.previousOption ? msg.previousOption.slice(0, 200) : null,
            voterToken: msg.voterToken.slice(0, 32),
          });
          break;
        }

        case 'inhabit': {
          // The `# inhabit` guest → host map (see setInhabitMap). The
          // aggregator's metaprogram bus is authoritative; until one reports,
          // a human allowed to edit the metaprogram may.
          const meta = getRoomMeta(roomName);
          if (record.isFleet) {
            meta.inhabitReporter = peerId;
          } else if (record.isBot || record.roomIndex == null || meta.inhabitReporter || !permissionsOf(record).canEditMetaprogram) {
            break;
          }
          setInhabitMap(roomName, sanitizeInhabitMap(msg.map));
          // The reporter acts on the map too (the aggregator mixes guests
          // into hosts' slots), and must act on what is IN FORCE, so it
          // hears the filtered map back even when nothing changed for the
          // room. (Fleet connections get no copy on hello.)
          if (record.isFleet) send(ws, { type: 'inhabit', map: meta.inhabit });
          break;
        }

        case 'permissions-config': {
          // This participant's own permissionsConfig(...) declaration — see
          // sanitizePermissionsConfig. Shared with the room as a peer-update,
          // and applied to the `# inhabit` map at once.
          if (record.isFleet || record.roomIndex == null) break;
          const next = sanitizePermissionsConfig(msg.config);
          if (JSON.stringify(next) === JSON.stringify(record.permissionsConfig || sanitizePermissionsConfig(null))) break;
          record.permissionsConfig = next;
          const room = rooms.get(roomName);
          if (room) broadcast(room, peerId, { type: 'peer-update', peerId, patch: { permissionsConfig: next } });
          applyInhabitMap(roomName);
          logEvent(roomName, 'permissions-config', { roomIndex: record.roomIndex, config: next });
          break;
        }

        case 'inhabit-relay': {
          // Point to point between a guest and its host (src/inhabit.js): the
          // host's snapshot — theme, private chats, devices, routes — down to
          // a guest; a guest's private message, route decision or "send me
          // the snapshot" up to the host. Only a pair the map joins may talk,
          // and only in its own direction, so ending an inhabitation closes
          // the channel with it.
          const room = rooms.get(roomName);
          if (!room || record.isFleet || record.roomIndex == null) break;
          const target = room.get(msg.to);
          if (!target || target.isFleet || target.roomIndex == null) break;
          const map = getRoomMeta(roomName).inhabit;
          const from = String(record.roomIndex);
          const to = String(target.roomIndex);
          const ok = (map[from] === to && INHABIT_GUEST_KINDS.has(msg.kind))
            || (map[to] === from && INHABIT_HOST_KINDS.has(msg.kind));
          if (!ok) break;
          let size = 0;
          try { size = JSON.stringify(msg.data ?? null).length; } catch (e) { break; }
          if (size > INHABIT_RELAY_MAX) break;
          send(target.ws, { type: 'inhabit-relay', from: peerId, fromIndex: record.roomIndex, kind: msg.kind, data: msg.data ?? null });
          break;
        }

        case 'editor-crdt-update': {
          // One edit to an inhabited personal editor (src/inhabit.js): opaque
          // Yjs, like crdt-update, but per HOST and seen only by the host and
          // its current guests — a personal editor is not the room's business.
          const host = typeof msg.host === 'string' ? msg.host : null;
          if (!isInhabitToken(host) || typeof msg.update !== 'string' || !msg.update) break;
          if (msg.update.length > EDITOR_UPDATE_MAX) break;
          const meta = getRoomMeta(roomName);
          if (!mayWriteEditor(meta, record.roomIndex, host)) break;
          let log = meta.editorLogs.get(host);
          if (!log) {
            if (meta.editorLogs.size >= EDITOR_DOCS_MAX) break;
            log = [];
            meta.editorLogs.set(host, log);
          }
          if (msg.snapshot) log.splice(0, log.length, msg.update);
          else {
            log.push(msg.update);
            if (log.length > EDITOR_LOG_MAX) log.shift();
          }
          const room = rooms.get(roomName);
          if (room) {
            sendWhere(room, (r) => r.peerId !== peerId && !r.isFleet && mayWriteEditor(meta, r.roomIndex, host), {
              type: 'editor-crdt-update', host, update: msg.update, authorIndex: record.roomIndex,
            });
          }
          break;
        }

        case 'editor-crdt-sync': {
          // A guest arriving in a host (or the host itself, after a
          // reconnect) asks for the editor doc's history so far.
          const host = typeof msg.host === 'string' ? msg.host : null;
          if (!isInhabitToken(host)) break;
          const meta = getRoomMeta(roomName);
          if (!mayWriteEditor(meta, record.roomIndex, host)) break;
          send(ws, { type: 'editor-crdt-state', host, updates: [...(meta.editorLogs.get(host) || [])] });
          break;
        }

        case 'breakout-request': {
          // A breakout()/assign() voice fired in its author's browser (see
          // src/breakout.js). Relayed to the whole room — the elected
          // moderator browser, wherever it is, is the one that acts.
          if (record.isBot || record.isFleet) break;
          if (msg.fn !== 'breakout' && msg.fn !== 'assign') break;
          const spec = msg.spec;
          if (!spec || typeof spec !== 'object' || typeof spec.name !== 'string') break;
          if (!Array.isArray(spec.participants)) break;
          const room = rooms.get(roomName);
          if (!room) break;
          broadcast(room, peerId, {
            type: 'breakout-request',
            fn: msg.fn,
            fromIndex: record.roomIndex,
            spec: {
              name: spec.name.slice(0, 200),
              participants: spec.participants.slice(0, 200).map((p) => String(p).slice(0, 32)),
            },
          });
          break;
        }

        case 'meeting-move': {
          // A meeting() voice fired in its author's browser (see
          // src/meeting-move.js). Relayed to this room, the target meeting,
          // and every meeting a request from this room has sent people to —
          // which is where anyone it already moved now is. The browsers
          // named move themselves; no moderator is involved. Stamped here,
          // on one clock for every meeting, and sent back to the author too:
          // the stamp is what settles conflicting requests, and the author
          // may have named themselves.
          // A walkie peer has left the meeting as far as the room knows; it
          // does not get to move anyone.
          if (record.isBot || record.isFleet || record.walkie) break;
          const spec = msg.spec;
          if (!spec || typeof spec !== 'object' || typeof spec.name !== 'string') break;
          if (!Array.isArray(spec.participants)) break;
          const name = spec.name.trim().toLowerCase().slice(0, 200);
          if (!name) break;
          const out = {
            type: 'meeting-move',
            fromIndex: record.roomIndex,
            origin: roomName,
            at: (lastMeetingMoveAt = Math.max(Date.now(), lastMeetingMoveAt + 1)),
            spec: {
              name,
              participants: spec.participants.slice(0, 200).map((p) => String(p).slice(0, 32)),
            },
          };
          let satellites = meetingSatellites.get(roomName);
          if (!satellites) meetingSatellites.set(roomName, (satellites = new Set()));
          if (name !== 'main' && name !== roomName && satellites.size < MAX_MEETING_SATELLITES) satellites.add(name);
          for (const target of [roomName, ...satellites]) {
            const room = rooms.get(target);
            if (room) broadcast(room, null, out);
          }
          break;
        }

        case 'panic': {
          // The breakout-room panic button (src/panic-button.js): everyone
          // in the meeting is told, whichever breakout room they are in —
          // this socket is keyed by the URL room, which a breakout move
          // does not change — and so is the home meeting of someone a
          // meeting() pattern moved here.
          if (record.isFleet) break;
          const out = {
            type: 'panic',
            fromIndex: record.roomIndex,
            token: typeof msg.token === 'string' ? msg.token.slice(0, 32) : null,
            displayName: typeof msg.displayName === 'string' ? msg.displayName.slice(0, 200) : (record.displayName || null),
            room: typeof msg.room === 'string' ? msg.room.slice(0, 200) : null,
          };
          const room = rooms.get(roomName);
          if (room) broadcast(room, peerId, out);
          // Over there they knew this participant by their token there.
          const home = typeof msg.homeMeeting === 'string' ? msg.homeMeeting.toLowerCase().slice(0, 200) : null;
          const homeRoom = home && home !== roomName ? rooms.get(home) : null;
          if (homeRoom) {
            broadcast(homeRoom, peerId, { ...out, token: typeof msg.homeToken === 'string' ? msg.homeToken.slice(0, 32) : null });
          }
          logEvent(roomName, 'panic', { fromIndex: record.roomIndex });
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
          //
          // The one exception: a guest inhabiting a human (`# inhabit`) runs
          // the host's editor, so it may send that host a 'pattern' — only
          // that, and only while the map has it inside that host.
          const room = rooms.get(roomName);
          if (!room) break;
          const target = room.get(msg.targetPeerId);
          if (!target) break;
          const inhabitsTarget = record.roomIndex != null && target.roomIndex != null
            && getRoomMeta(roomName).inhabit[String(record.roomIndex)] === String(target.roomIndex);
          if (!target.isBot && !(inhabitsTarget && msg.action === 'pattern')) break;
          if (msg.action === 'pattern' && typeof msg.code === 'string') {
            target.pattern = msg.code;
            send(target.ws, { type: 'remote-control', action: 'pattern', code: target.pattern });
            broadcast(room, target.peerId, { type: 'peer-update', peerId: target.peerId, patch: { pattern: target.pattern } });
          } else if (msg.action === 'mute') {
            target.muted = !!msg.muted;
            send(target.ws, { type: 'remote-control', action: 'mute', muted: target.muted });
            broadcast(room, target.peerId, { type: 'peer-update', peerId: target.peerId, patch: { muted: target.muted } });
          } else if (msg.action === 'video') {
            // Every non-aggregator joins dark; this is how a human turns their
            // own bot's tile on. Like mute, the state lives here so a studio
            // that joins later sees the tile's real state rather than assuming.
            target.videoOn = !!msg.videoOn;
            send(target.ws, { type: 'remote-control', action: 'video', videoOn: target.videoOn });
            broadcast(room, target.peerId, { type: 'peer-update', peerId: target.peerId, patch: { videoOn: target.videoOn } });
          } else if (msg.action === 'stop') {
            // Room-wide ■ Stop reaching a bot's audio (independent of the
            // durable 'mute' toggle above). Transient — relay only, nothing to
            // persist for a late joiner to catch up on.
            send(target.ws, { type: 'remote-control', action: 'stop', stopped: !!msg.stopped });
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
      // The aggregator claim is deliberately NOT released here. The probe is a
      // long-lived socket that routinely drops for a moment (proxy idle
      // timeouts, heartbeats, a sidecar restart) and reconnects as a NEW
      // connection — releasing on close is what used to leave the room's slot
      // unheld, letting a second aggregator in while the first was still in
      // the meeting. The claim now rides a lease instead: it survives the
      // gap, is renewed by the holder's re-claims, and is freed either by an
      // explicit 'aggregator-claim-release' (a stopping bot) or by expiry
      // (see liveClaim) when the holder is truly gone.
      const room = rooms.get(roomName);
      if (room && room.has(peerId)) {
        room.delete(peerId);
        // The aggregator's bus went away: a human may report the static
        // `# inhabit` map again until the next aggregator does.
        const leftMeta = roomMeta.get(roomName);
        if (leftMeta && leftMeta.inhabitReporter === peerId) leftMeta.inhabitReporter = null;
        if (!record.isFleet) {
          broadcast(room, peerId, { type: 'peer-leave', peerId });
          logEvent(roomName, 'peer-leave', { roomIndex: record.roomIndex });
          applyInhabitMap(roomName);
          refreshInhabitPermissions(roomName);
        }
        if (record.walkie) broadcastWalkieRoster(room);
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

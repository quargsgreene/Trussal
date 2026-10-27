// inhabit-core.js — pure logic for the Metaprogram's `# inhabit` method: one
// participant (the GUEST) temporarily takes up residence in another (the
// HOST), seeing and acting through the host's personal editor, private text
// chats, theme, device names and output permissions, breakout room, and place
// in the metaprogram's rotation.
//
//   # inhabit 0 1                 participant 1 inhabits participant 0
//   # inhabit 0 [1 2b]            1 and the bot 2b both inhabit 0
//   # inhabit <0 ~ 3a> 1          1 inhabits 0, is themselves, inhabits bot 3a…
//   # inhabit <0 ~>/4 [1 2]       …one host per four cycles
//
//   $: participants("<0 1 2>").inhabit("<0 ~>", "[1 2b]")   (the mini spelling)
//
// The host is a participant token or a `<…>` alternation of tokens and `~`
// rests, sampled once per cycle (a `/n` glued after the `>` holds each
// element for n cycles); `~` means "nobody — the guests are themselves this
// cycle". The guests are one token or a `[…]` set. Humans and bots are both
// just tokens here, so a human may inhabit a bot and a bot a human. Several
// guests may inhabit one host at once — the host's editor is a shared CRDT
// document every one of them types into (inhabit.js) — but a guest is named
// by at most one `# inhabit` line, so it is never in two hosts at once.
//
// Inhabiting is not transitive: a guest takes on the host's OWN state, even
// when the host is itself inhabiting someone else that cycle.
//
// No DOM, no Jitsi, no Yjs — runs identically in the browser bundle, the
// aggregator bot (which resolves the map each cycle and broadcasts it), and
// under node:test. The sidecar (latency-instrument/server.js, CommonJS)
// re-validates the broadcast map with the same rules as sanitizeInhabitMap.

import { normalizeRooms, locateParticipant, isMainRoomName } from './breakout-core.js';

export const INHABIT_REST = '~';

// The wire caps, shared by the browser relay and mirrored in the sidecar.
export const MAX_INHABIT_PAIRS = 200;
export const MAX_CHAT_MESSAGES = 100;
export const MAX_CHAT_TEXT = 2000;
export const MAX_DEVICE_LABELS = 32;
export const MAX_LABEL = 200;
export const MAX_ROUTE_REQUESTS = 32;

// The same participant-token shape latency-instrument/room-indices.js
// accepts: an integer index, optionally a bot cluster suffix (`2b`, `0za`).
const TOKEN_RE = /^\d+(?:z*[a-z])?$/;

export function isInhabitToken(token) {
  return typeof token === 'string' && token.length <= 32 && TOKEN_RE.test(token);
}

// --- resolving the map -------------------------------------------------------

function floorMod(n, m) {
  return ((n % m) + m) % m;
}

// The host an entry ({ hosts, slow }) names at `cycle`, or null for a rest.
export function hostAtCycle(entry, cycle = 0) {
  const hosts = entry?.hosts || [];
  if (!hosts.length) return null;
  const slow = entry.slow > 0 ? entry.slow : 1;
  const c = Number.isFinite(cycle) ? Math.floor(cycle / slow) : 0;
  const host = hosts[floorMod(c, hosts.length)];
  return host === INHABIT_REST ? null : host;
}

// The parsed `# inhabit` entries ([{ hosts, slow, guests }]) → the plain
// guest → host object in force at `cycle`. A guest whose host comes up as
// itself is skipped rather than made to inhabit itself; the parser already
// refuses a program that writes that, so this only guards hand-built input.
export function resolveInhabitMap(entries, cycle = 0) {
  const map = {};
  for (const entry of entries || []) {
    const host = hostAtCycle(entry, cycle);
    if (!host) continue;
    for (const guest of entry.guests || []) {
      if (guest !== host && !(guest in map)) map[guest] = host;
    }
  }
  return map;
}

// A guest → host object from the wire, cleaned: only valid tokens, no
// self-inhabiting, at most MAX_INHABIT_PAIRS pairs. Never throws.
export function sanitizeInhabitMap(raw) {
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

export function inhabitMapsEqual(a, b) {
  const ka = Object.keys(a || {});
  const kb = Object.keys(b || {});
  if (ka.length !== kb.length) return false;
  return ka.every((k) => b[k] === a[k]);
}

export function hostOf(map, token) {
  if (token == null) return null;
  return (map && map[String(token)]) || null;
}

export function guestsOf(map, token) {
  if (token == null) return [];
  const t = String(token);
  return Object.keys(map || {}).filter((g) => map[g] === t).sort();
}

// The token whose turn on the ring is this participant's turn: the host's,
// while inhabiting one.
export function turnTokenFor(token, map) {
  return hostOf(map, token) ?? (token == null ? null : String(token));
}

// What `token` is doing right now, against the tokens actually present:
//   inhabiting  the host this participant is in, or null
//   hosting     the present guests inhabiting this participant
// A host who has left takes nobody in; a guest who has left is nobody's.
export function inhabitRole(map, token, presentTokens) {
  const present = new Set([...(presentTokens || [])].map(String));
  const host = hostOf(map, token);
  return {
    inhabiting: host && present.has(host) ? host : null,
    hosting: guestsOf(map, token).filter((g) => present.has(g)),
  };
}

// --- the aggregator's ingest -------------------------------------------------

// One ingest batch's [{ token, samples }] (already validated, in the order
// they will be written) → the writes to make, with every guest's samples
// mixed into its host's: a guest is heard in the host's place on the ring,
// and its own slot goes quiet for as long as it is away. The host's entry
// keeps its position; a host with no audio this batch takes the guest's
// position instead. Mixing is a sample-wise sum (interleaved stereo sums
// like mono), clamped back into [-1, 1]; a longer guest extends the result.
export function foldInhabitantSamples(entries, map) {
  const list = (entries || []).filter((e) => e && e.token != null && e.samples);
  const destOf = (token) => hostOf(map, token) ?? String(token);
  // dest token → { at: batch position, own: its own samples, guests: [...] }
  const parts = new Map();
  const ownsSlot = new Set(list.filter((e) => destOf(e.token) === String(e.token)).map((e) => String(e.token)));
  list.forEach((e, i) => {
    const token = String(e.token);
    const dest = destOf(token);
    if (!parts.has(dest)) parts.set(dest, { at: Infinity, own: null, guests: [] });
    const part = parts.get(dest);
    if (dest === token) {
      part.own = e.samples;
      part.at = Math.min(part.at, i);
    } else {
      part.guests.push(e.samples);
      if (!ownsSlot.has(dest)) part.at = Math.min(part.at, i);
    }
  });
  return [...parts.entries()]
    .sort((a, b) => a[1].at - b[1].at)
    .map(([token, { own, guests }]) => {
      if (own && !guests.length) return { token, samples: own };
      const [first, ...rest] = own ? [own, ...guests] : guests;
      return { token, samples: rest.reduce(mixSamples, Float32Array.from(first)) };
    });
}

export function mixSamples(a, b) {
  const n = Math.max(a.length, b.length);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = (i < a.length ? a[i] : 0) + (i < b.length ? b[i] : 0);
    out[i] = v > 1 ? 1 : (v < -1 ? -1 : v);
  }
  return out;
}

// --- room assignment ---------------------------------------------------------

// Where every guest should be: in its host's breakout room. And where every
// guest goes back to: the room it was in before the first inhabit move, once
// it inhabits nobody (or, if that room has since closed, the main room).
//
// `map` is guest → host, `rawRooms` Jitsi's BreakoutRooms._rooms,
// `peersByToken` token → { jitsiId, displayName }, `origins` guest token →
// the room jid it came from (owned by the caller, carried between calls).
// `isExempt(token, peer)` marks a panic-button presser, who is never moved
// again; `expectedRoomOf(participantJid)` is a move already in flight.
// Returns { moves: [{ token, participantJid, roomJid }], origins } — a NEW
// origins map; the one passed in is not touched.
export function planInhabitMoves({
  map, rawRooms, peersByToken, origins = new Map(),
  isExempt = () => false, expectedRoomOf = () => null,
}) {
  const rooms = normalizeRooms(rawRooms);
  const next = new Map(origins);
  const moves = [];
  if (!rooms.length) return { moves, origins: next };
  const main = rooms.find((r) => r.isMainRoom) || null;
  const roomOf = (where) => (expectedRoomOf(where.participantJid) ?? where.room.jid);

  for (const [guest, host] of Object.entries(map || {})) {
    const gPeer = peersByToken.get(guest);
    const hPeer = peersByToken.get(host);
    if (!gPeer || !hPeer) continue;
    if (isExempt(guest, gPeer)) { next.delete(guest); continue; }
    const g = locateParticipant(rooms, gPeer);
    const h = locateParticipant(rooms, hPeer);
    if (!g || !h) continue;
    const target = roomOf(h);
    const at = roomOf(g);
    if (at === target) continue;
    if (!next.has(guest)) next.set(guest, at);
    moves.push({ token: guest, participantJid: g.participantJid, roomJid: target });
  }

  for (const [guest, originJid] of origins) {
    if (map && guest in map) continue;
    const gPeer = peersByToken.get(guest);
    next.delete(guest);
    if (!gPeer || isExempt(guest, gPeer)) continue;
    const g = locateParticipant(rooms, gPeer);
    if (!g) continue;
    const origin = rooms.find((r) => r.jid === originJid) || main;
    if (!origin || roomOf(g) === origin.jid) continue;
    moves.push({ token: guest, participantJid: g.participantJid, roomJid: origin.jid });
  }
  return { moves, origins: next };
}

export { isMainRoomName };

// --- what a host shares with its guests ---------------------------------------

// The theme-context.js keys that are how the page LOOKS — what a guest sees
// through a host's eyes. Disable MediaPipe and Walkie Talkie Mode are left
// out: they switch hardware and presence, which stay the guest's own.
export const INHABIT_THEME_KEYS = ['darkMode', 'disableCss', 'invert', 'primary', 'secondary', 'font', 'fontScale'];

function str(value, max) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

export function sanitizeInhabitTheme(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const key of INHABIT_THEME_KEYS) {
    const v = raw[key];
    if (key === 'fontScale') {
      if (typeof v === 'number' && Number.isFinite(v)) out[key] = v;
      else if (typeof v === 'string' && v.length < 16) out[key] = v;
    } else if (typeof v === 'boolean') {
      out[key] = v;
    } else if (typeof v === 'string' && (key === 'primary' || key === 'secondary' || key === 'font')) {
      out[key] = v.slice(0, 200);
    }
  }
  return out;
}

// One private chat message as Jitsi's redux store holds it (features/chat
// `messages`) → the shape a guest renders, or null for anything that is not
// a private message.
export function privateChatEntry(m) {
  if (!m || typeof m !== 'object' || !m.privateMessage) return null;
  const text = str(m.message, MAX_CHAT_TEXT);
  if (!text) return null;
  const outgoing = m.messageType === 'local';
  return {
    id: str(String(m.messageId ?? m.id ?? `${m.timestamp}-${text.length}`), 100),
    outgoing,
    // The other side of the conversation: who sent it to the host, or who
    // the host (or one of its guests) sent it to. Jitsi keeps only the
    // recipient's NAME on an outgoing message, so the host's browser looks
    // the id up and passes it in as `recipientId`; null when it could not.
    peerId: outgoing ? (m.recipientId == null ? null : str(String(m.recipientId), 100)) : str(m.participantId, 100),
    peerName: str(outgoing ? m.recipient : m.displayName, MAX_LABEL),
    text,
    at: Number.isFinite(m.timestamp) ? m.timestamp : null,
    viaGuest: m.viaGuest == null ? null : str(String(m.viaGuest), 32),
  };
}

function sanitizeChatList(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(-MAX_CHAT_MESSAGES).map((m) => {
    if (!m || typeof m !== 'object') return null;
    const text = str(m.text, MAX_CHAT_TEXT);
    if (!text) return null;
    return {
      id: str(m.id, 100),
      outgoing: !!m.outgoing,
      peerId: m.peerId == null ? null : str(m.peerId, 100),
      peerName: str(m.peerName, MAX_LABEL),
      text,
      at: Number.isFinite(m.at) ? m.at : null,
      viaGuest: m.viaGuest == null ? null : str(String(m.viaGuest), 32),
    };
  }).filter(Boolean);
}

function sanitizeLabels(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map((l) => str(l, MAX_LABEL)).filter(Boolean))].slice(0, MAX_DEVICE_LABELS);
}

function sanitizeRoutes(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_ROUTE_REQUESTS).map((r) => {
    if (!r || typeof r !== 'object' || typeof r.key !== 'string') return null;
    return {
      key: str(r.key, 400),
      author: str(r.author, MAX_LABEL),
      label: str(r.label, MAX_LABEL),
      kind: r.kind === 'screen' ? 'screen' : 'audiooutput',
      media: Array.isArray(r.media) ? r.media.map((m) => str(m, 16)).filter(Boolean).slice(0, 4) : [],
      decision: r.decision === 'allow' || r.decision === 'deny' ? r.decision : null,
    };
  }).filter(Boolean);
}

// The whole snapshot a host's browser sends each of its guests. Every field
// is optional; whatever is missing or malformed is dropped, never thrown on —
// it arrives from another browser and is rendered in this one.
export function sanitizeHostSnapshot(raw) {
  const s = raw && typeof raw === 'object' ? raw : {};
  const fx = s.settings?.effects;
  const effects = fx && typeof fx === 'object' ? {
    distortion: !!fx.distortion, noise: !!fx.noise, reverb: !!fx.reverb,
  } : null;
  return {
    displayName: str(s.displayName, MAX_LABEL),
    isBot: !!s.isBot,
    theme: sanitizeInhabitTheme(s.theme),
    chats: sanitizeChatList(s.chats),
    devices: {
      audio: sanitizeLabels(s.devices?.audio),
      screens: sanitizeLabels(s.devices?.screens),
    },
    routes: sanitizeRoutes(s.routes),
    room: s.room == null ? null : str(s.room, MAX_LABEL),
    // The host has seeded its editor doc: a guest may start typing into it.
    editorReady: !!s.editorReady,
    settings: { effects, language: str(s.settings?.language, 32) || null },
  };
}

// The relay message kinds a guest and its host exchange through the sidecar
// (inhabit-relay). The sidecar refuses any other kind and any pair the
// current map does not join. Running the host's editor is not one of them:
// that is a remote-control 'pattern', which the sidecar allows a guest.
export const GUEST_TO_HOST = ['chat', 'route', 'join'];
export const HOST_TO_GUEST = ['snapshot'];

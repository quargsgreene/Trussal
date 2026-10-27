// Breakout-room patterns — Strudel patterns that drive Jitsi's OWN native
// breakout rooms (lib-jitsi-meet's BreakoutRooms: createBreakoutRoom /
// sendParticipantToRoom, backed by Prosody's mod_muc_breakout_rooms, already
// enabled in docker-jitsi-meet/prosody/rootfs/defaults/conf.d/jitsi-meet.cfg.lua):
//
//   $: breakout({"name":"room", "participants": ["0", "1", "2b"]})
//   $: breakout({"name":"<room main>", "participants": ["1"]}).slow(8)
//
// See breakout-core.js for the literal, the rewrite, and what each call does.
//
// AUTHORED LOCALLY, EXECUTED BY ONE MODERATOR. Every browser evaluates every
// peer's program (see strudel.js), so — like reaction() — buildPeerBlock
// keeps breakout()/assign() only in the author's own browser and strips it
// from everyone else's copy; a request fires once, from its author. But
// Jitsi only lets a MODERATOR create rooms or move anyone (even themselves),
// and the author is often not one. So a fired request goes over the sidecar
// to the whole meeting (the sidecar room is keyed by the URL, which a
// breakout move does not change), and exactly one browser acts on it: the
// main-room moderator with the lowest endpoint id (isExecutor). No moderator
// present means nothing moves — the same as Jitsi's own breakout panel.
//
// SILENT BY CONSTRUCTION, same mechanism as every other capability here — the
// renderer carries a dominant onTrigger.
//
// This module also decides when the panic button (panic-button.js) shows:
// only while THIS participant is being moved around — in a breakout room, or
// moved within the last PANIC_LINGER_MS. Pressing it tells the whole room,
// and every executor stops moving that participant for the rest of its
// session.

import {
  getAllPeers, getLocalPeer, isPeerJPatternTurn, getInhabitMap,
  sendBreakoutRequest, sendPanic, subscribePeerState,
} from './peer-state.js';
import { planInhabitMoves } from './inhabit-core.js';
import {
  parseBreakoutLiteral, normalizeRooms, planBreakout, shouldShowPanic,
} from './breakout-core.js';
import { onPanic, setPanicVisible } from './panic-button.js';
import { getHomeMeeting } from './meeting-move.js';
import { silentRenderer } from './multimedia-core.js';

// --- Jitsi access ------------------------------------------------------------

// The live JitsiConference. Jitsi replaces it on every breakout move, so it
// is looked up fresh on every use rather than held.
function conference() {
  if (typeof window === 'undefined') return null;
  try {
    const fromStore = window.APP?.store?.getState?.()['features/base/conference']?.conference;
    if (fromStore) return fromStore;
  } catch (e) { /* fall through */ }
  return window.APP?.conference?._room || null;
}

function breakoutApi() {
  const conf = conference();
  try {
    const api = conf && typeof conf.getBreakoutRooms === 'function' ? conf.getBreakoutRooms() : null;
    return api && api.isSupported() ? api : null;
  } catch (e) {
    return null;
  }
}

// BreakoutRooms has no public getter for its room map; `_rooms` is the field
// its own UPDATE handler keeps current (and only a moderator receives those
// updates — which is also the only browser that reads it here).
function currentRooms(api) {
  return normalizeRooms(api?._rooms);
}

// The one browser that carries out requests: a moderator, in the main room,
// with the lowest endpoint id among that room's moderators — so two
// moderators never both create the same room before Jitsi reports it.
function isExecutor() {
  const conf = conference();
  const api = breakoutApi();
  if (!conf || !api || api.isBreakoutRoom()) return false;
  try {
    if (!conf.isModerator()) return false;
    const me = conf.myUserId();
    return !conf.getParticipants().some((p) => !p.isHidden?.()
      && p.getRole?.() === 'moderator' && String(p.getId()) < String(me));
  } catch (e) {
    return false;
  }
}

// --- executing requests ------------------------------------------------------

// Participants who pressed the panic button, by token and by display name
// (a rejoin may hand them a new token) — never moved again by this browser.
const exemptTokens = new Set();
const exemptNames = new Set();
const isExempt = (token, peer) => exemptTokens.has(String(token))
  || (!!peer?.displayName && exemptNames.has(peer.displayName));

// Room names asked for, and where each move just sent should land, with
// when — Jitsi reports the result asynchronously (a move takes seconds: the
// participant's client leaves one MUC and joins another), and a voice under
// .fast() re-fires well before it does. Tracking the DESTINATION rather than
// each move means a pattern going back and forth is never mistaken for a
// repeat: "back to main" right after "into room" is a new move, while
// "into room" re-fired before Jitsi catches up is not.
const IN_FLIGHT_MS = 5000;
const pendingCreates = new Map(); // room name -> ms
const expectedRooms = new Map();  // participantJid -> { roomJid, at }

function expectedRoomOf(participantJid) {
  const entry = expectedRooms.get(participantJid);
  return entry && Date.now() - entry.at < IN_FLIGHT_MS ? entry.roomJid : null;
}

const RETRY_MS = 500;
const MAX_RETRIES = 20;

function peersByToken() {
  const map = new Map();
  for (const peer of getAllPeers()) {
    if (peer.roomIndex == null || peer.roomIndex === '') continue;
    map.set(String(peer.roomIndex), { jitsiId: peer.jitsiId, displayName: peer.displayName });
  }
  return map;
}

function fresh(map, key, now) {
  const at = map.get(key);
  return at != null && now - at < IN_FLIGHT_MS;
}

function executeRequest(request, attempt = 0) {
  if (!isExecutor()) return;
  const api = breakoutApi();
  const plan = planBreakout(request, currentRooms(api), peersByToken(), { isExempt, expectedRoomOf });
  if (plan.error) {
    console.warn(`[breakout] ${plan.error}`);
    return;
  }
  const now = Date.now();
  if (plan.create && !fresh(pendingCreates, plan.create, now)) {
    pendingCreates.set(plan.create, now);
    try { api.createBreakoutRoom(plan.create); } catch (e) { console.warn('[breakout] createBreakoutRoom failed', e); }
  }
  for (const move of plan.moves) {
    expectedRooms.set(move.participantJid, { roomJid: move.roomJid, at: now });
    try { api.sendParticipantToRoom(move.participantJid, move.roomJid); } catch (e) { console.warn('[breakout] sendParticipantToRoom failed', e); }
  }
  // createBreakoutRoom is fire-and-forget over XMPP: come back for the
  // participants once Jitsi reports the new room.
  if (plan.waiting && attempt < MAX_RETRIES) {
    setTimeout(() => executeRequest(request, attempt + 1), RETRY_MS);
  }
}

// --- `# inhabit` room assignment ----------------------------------------------
//
// A guest lives in its host's breakout room for as long as it inhabits it,
// and goes back to the room it came from afterwards (see inhabit-core.js's
// planInhabitMoves). Carried out by the same executor as breakout requests,
// on every inhabit map change and every watcher tick — so a guest follows a
// host that a breakout() pattern moves. A breakout() naming a guest is
// undone on the next tick: while inside a host, the host's room wins.

let inhabitOrigins = new Map(); // guest token -> room jid it came from

function executeInhabitMoves() {
  const map = getInhabitMap();
  if (!Object.keys(map).length && !inhabitOrigins.size) return;
  if (!isExecutor()) return;
  const api = breakoutApi();
  const { moves, origins } = planInhabitMoves({
    map, rawRooms: api?._rooms, peersByToken: peersByToken(), origins: inhabitOrigins, isExempt, expectedRoomOf,
  });
  inhabitOrigins = origins;
  const now = Date.now();
  for (const move of moves) {
    expectedRooms.set(move.participantJid, { roomJid: move.roomJid, at: now });
    try { api.sendParticipantToRoom(move.participantJid, move.roomJid); } catch (e) { console.warn('[breakout] inhabit move failed', e); }
  }
}

subscribePeerState((event, payload) => {
  if (event === 'inhabit') {
    executeInhabitMoves();
  } else if (event === 'breakout-request') {
    try {
      executeRequest({ fn: payload.fn, spec: parseBreakoutLiteral(payload.spec, payload.fn) });
    } catch (e) {
      console.warn('[breakout] ignoring malformed request', e.message);
    }
  } else if (event === 'panic') {
    if (payload.token) exemptTokens.add(payload.token);
    if (payload.displayName) exemptNames.add(payload.displayName);
    showPanicNotice(payload);
  }
});

// --- the pattern voice -------------------------------------------------------

let atoms = {}; // token -> { text, fn, peer }

export function setBreakoutAtoms(table) { atoms = table || {}; }

// The same request re-fired faster than this is the same request — the
// author's .fast() should not flood the sidecar.
const RESEND_MS = 250;
const lastSentAt = new Map();

function fire(fn, value) {
  const atom = atoms[String(value)];
  let spec;
  try {
    spec = parseBreakoutLiteral(atom ? atom.text : value, fn);
  } catch (e) {
    console.error('[breakout]', e.message);
    return;
  }
  const key = `${fn}\n${JSON.stringify(spec)}`;
  const now = Date.now();
  if (now - (lastSentAt.get(key) || 0) < RESEND_MS) return;
  lastSentAt.set(key, now);
  sendBreakoutRequest({ fn, spec });
  // The sidecar does not echo a message to its sender, and the author may
  // well be the executor.
  executeRequest({ fn, spec });
}

function handleTrigger(hap, currentTime, cps, targetTime) {
  const value = hap?.value;
  if (!value || (value.breakout == null && value.assign == null)) return;
  const lead = Number(targetTime) - Number(currentTime);
  const delayMs = Number.isFinite(lead) ? Math.max(0, lead * 1000) : 0;
  setTimeout(() => {
    if (!isPeerJPatternTurn(getLocalPeer()?.jitsiId)) return;
    // breakout() before assign(): a chain naming both creates the room first.
    if (value.breakout != null) fire('breakout', value.breakout);
    if (value.assign != null) fire('assign', value.assign);
  }, delayMs);
}

// Called once from ensureStrudel after initStrudel. Registers breakout()/
// assign() and the renderer, and returns the names to merge into evalScope.
export function installBreakout(mod) {
  const { registerControl, register } = mod;
  const scope = {
    ...registerControl('breakout'),
    ...registerControl('assign'),
  };
  register('_bkRender', silentRenderer(handleTrigger, 'breakout'));
  return scope;
}

export function stopBreakout() {
  lastSentAt.clear();
}

// --- panic button ------------------------------------------------------------

const NOTICES_ID = 'trussal-panic-notices';
const NOTICE_MS = 8000;

function showPanicNotice({ displayName, fromIndex }) {
  if (typeof document === 'undefined' || !document.body) return;
  let box = document.getElementById(NOTICES_ID);
  if (!box) {
    box = document.createElement('div');
    box.id = NOTICES_ID;
    box.setAttribute('role', 'status');
    box.setAttribute('aria-live', 'assertive');
    document.body.appendChild(box);
  }
  const who = displayName || (fromIndex != null ? `Participant ${fromIndex}` : 'A participant');
  const notice = document.createElement('div');
  notice.className = 'panic-notice';
  notice.textContent = `${who} pressed the panic button and is rejoining the main room. Breakout and meeting patterns will no longer move them.`;
  box.appendChild(notice);
  setTimeout(() => notice.remove(), NOTICE_MS);
}

// Where this participant is, polled: Jitsi tears the conference down and
// rebuilds it on a move, so there is no single object to hold a listener on
// (participants.js polls for the same reason). A tick with no conference is
// the gap in the middle of a move, not a move itself.
const WATCH_MS = 1000;
let lastRoomJid = null;
let lastMoveAt = null;
let inBreakout = false;
let currentRoomName = null;

function watchTick() {
  const conf = conference();
  const roomJid = conf?.room?.roomjid || null;
  if (roomJid) {
    if (lastRoomJid && roomJid !== lastRoomJid) lastMoveAt = Date.now();
    lastRoomJid = roomJid;
    const api = breakoutApi();
    inBreakout = !!api && api.isBreakoutRoom();
    try { currentRoomName = inBreakout ? (conf.getSubject?.() || null) : null; } catch (e) { currentRoomName = null; }
  }
  setPanicVisible(shouldShowPanic({ inBreakout, lastMoveAt }));
  executeInhabitMoves();
}

// The breakout room this participant is in, by name (null in the main
// room) — what inhabit.js tells a guest about where its host is.
export function getCurrentRoomName() { return currentRoomName; }

let watching = false;

export function startBreakoutWatcher() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  setInterval(watchTick, WATCH_MS);
  onPanic(() => {
    const me = getLocalPeer();
    sendPanic({
      token: me?.roomIndex != null ? String(me.roomIndex) : null,
      displayName: me?.displayName || null,
      room: currentRoomName,
      home: getHomeMeeting(),
    });
  });
}

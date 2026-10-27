// Meeting-move patterns — the breakout() counterpart (see breakout.js) that
// sends participants to a different Jitsi meeting on the same server:
//
//   $: meeting({"name":"jam2", "participants": ["0", "1", "2b"]})
//   $: meeting({"name":"<jam2 main>", "participants": ["1"]}).slow(8)
//
// See meeting-move-core.js for the literal, the rewrite, and the planner.
//
// AUTHORED LOCALLY, EXECUTED BY EACH PARTICIPANT NAMED. Like breakout(),
// buildPeerBlock keeps meeting() only in the author's own browser, so a
// request fires once, from its author, and goes over the sidecar. But no
// moderator is needed to leave one meeting for another: every browser that
// receives the request checks whether it is named and, if so, navigates
// itself to the other meeting's URL — a full page load, which is why
// stable-state's localStorage program and the sidecar's stable-id token
// reclaim matter here: both come back with the participant.
//
// What has to survive that page load lives in sessionStorage (per tab, like
// panic-button.js's entry URL): the participant's home meeting and token
// there, when they last moved, the sidecar stamp of the last request they
// obeyed, and whether they pressed the panic button.
//
// Every request — the author's own included — comes back through the
// sidecar, which stamps it; that stamp is what settles conflicting
// assignments (see meeting-move-core.js).
//
// SILENT BY CONSTRUCTION — the renderer carries a dominant onTrigger.

import {
  getLocalPeer, isPeerJPatternTurn, sendMeetingMove, subscribePeerState,
} from './peer-state.js';
import { getCurrentRoom } from './stable-state.js';
import {
  parseMeetingLiteral, planMeetingMove, matchHome, isNewer, meetingUrl, COLLECT_MS,
} from './meeting-move-core.js';
import { shouldShowPanic } from './breakout-core.js';
import { onPanic, setPanicVisible } from './panic-button.js';
import { silentRenderer } from './multimedia-core.js';

// --- per-tab state -----------------------------------------------------------

const KEY = 'trussal-meeting-move';

// { home: { meeting, token } | null, movedAt: ms | null, lastAt: stamp |
// null, exempt: bool }
function readState() {
  try {
    const raw = typeof sessionStorage !== 'undefined' ? sessionStorage.getItem(KEY) : null;
    const s = raw ? JSON.parse(raw) : null;
    if (s && typeof s === 'object') {
      return { home: s.home || null, movedAt: s.movedAt ?? null, lastAt: s.lastAt ?? null, exempt: !!s.exempt };
    }
  } catch (e) { /* fall through */ }
  return { home: null, movedAt: null, lastAt: null, exempt: false };
}

function writeState(patch) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ...readState(), ...patch }));
  } catch (e) {
    // No sessionStorage: a moved participant just forgets its home, so only
    // patterns in the meeting it is in can move it again.
  }
}

// Where a meeting() pattern last moved this participant from, and its token
// there — breakout.js passes it along with a panic.
export function getHomeMeeting() {
  const { home } = readState();
  return home && home.meeting !== getCurrentRoom() ? home : null;
}

// --- executing requests ------------------------------------------------------

function currentSelf() {
  const meeting = getCurrentRoom();
  if (!meeting) return null;
  const me = getLocalPeer();
  const state = readState();
  return {
    meeting,
    token: me?.roomIndex != null && me.roomIndex !== '' ? String(me.roomIndex) : null,
    home: state.home,
    exempt: state.exempt,
    arrivedAt: state.movedAt,
    lastAt: state.lastAt,
  };
}

// The newest request naming this browser that it has not acted on yet, and
// the timer that will act on it — after COLLECT_MS, or once it has settled in.
let pending = null;
let pendingTimer = null;

function schedule(ms) {
  clearTimeout(pendingTimer);
  pendingTimer = setTimeout(act, Math.max(0, ms));
}

function act() {
  pendingTimer = null;
  const request = pending;
  const self = currentSelf();
  if (!request || !self) return;
  const plan = planMeetingMove(request, self);
  if (plan.retryAt != null) { schedule(plan.retryAt - Date.now()); return; }
  pending = null;
  if (!plan.move) {
    // Obeyed even when that means staying put: an older request still in
    // flight must not override it.
    if (plan.why && isNewer(request, self.lastAt)) writeState({ lastAt: request.at });
    return;
  }
  writeState({ home: plan.home, movedAt: Date.now(), lastAt: request.at });
  window.location.href = meetingUrl(window.location.href, plan.move);
}

function handleRequest(request) {
  const self = currentSelf();
  if (!self || !matchHome(request, self)) return;
  if (!isNewer(request, pending ?? self.lastAt)) return;
  pending = request;
  schedule(COLLECT_MS);
}

subscribePeerState((event, payload) => {
  if (event !== 'meeting-move') return;
  try {
    handleRequest({ spec: parseMeetingLiteral(payload.spec), origin: payload.origin, at: payload.at });
  } catch (e) {
    console.warn('[meeting] ignoring malformed request', e.message);
  }
});

// --- the pattern voice -------------------------------------------------------

let atoms = {}; // token -> { text, fn, peer }

export function setMeetingAtoms(table) { atoms = table || {}; }

// The same request re-fired faster than this is the same request — the
// author's .fast() should not flood the sidecar.
const RESEND_MS = 250;
const lastSentAt = new Map();

function fire(value) {
  const atom = atoms[String(value)];
  let spec;
  try {
    spec = parseMeetingLiteral(atom ? atom.text : value);
  } catch (e) {
    console.error('[meeting]', e.message);
    return;
  }
  const key = JSON.stringify(spec);
  const now = Date.now();
  if (now - (lastSentAt.get(key) || 0) < RESEND_MS) return;
  lastSentAt.set(key, now);
  // Comes back stamped, like everyone else's, if the author named themselves.
  sendMeetingMove({ spec });
}

function handleTrigger(hap, currentTime, cps, targetTime) {
  const value = hap?.value;
  if (!value || value.meeting == null) return;
  const lead = Number(targetTime) - Number(currentTime);
  const delayMs = Number.isFinite(lead) ? Math.max(0, lead * 1000) : 0;
  setTimeout(() => {
    if (!isPeerJPatternTurn(getLocalPeer()?.jitsiId)) return;
    fire(value.meeting);
  }, delayMs);
}

// Called once from ensureStrudel after initStrudel. Registers meeting() and
// the renderer, and returns the names to merge into evalScope.
export function installMeetingMove(mod) {
  const { registerControl, register } = mod;
  const scope = { ...registerControl('meeting') };
  register('_mtRender', silentRenderer(handleTrigger, 'meeting'));
  return scope;
}

export function stopMeetingMove() {
  lastSentAt.clear();
}

// --- panic button ------------------------------------------------------------

// Up while this participant is away from its home meeting, and for
// PANIC_LINGER_MS after any move. Pressing it (panic-button.js rejoins the
// meeting this tab first joined) exempts this tab from meeting() moves for
// good; breakout.js's handler tells the room and the home meeting.
const WATCH_MS = 1000;
let watching = false;

function watchTick() {
  const state = readState();
  const away = !!getHomeMeeting();
  setPanicVisible(shouldShowPanic({ inBreakout: away, lastMoveAt: state.movedAt }), 'meeting');
}

export function startMeetingMoveWatcher() {
  if (watching || typeof window === 'undefined') return;
  watching = true;
  setInterval(watchTick, WATCH_MS);
  // Clearing movedAt too: the rejoin is not a move, and an exempt
  // participant has no further use for the button.
  onPanic(() => writeState({ exempt: true, movedAt: null }));
}

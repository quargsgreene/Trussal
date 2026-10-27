// meeting-move-core.js — pure logic for meeting-move patterns: the breakout()
// counterpart that sends participants to a different Jitsi MEETING (another
// URL on the same server) instead of a breakout room inside this one.
//
// No DOM, no Strudel, no Jitsi — runs identically in the browser bundle and
// under node:test. The browser glue (the sidecar relay, navigation, the
// panic button) lives in meeting-move.js.
//
//   $: meeting({"name":"jam2", "participants": ["0", "1", "2b"]})
//   $: meeting({"name":"<jam2 main>", "participants": ["2b"]}).slow(8)
//
// meeting() moves the listed participants to the named meeting — Jitsi makes
// a meeting the moment someone joins it, so there is no create step and no
// assign() counterpart. "main" is the author's own meeting, the one the
// pattern is running in. A participant already in the target meeting is not
// moved, so a voice that fires every cycle settles after one move — until
// the pattern names a different meeting.
//
// The "name" may be a mini-notation pattern of meeting names, exactly as in
// breakout() (see breakout-core.js): `"<jam2 main>"` alternates every cycle,
// `"<jam2 ~>"` moves on the first cycle and rests on the next. Meeting names
// are URL path segments, so unlike room names they cannot contain a space,
// `/`, `?`, `#`, `%` or a backslash; Jitsi lowercases them, and so does this.
//
// HOW A MOVE HAPPENS. Unlike a breakout room, leaving for another meeting
// needs no moderator: the participant's OWN browser navigates to the other
// meeting's URL. So a fired request goes over the sidecar to everyone, and
// each browser decides for itself (planMeetingMove) whether it is named.
//
// HOW A PATTERN REACHES SOMEONE IT ALREADY MOVED. Once moved, a participant
// is in another meeting's sidecar room and holds another token there. So the
// sidecar also relays a meeting() request to every meeting that requests from
// the same origin have sent people to, and a moved browser remembers its
// HOME — the origin meeting and the token it held there — so `"<jam2 main>"`
// can bring it back and send it out again. A move requested from a different
// meeting replaces that home.
//
// CONFLICTING ASSIGNMENTS — two voices, or two authors in different meetings,
// naming the same participant for different meetings — are settled by
// timestamp: the sidecar stamps every request as it relays it (one clock for
// everyone, strictly increasing), and a browser obeys only the newest
// request naming it. It remembers the stamp of the last one it obeyed across
// the move, so an older request still in flight cannot pull it back.

import { isMainRoomName, isRoomPattern, rewriteSpecCalls } from './breakout-core.js';
import { skipPrejoin } from './skip-prejoin.js';

// The name meeting() uses for the author's own meeting.
export const MAIN_MEETING = 'main';
export const isMainMeetingName = isMainRoomName;

export const MEETING_CALL_RE = /(?:^|[^\w$])meeting\s*\(/;

const MEETING_NAME_RE = /^[^\s/?#%\\]+$/;

// How long after arriving in a meeting a browser holds off on further moves.
// A move is a full page load and Jitsi rejoin; a pattern under .fast() must
// not bounce someone between meetings faster than they can actually join
// one. The newest request that arrives meanwhile is kept and carried out
// once this has passed.
export const SETTLE_MS = 8000;

// How long a browser named by one request waits for others before acting,
// so requests fired together (two voices in one cycle) are settled by stamp
// rather than by which happened to arrive first.
export const COLLECT_MS = 250;

// --- literal parsing ---------------------------------------------------------

export function validateMeetingLiteral(obj, fn = 'meeting') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${fn}(): expected a JSON object with "name"`);
  }
  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    throw new Error(`${fn}(): "name" must be a non-empty string`);
  }
  const name = obj.name.trim();
  // A pattern is checked one meeting at a time, once each is minted.
  if (!isRoomPattern(name) && !MEETING_NAME_RE.test(name)) {
    throw new Error(`${fn}(): "${name}" is not a meeting name — no spaces, /, ?, #, % or \\`);
  }
  const participants = obj.participants == null ? [] : obj.participants;
  if (!Array.isArray(participants) || participants.some((p) => typeof p !== 'string' && typeof p !== 'number')) {
    throw new Error(`${fn}(): "participants" must be an array of participant tokens`);
  }
  return {
    name: isRoomPattern(name) ? name : name.toLowerCase(),
    participants: [...new Set(participants.map((p) => String(p).trim()).filter(Boolean))],
  };
}

export function parseMeetingLiteral(raw, fn = 'meeting') {
  if (raw && typeof raw === 'object') return validateMeetingLiteral(raw, fn);
  let obj;
  try {
    obj = JSON.parse(String(raw ?? ''));
  } catch (e) {
    throw new Error(`${fn}(): not valid JSON — ${e.message}`);
  }
  return validateMeetingLiteral(obj, fn);
}

// --- call rewriting ----------------------------------------------------------

// Same minting as breakout()'s (see breakout-core.js's rewriteSpecCalls), with
// its own token prefix and renderer.
export function rewriteMeetingCalls(code, { peer = null, counter = { n: 0 } } = {}) {
  return rewriteSpecCalls(code, {
    fns: ['meeting'], prefix: 'mt', render: '._mtRender()',
    parse: parseMeetingLiteral, peer, counter,
  });
}

// --- planning ----------------------------------------------------------------

// The URL of meeting `name` on the same server as `href`: the last path
// segment replaced, query and hash (Jitsi's #config overrides) kept, and the
// prejoin screen turned off so the move lands in the meeting rather than
// waiting on a "Join meeting" click.
export function meetingUrl(href, name) {
  const url = new URL(href);
  const parts = url.pathname.split('/');
  let last = parts.length - 1;
  while (last > 0 && !parts[last]) last--;
  if (last > 0) {
    parts[last] = encodeURIComponent(name);
    url.pathname = parts.join('/');
  } else {
    url.pathname = `/${encodeURIComponent(name)}`;
  }
  return skipPrejoin(url.toString());
}

// The home a request names this browser by, or null when it does not name
// it: its token in the meeting the request came from, or the token it held
// in its remembered home when the request came from there.
export function matchHome({ spec, origin }, self) {
  const named = (token) => token != null && spec.participants.includes(String(token));
  if (origin === self.meeting && named(self.token)) return { meeting: self.meeting, token: String(self.token) };
  if (self.home && origin === self.home.meeting && named(self.home.token)) return self.home;
  return null;
}

// Whether request `a` was stamped after request `b` (or after stamp `b`).
export function isNewer(a, b) {
  const at = (r) => (typeof r === 'number' ? r : Number(r?.at));
  return Number.isFinite(at(a)) && !(Number.isFinite(at(b)) && at(a) <= at(b));
}

// One relayed request ({ spec, origin, at }) against THIS browser → what to do:
//   move     the meeting to go to, or null
//   home     what to remember as home when moving ({ meeting, token })
//   retryAt  when not moving yet because it is still settling in: when to
//            look again (the request still stands unless a newer one comes)
//   why      when not moving, why not (null when this browser is not named)
// `self` is { meeting, token, home, exempt, arrivedAt, lastAt }: the meeting
// this browser is in and its token there, its remembered home (or null),
// whether it pressed the panic button, when it arrived from its last move,
// and the stamp of the last request it obeyed.
export function planMeetingMove(request, self, now = Date.now()) {
  const plan = { move: null, home: null, retryAt: null, why: null };
  const home = matchHome(request, self);
  if (!home) return plan;
  if (self.lastAt != null && !isNewer(request, self.lastAt)) { plan.why = 'superseded by a newer request'; return plan; }

  const target = isMainMeetingName(request.spec.name) ? request.origin : request.spec.name;
  if (target === self.meeting) { plan.why = 'already there'; return plan; }
  if (self.exempt) { plan.why = 'pressed the panic button'; return plan; }
  if (self.arrivedAt != null && now - self.arrivedAt < SETTLE_MS) {
    plan.why = 'still settling in';
    plan.retryAt = self.arrivedAt + SETTLE_MS;
    return plan;
  }
  plan.move = target;
  plan.home = home;
  return plan;
}

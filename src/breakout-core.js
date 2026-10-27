// breakout-core.js — pure logic for breakout-room patterns: the room literal
// breakout()/assign() take, the call/mint rewriting that gets that literal
// through the transpiler intact, and the planner that turns one fired
// request plus Jitsi's current room list into the create/move calls to make.
//
// No DOM, no Strudel, no Jitsi — runs identically in the browser bundle and
// under node:test. The browser glue (Jitsi's BreakoutRooms API, the sidecar
// relay, the moderator election, the panic button) lives in breakout.js.
//
//   $: breakout({"name":"room", "participants": ["0", "1", "2b"]})
//   $: breakout({"name":"<room main>", "participants": ["2b"]}).slow(4)
//
// breakout() makes sure the named room exists (creating it once — never a
// second room with the same name) and moves the listed participants into it.
// assign() only moves: it names a room breakout() already made. In both,
// "main" is the meeting's main room. Neither moves a participant who is
// already in the target room, so a voice that fires every cycle settles after
// one move — until the pattern names a different room.
//
// The "name" may be a mini-notation pattern of room names — anything with a
// `<…>`, `[…]` or `{…}` group — which is what moves people back and forth:
// `"<room main>"` alternates every cycle, `"<a b main>/2"` walks three rooms
// at half speed, `"<room ~>"` moves on the first cycle and rests on the next.
// Inside a pattern a space separates steps, so a room name containing one is
// escaped: `"<Room\\ A main>"` (one backslash, doubled for JSON).
//
// Like poll(), the literal never reaches the transpiler: its braces/colons/
// commas would collide with mini-notation's own `{}` and `,`. Each room name
// is minted into a token carrying the whole spec for that room, and the
// pattern of tokens is what Strudel sees — `assign("<bk0 bk1>")`. The
// literal may be written bare (an object literal) or quoted.

import { splitStatements, encodeMiniText } from './text-cycles-core.js';

// The name breakout()/assign() use for the meeting's main room. breakout()
// never creates a room by this name; it sends the participants back instead.
export const MAIN_ROOM = 'main';

export function isMainRoomName(name) {
  return String(name ?? '').trim().toLowerCase() === MAIN_ROOM;
}

// A "name" that is a pattern of room names rather than one room — see the
// header. Only a grouping makes it one, so a plain name may still contain
// `*`, `/`, `?` and the like.
export function isRoomPattern(name) {
  return /[<[{]/.test(String(name ?? ''));
}

export const BREAKOUT_CALL_RE = /(?:^|[^\w$])(?:breakout|assign)\s*\(/;

// --- literal parsing ---------------------------------------------------------

// { name, participants } → a normalized room spec, or throws naming exactly
// what is wrong. `fn` is the call being validated, for the message.
export function validateBreakoutLiteral(obj, fn = 'breakout') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error(`${fn}(): expected a JSON object with "name"`);
  }
  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    throw new Error(`${fn}(): "name" must be a non-empty string`);
  }
  const name = obj.name.trim();
  const participants = obj.participants == null ? [] : obj.participants;
  if (!Array.isArray(participants) || participants.some((p) => typeof p !== 'string' && typeof p !== 'number')) {
    throw new Error(`${fn}(): "participants" must be an array of participant tokens`);
  }
  return { name, participants: [...new Set(participants.map((p) => String(p).trim()).filter(Boolean))] };
}

export function parseBreakoutLiteral(raw, fn = 'breakout') {
  if (raw && typeof raw === 'object') return validateBreakoutLiteral(raw, fn);
  let obj;
  try {
    obj = JSON.parse(String(raw ?? ''));
  } catch (e) {
    throw new Error(`${fn}(): not valid JSON — ${e.message}`);
  }
  return validateBreakoutLiteral(obj, fn);
}

// --- call detection / rewriting ----------------------------------------------

// The end index (exclusive) of the string literal or balanced `{…}` object
// literal starting at code[start], or -1 when there is not one there. Quotes
// inside the object are skipped as strings so a `}` in a room name does not
// close it early.
function scanLiteral(code, start) {
  const open = code[start];
  if (open === '"' || open === "'" || open === '`') {
    for (let i = start + 1; i < code.length; i++) {
      if (code[i] === '\\') { i++; continue; }
      if (code[i] === open) return i + 1;
    }
    return -1;
  }
  if (open !== '{') return -1;
  let depth = 0;
  for (let i = start; i < code.length; i++) {
    const c = code[i];
    if (c === '"' || c === "'") {
      const end = scanLiteral(code, i);
      if (end < 0) return -1;
      i = end - 1;
      continue;
    }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return i + 1;
  }
  return -1;
}

// The mini string that replaces one call's literal: a single token for a
// plain room name, or the name pattern with every room minted into a token
// that carries the spec for that room. A literal that does not parse is
// minted whole, so the error surfaces (with its message) when it fires.
function mintLiteral(body, fn, mint, parse, isPattern) {
  let spec;
  try {
    spec = parse(body, fn);
  } catch (e) {
    return mint(body);
  }
  if (!isPattern(spec.name)) return mint(JSON.stringify(spec));
  return encodeMiniText(spec.name, (room) => mint(JSON.stringify({ ...spec, name: room })));
}

// Rewrite the argument of every call to one of `fns` in `code` into minted
// tokens (see mintLiteral) and attach `render` to any statement that named
// one. An argument that is neither a plain literal nor a balanced object (an
// interpolated template, a variable) is left as written. Shared by
// breakout()/assign() and meeting-move-core.js's meeting().
export function rewriteSpecCalls(code, {
  fns, prefix, render, parse, isPattern = isRoomPattern, peer = null, counter = { n: 0 },
}) {
  const atoms = {};
  const names = fns.join('|');
  const testRe = new RegExp(`(?:^|[^\\w$])(?:${names})\\s*\\(`);
  const callRe = new RegExp(`(?:^|[^\\w$])(${names})\\s*\\(\\s*`, 'g');

  const rewriteStatement = (text) => {
    if (!testRe.test(text)) return text;
    let out = '';
    let last = 0;
    callRe.lastIndex = 0;
    let m;
    while ((m = callRe.exec(text))) {
      const argStart = m.index + m[0].length;
      const end = scanLiteral(text, argStart);
      if (end < 0) continue;
      const raw = text.slice(argStart, end);
      if (raw[0] === '`' && raw.includes('${')) continue;
      const body = raw[0] === '{' ? raw : raw.slice(1, -1);
      const fn = m[1];
      const mini = mintLiteral(body, fn, (atomText) => {
        const token = `${prefix}${counter.n++}`;
        atoms[token] = { text: atomText, fn, peer };
        return token;
      }, parse, isPattern);
      out += `${text.slice(last, argStart)}"${mini}"`;
      last = end;
      callRe.lastIndex = end;
    }
    out += text.slice(last);
    // Keep the statement's trailing blank lines after the renderer: a blank
    // line is what ends a capability preamble, and this runs before the split.
    const tail = out.match(/\s*$/)[0];
    return `${out.slice(0, out.length - tail.length).replace(/;+$/, '')}\n${render}${tail}`;
  };

  const rewritten = splitStatements(String(code ?? ''))
    .map(({ text }) => rewriteStatement(text))
    .join('\n');

  return { code: rewritten, atoms };
}

export function rewriteBreakoutCalls(code, { peer = null, counter = { n: 0 } } = {}) {
  return rewriteSpecCalls(code, {
    fns: ['breakout', 'assign'], prefix: 'bk', render: '._bkRender()',
    parse: parseBreakoutLiteral, peer, counter,
  });
}

// --- planning ----------------------------------------------------------------

// Jitsi's breakout-rooms UPDATE payload (BreakoutRooms._rooms: roomJid →
// { jid, name, isMainRoom, participants: { occupantJid → { jid,
// displayName } } }) → a plain array the planner can read.
export function normalizeRooms(rawRooms) {
  return Object.entries(rawRooms || {}).map(([key, room]) => ({
    jid: room?.jid || key,
    name: typeof room?.name === 'string' ? room.name : '',
    isMainRoom: !!room?.isMainRoom,
    participants: Object.entries(room?.participants || {}).map(([occupant, p]) => ({
      // The occupant JID's resource is the participant's Jitsi endpoint id.
      id: String(occupant).split('/').pop(),
      jid: p?.jid || null,
      displayName: typeof p?.displayName === 'string' ? p.displayName : null,
    })),
  }));
}

function findRoom(rooms, name) {
  if (isMainRoomName(name)) return rooms.find((r) => r.isMainRoom) || null;
  return rooms.find((r) => !r.isMainRoom && r.name === name) || null;
}

// Where `peer` ({ jitsiId, displayName }) is in `rooms` right now: endpoint
// id first, display name as the fallback for a participant whose id changed
// with the move. null when Jitsi does not list them anywhere.
export function locateParticipant(rooms, peer) {
  if (!peer) return null;
  for (const byName of [false, true]) {
    for (const room of rooms) {
      const hit = room.participants.find((p) => (byName
        ? peer.displayName && p.displayName === peer.displayName
        : peer.jitsiId && p.id === peer.jitsiId));
      if (hit && hit.jid) return { room, participantJid: hit.jid };
    }
  }
  return null;
}

// One fired request ({ fn: 'breakout'|'assign', spec }) against the current
// room list → what to do now:
//   create   a room name to create (breakout() only), or null
//   moves    [{ token, participantJid, roomJid }]
//   waiting  the target room does not exist yet — retry once it does
//   skipped  [{ token, why }] for anyone deliberately left where they are
//   error    a message when the request cannot be carried out at all
// `peersByToken` maps a participant token to { jitsiId, displayName };
// `isExempt(token, peer)` is true for anyone who pressed the panic button;
// `expectedRoomOf(participantJid)` is the room a move was just sent to, if
// Jitsi has not had time to report it — without it, a pattern moving someone
// back before that report lands would read them as already there.
export function planBreakout({ fn, spec }, rooms, peersByToken, { isExempt = () => false, expectedRoomOf = () => null } = {}) {
  const plan = { create: null, moves: [], waiting: false, skipped: [], error: null };
  const target = findRoom(rooms, spec.name);
  if (!target) {
    if (isMainRoomName(spec.name)) {
      plan.error = `${fn}(): Jitsi has not reported the main room yet`;
      return plan;
    }
    if (fn === 'assign') {
      plan.error = `assign(): no breakout room named "${spec.name}" — create it with breakout() first`;
      return plan;
    }
    plan.create = spec.name;
    plan.waiting = true;
    return plan;
  }
  for (const token of spec.participants) {
    const peer = peersByToken.get(token);
    if (!peer) { plan.skipped.push({ token, why: 'no participant has this token' }); continue; }
    if (isExempt(token, peer)) { plan.skipped.push({ token, why: 'pressed the panic button' }); continue; }
    const where = locateParticipant(rooms, peer);
    if (!where) { plan.skipped.push({ token, why: 'not listed in any room yet' }); continue; }
    if ((expectedRoomOf(where.participantJid) ?? where.room.jid) === target.jid) continue;
    plan.moves.push({ token, participantJid: where.participantJid, roomJid: target.jid });
  }
  return plan;
}

// --- panic button ------------------------------------------------------------

// How long after a room move the panic button stays up once the participant
// is back in the main room — long enough to reach for it if the next move is
// coming.
export const PANIC_LINGER_MS = 60000;

// Whether the local participant is being moved around by breakout rooms: in
// one right now, or moved (either direction) within the last PANIC_LINGER_MS.
// A participant who has never been moved never sees the button.
export function shouldShowPanic({ inBreakout, lastMoveAt }, now = Date.now()) {
  if (lastMoveAt == null) return false;
  return !!inBreakout || now - lastMoveAt < PANIC_LINGER_MS;
}

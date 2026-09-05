// breakout-core.js — pure logic for breakout-room definitions and
// assignments: the object-literal shape `# breakout` takes, and the
// bookkeeping that decides which rooms exist and who currently belongs where.
//
// No DOM, no Strudel, no Jitsi — runs identically in the browser bundle and
// under node:test. Reading the parsed metaprogram AST and actually creating
// Jitsi breakout rooms / moving participants lives in
// src/audio-net/Breakout.js; the grammar itself (the `# breakout` / `# assign`
// directives, and the single-quoted string literal that carries this JSON
// past a tokenizer whose only other strings are bare metric/medium keywords)
// lives in MetaprogrammerParser.js.
//
// Same reasoning as polls-core.js: strict JSON, not a lenient bespoke
// grammar — a typo should be reported, not guessed around.

// The reserved room name assign() uses to send someone back to the main
// meeting — not itself a room breakout() may declare.
export const MAIN_ROOM = 'main';

// { name, participants } → a normalized room spec, or throws naming exactly
// what is wrong. `participants` is optional; an absent/empty list just means
// the room starts with nobody explicitly seated (assign() still works).
export function validateBreakoutLiteral(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('breakout(): expected a JSON object with "name"');
  }
  if (typeof obj.name !== 'string' || !obj.name.trim()) {
    throw new Error('breakout(): "name" must be a non-empty string');
  }
  if (obj.name.trim() === MAIN_ROOM) {
    throw new Error(`breakout(): "${MAIN_ROOM}" is the reserved name for the main room — pick another`);
  }
  const participants = obj.participants == null ? [] : obj.participants;
  if (!Array.isArray(participants) || participants.some((p) => typeof p !== 'string' && typeof p !== 'number')) {
    throw new Error('breakout(): "participants" must be an array of participant tokens');
  }
  return { name: obj.name.trim(), participants: participants.map(String) };
}

export function parseBreakoutLiteral(raw) {
  let obj;
  try {
    obj = JSON.parse(String(raw ?? ''));
  } catch (e) {
    throw new Error(`breakout(): not valid JSON — ${e.message}`);
  }
  return validateBreakoutLiteral(obj);
}

// Fold a program's `# breakout` and `# assign` directives (as the parser
// collects them — arrays in source order) into the room list every browser
// should have, and the single room each participant token currently belongs
// in. Later entries win: a room redeclared with the same name replaces the
// earlier one (its participants list, specifically), and a token assigned
// more than once ends up wherever its LAST `# assign` line put it — a
// program read top-to-bottom as the room's current desired state, not a
// history of edits.
export function resolveBreakoutState(breakouts, assignments) {
  const rooms = new Map(); // name -> { name, participants: Set }
  for (const spec of breakouts ?? []) {
    rooms.set(spec.name, { name: spec.name, participants: new Set(spec.participants) });
  }
  const assignedTo = new Map(); // token -> roomName (or MAIN_ROOM)
  for (const { token, room } of assignments ?? []) {
    assignedTo.set(String(token), room);
    if (room !== MAIN_ROOM) {
      if (!rooms.has(room)) rooms.set(room, { name: room, participants: new Set() });
      rooms.get(room).participants.add(String(token));
    }
  }
  // A token named in a breakout()'s own "participants" list, with no
  // explicit assign() line, is assigned to that room by declaration.
  for (const room of rooms.values()) {
    for (const token of room.participants) {
      if (!assignedTo.has(token)) assignedTo.set(token, room.name);
    }
  }
  return {
    rooms: [...rooms.values()].map((r) => ({ name: r.name, participants: [...r.participants] })),
    assignedTo,
  };
}

// Which room (a name, or MAIN_ROOM) `token` should currently be in, per the
// resolved state — MAIN_ROOM when nothing assigns it anywhere.
export function roomForToken(state, token) {
  return state.assignedTo.get(String(token)) ?? MAIN_ROOM;
}

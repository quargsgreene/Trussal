// program-directive.js — the one line that says which of Trussal's three
// program kinds a buffer is, so nothing downstream has to infer it from shape.
//
// One rule, three consumers — the same reasoning as hydra-code.js and
// bot-config.js. Every editable program buffer in the system opens with a bare
// string-literal directive on its first real line, exactly as a module opens
// with "use strict":
//
//   'personal program'   a performer's own Strudel + Hydra editor
//   'metaprogram'         the shared JPattern scheduling script
//   'bot program'         code a bot runs on a performer's behalf
//
// It is REQUIRED and there is no heuristic fallback: a buffer with no
// recognised directive is not silently classified, it is an error surfaced to
// whoever typed it. Making the kind explicit is what lets `participants` stop
// being a reserved word — the JPattern parser knows it is parsing a
// metaprogram because the directive says so, not because it spotted a
// `$ participants` line, so the token is free to mean anything in the other
// two kinds.
//
// Pure module: no DOM, no imports. Runs identically in the browser bundle, in
// the bots process, and under node:test.

export const PERSONAL = 'personal program';
export const METAPROGRAM = 'metaprogram';
export const BOT = 'bot program';

export const DIRECTIVES = { PERSONAL, METAPROGRAM, BOT };

const KIND_BY_TEXT = {
  [PERSONAL]: 'personal',
  [METAPROGRAM]: 'metaprogram',
  [BOT]: 'bot',
};

// A line is "blank or a full-line comment" if it carries nothing a program
// runs. The directive may sit below any number of these, the same slack
// "use strict" gets below a licence header.
const SKIPPABLE_RE = /^\s*(\/\/.*)?$/;

// The directive itself: a single- or double-quoted one of the three phrases,
// alone on its line bar an optional trailing `;` and `// comment`. Anchored so
// a quoted phrase mid-expression is never mistaken for it.
const DIRECTIVE_RE = /^\s*(['"])(personal program|metaprogram|bot program)\1\s*;?\s*(\/\/.*)?$/;

// The directive line as a serialisable descriptor, for consumers that cannot
// import this module — the bot's page scripts are function bodies handed to
// Chromium by puppeteer and can only receive JSON. Same reasoning as
// hydra-code.js's INIT_HYDRA_PATTERN. Add an 'm' flag before use to match the
// directive on its own line anywhere in a multi-line buffer.
export const DIRECTIVE_LINE_PATTERN = { source: DIRECTIVE_RE.source, flags: DIRECTIVE_RE.flags };

function splitLines(text) {
  return String(text ?? '').split('\n');
}

// Index of the first line that is neither blank nor a full-line comment, or -1.
function firstRealLine(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (!SKIPPABLE_RE.test(lines[i])) return i;
  }
  return -1;
}

// { kind, phrase, lineIndex } for the buffer's directive, or
// { kind: null, reason } when the first real line is not a valid directive.
export function readDirective(text) {
  const lines = splitLines(text);
  const idx = firstRealLine(lines);
  if (idx === -1) {
    return { kind: null, reason: 'empty program — expected a leading directive line', lineIndex: 0 };
  }
  const m = lines[idx].match(DIRECTIVE_RE);
  if (!m) {
    return {
      kind: null,
      reason: "missing directive — the first line must be 'personal program', 'metaprogram' or 'bot program'",
      lineIndex: idx,
    };
  }
  return { kind: KIND_BY_TEXT[m[2]], phrase: m[2], lineIndex: idx };
}

// True when the buffer's directive names exactly this kind
// ('personal' | 'metaprogram' | 'bot').
export function hasDirective(text, kind) {
  return readDirective(text).kind === kind;
}

// The program with its directive line blanked out — same line count, so every
// downstream line/col stays put and editor squiggles land where the author
// typed. A buffer with no valid directive is returned unchanged (the caller
// has already been told, via readDirective, that it is invalid).
export function stripDirective(text) {
  const info = readDirective(text);
  if (info.kind == null) return String(text ?? '');
  const lines = splitLines(text);
  lines[info.lineIndex] = '';
  return lines.join('\n');
}

// Prepend the directive for a given kind if the buffer does not already carry
// it. For programmatic producers — the room's default programs, the bot fleet
// wrapping a captured pattern — never for text a human is editing.
export function ensureDirective(text, kind) {
  const phrase = Object.keys(KIND_BY_TEXT).find((p) => KIND_BY_TEXT[p] === kind);
  if (!phrase) throw new Error(`ensureDirective: unknown kind '${kind}'`);
  const s = String(text ?? '');
  if (readDirective(s).kind === kind) return s;
  return `'${phrase}'\n${s}`;
}

// Swap whatever directive a buffer carries (or none) for this kind's, leaving
// the body untouched. Used when a bot adopts a performer's 'personal program'
// as its own 'bot program'. The blank line stripDirective leaves where the old
// directive sat is folded back into the new directive's own line.
export function retagDirective(text, kind) {
  const info = readDirective(text);
  const body = info.kind == null
    ? String(text ?? '')
    : splitLines(stripDirective(text)).filter((l, i) => !(i === info.lineIndex && l === '')).join('\n');
  return ensureDirective(body, kind);
}

// polls-core.js — pure logic for meeting-poll patterns: parsing/validating
// the poll object literal, the call/mint rewriting that gets a whole JSON
// blob (braces, colons, commas — none of it legal mini-notation structure)
// through the transpiler intact, and the vote-tally arithmetic.
//
// No DOM, no Strudel, no network — runs identically in the browser bundle and
// under node:test. The browser glue (chat rendering, click-to-vote, the
// sidecar round trip) lives in polls.js.
//
// poll() takes exactly ONE poll literal per call — unlike word()/image(),
// there is no mini-notation alternation BETWEEN poll objects (`poll("<{...}
// {...}>")` is not supported): a poll's braces/colons/commas would collide
// with mini's own `{}` (polymeter) and `,` (stack) syntax, so the whole
// argument is minted as ONE opaque atom regardless of quoting — the same
// treatment text-cycles-core.js gives a single-quoted word(), just applied
// unconditionally here rather than only when the author single-quotes it.
// fast()/slow()/sometimes()/etc. still work (they are pattern *structure*,
// applied outside the argument, same as any other Strudel voice), just not a
// sequence of DIFFERENT polls within one poll() call.
//
// A poll's identity across repeated triggers (e.g. under .fast(4), the same
// written poll() firing every cycle) is its `question` text — two triggers
// with the same question are the same live poll and share one tally; a
// different question starts a new one. Plain, visible, and exactly what a
// performer editing the question text to mean "a new poll" would expect.

import { splitStatements } from './text-cycles-core.js';

export const DEFAULT_POLL_TEXT_COLOR = '#111111';

// --- literal parsing ---------------------------------------------------------
//
// Strict JSON, not a bespoke lenient grammar: this codebase's convention is
// to surface a bad input as an error rather than guess around it (see
// program-directive.js's directive, or notation.js's mixed-notation
// rejection) — a poll literal with a typo should tell the author where, not
// silently parse into something they did not write.

export function parsePollLiteral(raw) {
  let obj;
  try {
    obj = JSON.parse(String(raw ?? ''));
  } catch (e) {
    throw new Error(`poll(): not valid JSON — ${e.message}`);
  }
  return validatePollLiteral(obj);
}

// { question, options, participants, votes } → a normalized poll spec, or
// throws with a message naming exactly what is wrong. `participants` and
// `votes` are both optional — an absent or empty participants list means
// anyone may vote; absent votes means every option starts at 0.
export function validatePollLiteral(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('poll(): expected a JSON object with "question" and "options"');
  }
  if (typeof obj.question !== 'string' || !obj.question.trim()) {
    throw new Error('poll(): "question" must be a non-empty string');
  }
  if (!Array.isArray(obj.options) || !obj.options.length || obj.options.some((o) => typeof o !== 'string' || !o.trim())) {
    throw new Error('poll(): "options" must be a non-empty array of non-empty strings');
  }
  const options = [...new Set(obj.options)];
  if (options.length !== obj.options.length) {
    throw new Error('poll(): "options" must not repeat the same option twice');
  }

  const participants = Array.isArray(obj.participants) ? obj.participants.map(String) : [];

  const tally = Object.fromEntries(options.map((o) => [o, 0]));
  if (obj.votes != null) {
    // Documented shape is "an array of object literals: votes for specific
    // options as string + number quantity" — [{"yes": 2}, {"no": 3}] — but a
    // single flat object ({"yes": 2, "no": 3}, the shape every example in the
    // feature request actually writes) is accepted too rather than making an
    // author choose the "correct" nesting for the same information.
    const entries = Array.isArray(obj.votes) ? obj.votes : [obj.votes];
    for (const entry of entries) {
      if (!entry || typeof entry !== 'object') continue;
      for (const [option, count] of Object.entries(entry)) {
        if (!(option in tally)) throw new Error(`poll(): "votes" names an option not in "options": "${option}"`);
        if (typeof count !== 'number' || !Number.isFinite(count) || count < 0) {
          throw new Error(`poll(): "votes"."${option}" must be a non-negative number`);
        }
        tally[option] += count;
      }
    }
  }

  return { question: obj.question.trim(), options, participants, tally };
}

// May `voterToken` (a room index, e.g. "0", "1", "2a") cast a vote in this
// poll? An empty/absent participants list means anyone may.
export function canVote(spec, voterToken) {
  return !spec.participants.length || spec.participants.includes(String(voterToken));
}

// Apply a `.vote({option: count, ...})` delta onto a tally, returning a NEW
// tally object (never mutates the one passed in — every renderer holds onto
// a poll's last-known tally, and a shared mutable object would let one
// reader's update surprise another).
export function applyVoteDelta(tally, delta) {
  const out = { ...tally };
  if (!delta || typeof delta !== 'object') return out;
  for (const [option, count] of Object.entries(delta)) {
    if (!(option in out) || typeof count !== 'number' || !Number.isFinite(count)) continue;
    out[option] = Math.max(0, out[option] + count);
  }
  return out;
}

// Move one voter's own single vote from `from` to `to` (or cast a first vote
// when `from` is null) — a click-to-vote UI's one operation, expressed as the
// same additive delta applyVoteDelta already knows how to apply.
export function switchVote(tally, from, to) {
  const delta = {};
  if (from && from in tally) delta[from] = -1;
  if (to && to in tally) delta[to] = 1;
  return applyVoteDelta(tally, delta);
}

// --- call detection / rewriting ----------------------------------------------

export const POLL_CALL_RE = /(?:^|[^\w$])poll\s*\(/;
const VOTE_CALL_RE = /(?:^|[^\w$])vote\s*\(/;

const STRING_LITERAL = '("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)';

function literalBody(raw) {
  return { quote: raw[0], body: raw.slice(1, -1) };
}

// Mint the WHOLE argument of every poll()/vote() call in `code` as one opaque
// atom — see this file's header for why encodeMiniText's word-by-word
// splitting (right for word()/image()) is wrong here. Attaches ._pollRender()
// to any statement that named poll().
export function rewritePollCalls(code, { peer = null, counter = { n: 0 } } = {}) {
  const atoms = {};
  const mint = (text) => {
    const token = `pl${counter.n++}`;
    atoms[token] = { text, peer };
    return token;
  };

  const re = new RegExp(`((?:^|[^\\w$])(?:poll|vote)\\s*\\(\\s*)${STRING_LITERAL}`, 'g');

  const rewriteStatement = (text) => {
    if (!POLL_CALL_RE.test(text)) return text;
    const out = text.replace(re, (match, head, raw) => {
      if (raw[0] === '`' && raw.includes('${')) return match;
      const { body } = literalBody(raw);
      return `${head}"${mint(body)}"`;
    });
    return `${out.replace(/[\s;]+$/, '')}\n._pollRender()`;
  };

  const rewritten = splitStatements(String(code ?? ''))
    .map(({ text }) => rewriteStatement(text))
    .join('\n');

  return { code: rewritten, atoms };
}

const INIT_POLLS_RE = /^\s*await\s+initPolls\s*\(/m;
export const INIT_POLLS_PATTERN = { source: INIT_POLLS_RE.source, flags: INIT_POLLS_RE.flags };

export function hasPollCycles(code) {
  return INIT_POLLS_RE.test(String(code ?? ''));
}

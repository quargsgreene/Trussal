// Pure source-offset logic for the JPattern cycle highlighter (no DOM), split
// out so node:test can exercise it — the same reasoning as css-cycles-core.js /
// text-cycles-core.js / editor-router-core.js.
//
// Given the live editor text and a `type` ('participant' | 'rest'), return the
// character span of every such element of the `$ participants` scheduling
// sequence, in the depth-first order the scheduler numbers them
// (MetaprogramScheduler.js indexNodes) — that shared order is what lets a
// slot's `index` address a glyph in the editor. Each span runs from the token
// through its glued postfix operators (`4@3`, `10!2`, `2a?`) so the outline
// boxes them as one thing.

import { parseMetaprogram } from '../src/audio-net/MetaprogrammerParser.js';
import { detectNotation } from '../src/notation.js';

// (line, col) are 1-based, as the parser emits them.
export function lineColToOffset(text, line, col) {
  let offset = 0;
  const lines = String(text).split('\n');
  for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
  return offset + (col - 1);
}

// A `$:` mini-notation buffer (`$: participants("<0 1 2>")…`) is lowered to the
// mondo `$`/`#` grammar before the parser assigns line/col (src/notation.js
// miniToMondo), so a parsed node's `col` indexes the LOWERED string, not the
// text in the textarea — `$ participants ` is two glyphs shorter than
// `$: participants("`, and a chained `.method()` shifts onto its own line. The
// highlighter's mirror measures the live text, so those columns land the
// outline a few glyphs early (typically on the opening `("`). The tokens
// themselves are identical between the two forms, so for a mini buffer scan the
// real text for the scheduling sequence's glyphs directly rather than trusting
// the parser's col.
//
// Returns { type, token, offset, len } for every participant / rest inside the
// `participants(...)` pattern string, in source (= depth-first) order, `len`
// covering the glued postfix operators the same way the mondo path's `endCol`
// does. `<…>` / `[…]` nest; a trailing `*n` / `/n` rate on a group sits at
// bracket depth 0 and is skipped, as is a modifier operand (the `2` in `*2`).
const MINI_SEQUENCE_RE = /^[ \t]*\$:[ \t]*participants[ \t]*\(\s*(["'`])/m;
export function miniSequencePositions(text) {
  const m = MINI_SEQUENCE_RE.exec(text);
  if (!m) return [];
  const quote = m[1];
  const start = m.index + m[0].length;       // first char inside the string
  const end = text.indexOf(quote, start);
  if (end === -1) return [];
  const content = text.slice(start, end);
  const els = [];
  const sepBefore = (c) => c === undefined || ' \t\n<[(>])|,'.includes(c);
  let i = 0, depth = 0;
  while (i < content.length) {
    const c = content[i];
    if (c === '<' || c === '[' || c === '(') { depth++; i++; continue; }
    if (c === '>' || c === ']' || c === ')') { depth--; i++; continue; }
    if (depth < 1 || ' \t\n,|'.includes(c)) { i++; continue; }
    const isTokenStart = sepBefore(content[i - 1]);
    const pm = isTokenStart && /^[0-9]+[a-z]*/.exec(content.slice(i));
    if (pm) {
      const tokStart = i;
      i += pm[0].length;
      const mod = /^(?:[@!?*/%:]\.?[0-9]*|\.\.[0-9]+[a-z]*)*/.exec(content.slice(i));
      if (mod) i += mod[0].length;
      els.push({ type: 'participant', token: pm[0], offset: start + tokStart, len: Math.max(1, i - tokStart) });
      continue;
    }
    if (isTokenStart && (c === '~' || c === '_' || c === '-')) {
      const tokStart = i;
      i += 1;
      const mod = /^(?:[@!?*/%:]\.?[0-9]*)*/.exec(content.slice(i));
      if (mod) i += mod[0].length;
      els.push({ type: 'rest', token: c, offset: start + tokStart, len: Math.max(1, i - tokStart) });
      continue;
    }
    i++;
  }
  return els;
}

// Source offsets of every element of `type` ('participant' | 'rest'), in
// depth-first order. An element with no extent recorded falls back to its token
// width.
export function elementPositions(text, type) {
  const { ast } = parseMetaprogram(text);
  const out = [];
  if (!ast.participants) return out;
  // mini buffer: the parser's columns index the lowered mondo string, not this
  // text — locate the glyphs directly (see miniSequencePositions).
  if (detectNotation(text) === 'mini') {
    return miniSequencePositions(text).filter(e => e.type === type);
  }
  const walk = (els) => {
    for (const el of els || []) {
      if (!el) continue;
      if (el.type === type && el.token != null && el.line != null) {
        const token = String(el.token);
        const offset = lineColToOffset(text, el.line, el.col);
        const end = el.endCol != null
          ? lineColToOffset(text, el.endLine ?? el.line, el.endCol)
          : offset + token.length;
        out.push({ token, offset, len: Math.max(1, end - offset) });
      } else if (el.type === 'choice') {
        (el.options || []).forEach(walk);
      } else if (el.type === 'sequence') {
        (el.stacks || []).forEach(st => walk(st.elements));
      }
    }
  };
  ast.participants.stacks.forEach(st => walk(st.elements));
  return out;
}

// Every participant token in `$ participants` with its source offset
// (depth-first, every branch of a `|` choice, repeats included).
export function participantPositions(text) {
  return elementPositions(text, 'participant');
}

// The same scan over the rests (`~`, `_`, `-`) — a separate list because the
// scheduler numbers rests in their own index space, so the two never shift
// each other (see indexNodes in src/audio-net/MetaprogramScheduler.js).
export function restPositions(text) {
  return elementPositions(text, 'rest');
}

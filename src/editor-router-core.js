// Editor routing — pure core.
//
// Two editors coexist in the studio: the personal Strudel textarea
// ('.ts-code' in the detail panel) and the global JPattern metaprogram
// editor ('.ts-code.jp-code', CRDT-bound). Head-cursor mutators, gesture
// handlers, and the on-screen keyboard all act on "whichever editor is
// focused"; classification, the regex mutation and the button declarations
// both editors support are pure so they run under node:test.

// The scheduling-sequence edits a `*$` button performs are the parser's own
// roster helpers — pure, and the single copy of "is this token in the ring".
import {
  appendParticipantToProgram,
  removeParticipantFromProgram,
  programHasParticipant,
  hasParticipantSequence
} from './audio-net/MetaprogrammerParser.js';
// A `*$` / `*#` declaration and the roster helpers are the mondo `$`/`#`
// grammar. A metaprogram written in mini ($: … .method(…)) is lowered to that
// grammar for the scan and the toggle, and a mini buffer is raised back
// afterwards so the notation never gets mixed.
import { detectNotation, miniToMondo, mondoToMini } from './notation.js';

// classNames: iterable/array of class names (e.g. from element.classList).
export function classifyEditor(classNames) {
  const set = new Set(classNames || []);
  if (set.has('jp-code')) return 'jpattern';
  if (set.has('ts-code')) return 'strudel';
  return null;
}

// User-defined regex mutation, shared by both editor targets. Invalid
// patterns are a no-op (never throw mid-performance).
export function applyRegexMutation(code, pattern, replacement) {
  try { return code.replace(new RegExp(pattern, 'g'), replacement ?? ''); } catch { return code; }
}

// Ctrl+/ line-comment toggle, shared by every textarea editor (personal
// Strudel, remote bot pattern, JPattern metaprogram). Operates on whichever
// lines the selection touches — the current line for a collapsed cursor —
// and comments them on unless every non-blank line touched is already
// commented, in which case it uncomments. Returns the new value plus a
// remapped selection so the caller can restore the caret/selection after
// replacing textarea.value (which otherwise resets it to the end).
export function toggleLineComment(value, selectionStart, selectionEnd) {
  const text = String(value ?? '');
  const start = Math.max(0, Math.min(selectionStart ?? 0, text.length));
  let end = Math.max(start, Math.min(selectionEnd ?? start, text.length));

  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  // A multi-line selection ending right at column 0 of a line shouldn't pull
  // that line into the block — mirrors how editors treat a trailing newline
  // at the end of a selection.
  let blockEnd = end;
  if (blockEnd > start && text[blockEnd - 1] === '\n') blockEnd -= 1;
  let lineEnd = text.indexOf('\n', blockEnd);
  if (lineEnd === -1) lineEnd = text.length;

  const oldLines = text.slice(lineStart, lineEnd).split('\n');
  const nonBlank = oldLines.filter(l => l.trim() !== '');
  const uncomment = nonBlank.length > 0 && nonBlank.every(l => /^\s*\/\//.test(l));

  const newLines = oldLines.map(line => {
    if (uncomment) return line.replace(/^(\s*)\/\/ ?/, '$1');
    if (line.trim() === '') return line;
    return line.replace(/^(\s*)/, '$1// ');
  });
  const newBlock = newLines.join('\n');
  const newText = text.slice(0, lineStart) + newBlock + text.slice(lineEnd);

  // Remap an old absolute offset to its new position: unaffected before the
  // block, shifted by the block's total length change after it, and mapped
  // line-by-line (preserving column relative to the inserted/removed prefix)
  // inside it.
  const mapOffset = (offset) => {
    if (offset <= lineStart) return offset;
    if (offset >= lineEnd) return offset + (newBlock.length - (lineEnd - lineStart));
    let lineIdx = 0;
    let cursor = lineStart;
    for (; lineIdx < oldLines.length - 1; lineIdx++) {
      const lineLen = oldLines[lineIdx].length;
      if (offset <= cursor + lineLen) break;
      cursor += lineLen + 1;
    }
    const col = offset - cursor;
    const oldLine = oldLines[lineIdx];
    const newLine = newLines[lineIdx];
    const wsLen = (oldLine.match(/^\s*/) || [''])[0].length;
    let newCol;
    if (uncomment) {
      const removedLen = oldLine.length - newLine.length;
      if (col <= wsLen) newCol = col;
      else if (col >= wsLen + removedLen) newCol = col - removedLen;
      else newCol = wsLen;
    } else {
      newCol = col <= wsLen ? col : col + (newLine.length - oldLine.length);
    }
    let newLineStartAbs = lineStart;
    for (let i = 0; i < lineIdx; i++) newLineStartAbs += newLines[i].length + 1;
    return newLineStartAbs + newCol;
  };

  return { value: newText, selectionStart: mapOffset(start), selectionEnd: mapOffset(end) };
}

// JPatternButton snippet toggling on metaprogram text: first dwell adds the
// line, next dwell comments it out, next re-activates (mirrors the Strudel
// voice-button marker convention).
export const JP_BTN_MARKER = ' // jpattern-btn';

// A `*`-prefixed statement declares a button instead of running: `*$ …` for a
// scheduling voice, `*# …` for an effect. The declaration itself is inert (the
// parser skips the line); the button is what writes it into the program. This
// is the metaprogram's half of the personal editor's `*name: code` buttons —
// same declaration shape, same toggle, same head-cursor dwell target.
const JP_BTN_DECL_RE = /^[ \t]*\*[ \t]*([$#])[ \t]*(\S[^\n]*?)[ \t\r]*$/;

// Every button a metaprogram declares, in source order:
//   { snippet, label, active }
// `snippet` is the statement the button writes ('$ participants <2a>');
// `active` says whether it is currently in force, which for a scheduling
// voice means its tokens are in the live sequence and for anything else means
// its marked line is present and uncommented.
// A metaprogram in mini notation, lowered to the mondo `$`/`#` grammar the
// button scanner and roster helpers read; a mondo (or plain) buffer unchanged.
function asMondo(text) {
  const s = String(text ?? '');
  return detectNotation(s) === 'mini' ? miniToMondo(s) : s;
}

export function parseJPatternButtons(text) {
  const buttons = [];
  const seen = new Set();
  for (const line of asMondo(text).split('\n')) {
    const m = JP_BTN_DECL_RE.exec(line);
    if (!m) continue;
    // A trailing comment annotates the declaration; it is not part of the
    // statement the button writes, and carrying it along would leave the
    // written line unrecognizable to the toggle that has to take it back.
    const body = m[2].replace(/\s*\/\/.*$/, '').trimEnd();
    if (!body) continue;
    const snippet = `${m[1]} ${body}`;
    // `$` has exactly one statement — `participants <…>` — so a `$`
    // declaration without a sequence declares nothing there is a button for.
    if (m[1] === '$' && !participantTokensIn(snippet)) continue;
    if (seen.has(snippet)) continue; // one button per distinct statement
    seen.add(snippet);
    buttons.push({
      snippet,
      label: buttonLabel(m[1], body),
      active: isJPatternSnippetActive(text, snippet)
    });
  }
  return buttons;
}

// What the button says on it. A scheduling voice is named by its sequence
// alone — every one of them would otherwise read "participants …".
function buttonLabel(sigil, body) {
  const compact = sigil === '$' ? body.replace(/^participants\s*/, '') : body;
  return compact.length > 20 ? `${compact.slice(0, 20)}…` : compact;
}

// The tokens a `$ participants <…>` declaration puts in the ring, or null for
// any other statement. Elements are whitespace-separated, as they are written
// in the sequence, so a token keeps whatever modifiers it carries (`0@2`).
export function participantTokensIn(snippet) {
  const m = /^\$\s*(?:participants\s*)?[<[]([^\]>]*)[\]>]\s*$/.exec(String(snippet ?? '').trim());
  if (!m) return null;
  const tokens = m[1].split(/\s+/).filter(Boolean);
  return tokens.length ? tokens : null;
}

// A scheduling voice ALWAYS acts on the one sequence the language allows: its
// tokens merge in and out of the live `$ participants`, rather than appending a
// second such statement (which is a duplicate error). Where there is no
// sequence yet, the voice becomes one — written plain, not marked, so that from
// then on it is an ordinary statement the very same button edits token by
// token. Directives, having no such statement to join, toggle as a marked line.
export function isJPatternSnippetActive(text, snippet) {
  const cur = asMondo(text || '');
  const tokens = participantTokensIn(snippet);
  if (tokens) return hasParticipantSequence(cur) && tokens.every(t => programHasParticipant(cur, t));
  return cur.includes(`\n${snippet}${JP_BTN_MARKER}`);
}

export function toggleJPatternSnippet(text, snippet) {
  const original = text || '';
  const wasMini = detectNotation(original) === 'mini';
  const cur = wasMini ? miniToMondo(original) : original;
  // Toggle in the mondo grammar, then raise a mini buffer back so the
  // notation stays consistent (mixing the two is a parse error).
  const raise = (s) => (wasMini ? mondoToMini(s) : s);
  const tokens = participantTokensIn(snippet);
  if (tokens) {
    if (!hasParticipantSequence(cur)) {
      const head = cur.replace(/\s*$/, '');
      return raise(head ? `${head}\n${snippet}\n` : `${snippet}\n`);
    }
    // Turning a voice off empties the ring when it is the only one in it. That
    // is an invalid program and the editor says so, but it is recoverable —
    // pressing the button again puts the voice straight back.
    const on = tokens.every(t => programHasParticipant(cur, t));
    return raise(tokens.reduce(
      (acc, t) => (on ? removeParticipantFromProgram(acc, t) : appendParticipantToProgram(acc, t)),
      cur
    ));
  }
  // An effect declaration (`*#`) toggles a marked `# …` line in and out. That
  // marker convention is mondo-only — the mini form of an effect is a
  // `.method()` glued to the `$:` voice, with nowhere to hang a per-line
  // marker — so in a mini buffer this is a no-op rather than a mix. Participant
  // (`*$`) buttons, above, work in both.
  if (wasMini) return original;
  const active = `\n${snippet}${JP_BTN_MARKER}`;
  const commented = `\n// ${snippet}${JP_BTN_MARKER}`;
  if (cur.includes(commented)) return cur.replace(commented, active);
  if (cur.includes(active)) return cur.replace(active, commented);
  return cur + active;
}

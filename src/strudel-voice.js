// strudel-voice.js — attach a suffix chain to Strudel source that may already
// be one or more $:-labeled voices, one or more capability declarations
// (await initTextCycles()/initCss()), a bare pattern with no label at all, or
// any mix of those, without breaking any of them.
//
// One rule, two consumers, same reasoning as hydra-code.js: strudel.js calls
// this per peer when it stacks the room's combined program (the suffix is the
// network-effects DSP chain for a remote peer); the bot fleet's variation.js
// calls it when it wraps a captured performer's code in a per-bot mix chain
// before handing the result to a standalone Strudel REPL. Both need the same
// answer to "how do I append a suffix to code shaped like this" — get it
// wrong two different ways:
//
//   - Wrap the WHOLE thing in one `(...)` grouping expression (the naive
//     approach) and it throws the moment the code is more than one
//     expression — which it always is once a performer adds a separate `$:
//     css(...)` or `$: word(...)` voice next to their audio pattern, per the
//     CSS/Text Cycles docs' own examples. This is what silently took every
//     bot down once a performer's code combined an audio voice with a text or
//     css voice: `(\n$: css(...)\n\n$: n(...)\n).delay(...).gain(...)` is not
//     one expression, so Strudel's transpiler never produces a pattern and
//     the REPL reports "pattern did not start after evaluation".
//   - Only special-case code BEFORE the first label (the historical
//     behaviour here) and a plain, unlabeled pattern left AFTER a label —
//     which is exactly how a performer naturally writes "my one real voice,
//     plus a css() voice for styling" — is passed through untouched: no
//     `$:`, never collected into the stack, never heard. This is why a
//     working room went silent the moment CSS Cycles asked performers to add
//     their first `$:` label.
//
// The fix in both directions is the same idea Strudel's own REPL already
// uses to combine multiple voices in one editor: split on top-level blank
// lines (paragraphs), and decide each paragraph on its own —
//   - a capability declaration (or a `let`/`const`/... declaration) stays
//     bare, at top level, exactly as written;
//   - a paragraph that already carries a label keeps its label and gets the
//     suffix appended to its FULL body (every line, not just the first —
//     the previous per-line regex broke multi-line chains, e.g. a css()
//     template literal, by splicing the suffix into the middle of them);
//   - a paragraph that mixes a leading declaration with a label on a later
//     line (`await initCss()\n$: css(...)`, one paragraph, no blank line —
//     the shape every capability's own docs use) gets split at the label;
//   - anything left over — a plain pattern with no label at all — is wrapped
//     as its own anonymous `$:` voice, which is Strudel's own mechanism for
//     collecting an unnamed voice into the stack.
//
// Two more shapes a performer writes without thinking, each of which used to
// take the WHOLE room program down with a SyntaxError once fx was non-empty
// (as it always is under JPattern, whose slot gate is appended to every
// voice):
//   - several labeled voices in one paragraph, no blank line between them
//     (`$: s("bd")\n$: s("hh")`). Wrapping from the first label to the end
//     nested the later labels inside its parens. Each top-level label now
//     starts its own statement, found by a scan that skips strings, template
//     literals, comments and bracketed code, so a `color: red` line inside a
//     css() template or a `case x:` inside a function is never mistaken for
//     one.
//   - a `//` comment: on a line of its own it was wrapped as a pattern
//     (`$: (// …)`), and at the end of a body it swallowed the wrapper's
//     closing paren. Comment-only lines now stay bare, and the paren goes on
//     a line of its own whenever a comment could reach it.

const LABEL_AT_START_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*\s*:/;
const LABEL_ANYWHERE_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*\s*:/m;
const DECL_RE = /^\s*(let|const|var|function\b|class\b)/m;
const LINE_DECL_RE = /^\s*(let|const|var|function\b|class\b)/;
// The declaration lines a capability preamble is built from — see
// hydra-code.js's INIT_HYDRA_RE for the Hydra sibling of this rule. A
// declaration is a side-effecting call, not a pattern: wrapping it as a `$:`
// voice hands its return value to Strudel as if it were a pattern.
const CAPABILITY_DECL_LINE_RE = /^await\s+init(?:TextCycles|Css)\s*\(\s*\)\s*;?$/;

const COMMENT_LINE_RE = /^(\/\/.*|\/\*.*\*\/)$/;

function isBareDeclaration(text) {
  if (DECL_RE.test(text)) return true;
  return text.split('\n').every((line) => {
    const t = line.trim();
    return t === '' || CAPABILITY_DECL_LINE_RE.test(t) || COMMENT_LINE_RE.test(t);
  });
}

// `(body)` as a grouping expression. A `//` on the body's last line would
// comment out a closing paren on the same line, so then it goes on the next.
// (A `//` inside a string, `"https://…"`, only costs a harmless newline.)
function group(body) {
  const lastLine = body.slice(body.lastIndexOf('\n') + 1);
  return lastLine.includes('//') ? `(${body}\n)` : `(${body})`;
}

// Walk `text` once, calling `atBreak(i, tail)` at every newline that sits at
// top level — outside any string, template literal, comment or bracket.
// `tail` is the last two characters of code before it (whitespace and
// comments skipped; a string counts only by its closing quote, so a `.` or `,`
// inside one is never read as an open end).
function forEachTopLevelBreak(text, atBreak) {
  let depth = 0;
  let mode = null; // null | 'line' | 'block' | '"' | "'" | '`'
  let tail = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const next = text[i + 1];
    if (mode === 'line') { if (c === '\n') mode = null; else continue; }
    else if (mode === 'block') { if (c === '*' && next === '/') { mode = null; i++; } continue; }
    else if (mode) {
      if (c === '\\') { i++; continue; }
      if (c === mode) { mode = null; tail = c; }
      continue;
    }
    if (c === '\n') {
      if (depth === 0) atBreak(i, tail);
      continue;
    }
    if (c === '/' && next === '/') { mode = 'line'; i++; continue; }
    if (c === '/' && next === '*') { mode = 'block'; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') continue;
    tail = tail.slice(-1) + c;
    if (c === '"' || c === "'" || c === '`') { mode = c; continue; }
    if (c === '(' || c === '[' || c === '{') depth++;
    else if ((c === ')' || c === ']' || c === '}') && depth > 0) depth--;
  }
}

// JS's own rule for when a line break does NOT end a statement, for the
// shapes a performer actually writes: the code before it is left open (a
// trailing `.`, operator or comma), or the next line of code — blank lines
// and comments skipped — carries on the one above, above all the `.method(`
// line every Strudel chain is written in. `*` and `/` are left out of the
// line-start set: a `*name:` button declaration or a regex starts a line.
const OPEN_END_RE = /[.,=+\-*%&|^?:<>]$/;
const CLOSED_END_RE = /(?:\+\+|--)$/;
const CONTINUATION_START_RE = /^(?:\.(?!\.\.)|\?|[,=&|:]|[+-](?![+-]))/;
const SKIP_TO_CODE_RE = /(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/y;
const NON_CODE_LINE_RE = /^[ \t]*(?:\n|$|\/\/|\/\*)/;

function endsStatement(text, i, tail) {
  if (OPEN_END_RE.test(tail) && !CLOSED_END_RE.test(tail)) return false;
  SKIP_TO_CODE_RE.lastIndex = i;
  SKIP_TO_CODE_RE.exec(text);
  const at = SKIP_TO_CODE_RE.lastIndex;
  return !CONTINUATION_START_RE.test(text.slice(at, at + 3));
}

// Offsets of the lines that begin a new top-level statement (the first one
// excepted). Blank and comment-only lines never begin one, so they stay with
// the statement above them.
function statementStarts(text) {
  const starts = [];
  forEachTopLevelBreak(text, (i, tail) => {
    if (!NON_CODE_LINE_RE.test(text.slice(i + 1, i + 4)) && endsStatement(text, i, tail)) starts.push(i + 1);
  });
  return starts;
}

// Blank-line paragraphs, split only where a statement actually ends. A blank
// line inside a call (a spaced-out arrange(...) or stack(...)) or before a
// line that carries on the chain above it (`let a = s("bd")` ⏎⏎ `.fast(2)`)
// is layout, not a boundary: splitting there cut one statement into
// fragments, wrapped each as a voice (`$: (.fast(2))`), and handed Strudel a
// SyntaxError that took the whole program down.
function splitParagraphs(code) {
  const paragraphs = [];
  let start = 0;
  forEachTopLevelBreak(code, (i, tail) => {
    if (i < start || code[i + 1] !== '\n' || !endsStatement(code, i, tail)) return;
    paragraphs.push(code.slice(start, i));
    start = i + 1;
    while (code[start] === '\n') start++;
  });
  paragraphs.push(code.slice(start));
  return paragraphs;
}

// Split a paragraph into its top-level statements: a new one starts at every
// statement that opens with a label. Text before the first label (if any) is
// the first chunk. Lines are never altered, only grouped.
function splitAtLabels(text) {
  const starts = [0, ...statementStarts(text).filter((i) => LABEL_AT_START_RE.test(text.slice(i)))];
  return starts
    .map((start, k) => text.slice(start, k + 1 < starts.length ? starts[k + 1] - 1 : text.length))
    .filter((chunk) => chunk.trim());
}

// A statement that runs for its effect rather than being a pattern: a
// declaration, a capability declaration, or nothing but comments. Decided by
// its first line of code — a `let` nested inside a callback further down
// does not make the statement a declaration.
function isBareStatement(stmt) {
  const first = stmt.split('\n').map((l) => l.trim()).find((t) => t && !COMMENT_LINE_RE.test(t));
  return first == null || LINE_DECL_RE.test(first) || CAPABILITY_DECL_LINE_RE.test(first);
}

// Append `fx` to a paragraph that IS a single labeled statement (label at
// position 0), across however many lines its body spans.
function wrapLabeledParagraph(text, fx) {
  if (!fx) return text;
  const m = text.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*\s*:\s*)([\s\S]+)$/);
  if (!m) return text;
  const [, label, body] = m;
  return `${label}${group(body.trim())}${fx}`;
}

function wrapParagraph(text, fx) {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (isBareDeclaration(trimmed)) return trimmed;
  const chunks = splitAtLabels(trimmed);
  if (chunks.length > 1 || LABEL_AT_START_RE.test(trimmed)) {
    return chunks.map((chunk) => {
      const t = chunk.trim();
      if (LABEL_AT_START_RE.test(t)) return wrapLabeledParagraph(t, fx);
      return isBareDeclaration(t) ? t : `$: ${group(t)}${fx}`;
    }).join('\n');
  }
  // A plain pattern with no label at all — the performer's one "real" voice,
  // left unlabeled because on its own it needs no name. Give it an anonymous
  // voice so it is collected into the stack instead of silently discarded.
  return `$: ${group(trimmed)}${fx}`;
}

// Attach `fx` (a chain suffix such as `.distort(.2).crush(5)` or
// `.hpf(80).delay(.4).gain(.5)`) to Strudel source `rawCode`, returning code
// that is safe to splice into a larger program (strudel.js) or to hand to a
// standalone REPL on its own (the bot fleet). `fx` may be '' — nothing to
// append; existing labels/expressions still pass through correctly split.
export function wrapAsVoice(rawCode, fx = '') {
  const code = String(rawCode ?? '');
  if (!code.trim()) return code;

  if (LABEL_ANYWHERE_RE.test(code)) {
    return splitParagraphs(code).map((p) => wrapParagraph(p, fx)).filter(Boolean).join('\n\n');
  }

  // No label anywhere: the last statement is the pattern — the one strudel.cc
  // would play — and everything above it (declarations, `setcpm(...)`,
  // `await samples(...)`) runs bare, as written. Wrapping it all in one `$:
  // (...)` is a SyntaxError the moment there are two statements.
  const starts = statementStarts(code);
  const cut = starts.length ? starts[starts.length - 1] : 0;
  const last = code.slice(cut).trim();
  // Declarations, capability lines or comments only — nothing to play.
  if (isBareStatement(last)) return code;
  const before = code.slice(0, cut).trim();
  return `${before ? `${before}\n` : ''}$: ${group(last)}${fx}`;
}

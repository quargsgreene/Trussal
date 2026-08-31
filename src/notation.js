// notation.js — the one rule for a program buffer's SURFACE notation, and the
// transforms between the two the rest of the system already speaks.
//
// Every editable buffer (personal / bot / metaprogram) may be written in one
// of two notations, and never a mix — the opener decides for the WHOLE buffer:
//
//   mini   Strudel-native:  $: head("<0 1>").m1("wcl", 10).m2("wcl", 30)
//                            `.`-chained methods, parens + commas, every
//                            string quoted (metrics "wcl"/"wcpl" included),
//                            mini-notation patterns as quoted strings.
//
//   mondo  terse:            $ head <0 1>
//                            # m1 "wcl" 10
//                            # m2 "wcl" 30
//                            one `#` line per chained method, space-separated
//                            args, mini-notation patterns written bare, every
//                            other string still quoted.
//
// The two are exact equivalents. The rest of the codebase only ever consumes
// ONE of them per editor — the personal/bot path is Strudel, so it lowers
// mondo → mini (mondoToMini) before the transpiler; the metaprogram parser is
// the `$`/`#` grammar, so it lowers mini → mondo (miniToMondo) before
// tokenising. A buffer already in the notation its editor consumes passes
// through untouched.
//
// Pure module — no DOM, no imports. Runs in the browser bundle, the bots
// process (Dockerfile.bot COPY + .dockerignore allowlist), and node:test. The
// caller strips the leading directive line first; these functions see the body.

// A line that opens a mini voice: `$:` (Strudel's labelled-voice sigil).
const MINI_OPEN_RE = /^\s*\$:/;
// A line that opens a mondo voice: `$` then whitespace then a name — never
// `$:` (that is mini) and never `$(` (a Strudel expression).
const MONDO_OPEN_RE = /^\s*\$[ \t]+[A-Za-z_$]/;
// A mondo chained method: `#` at line start then whitespace then a name. `#`
// mid-line (Strudel's control-merge operator, `s("bd") # gain(1)`) never
// matches — this is anchored.
const MONDO_CHAIN_RE = /^\s*#[ \t]+[A-Za-z_$]/;
// A full-line comment — skipped when sniffing, emitted verbatim when lowering.
const COMMENT_RE = /^\s*\/\//;

// Which notation a body is written in:
//   'mini'  — has a `$:` opener (or, for a Strudel buffer, no marker at all:
//             plain `s("bd sd")` is mini with an implicit anonymous voice)
//   'mondo' — has a `$ name` opener or a `# method` line, and no `$:`
//   'mixed' — both a `$:` and a mondo marker: an error the caller surfaces
//   null    — no voice marker of either kind (an empty metaprogram; a
//             personal buffer the caller treats as pass-through mini)
export function detectNotation(body) {
  const lines = String(body ?? '').split('\n');
  let mini = false;
  let mondo = false;
  for (const line of lines) {
    if (!line.trim() || COMMENT_RE.test(line)) continue;
    if (MINI_OPEN_RE.test(line)) mini = true;
    else if (MONDO_OPEN_RE.test(line) || MONDO_CHAIN_RE.test(line)) mondo = true;
  }
  if (mini && mondo) return 'mixed';
  if (mondo) return 'mondo';
  if (mini) return 'mini';
  return null;
}

// --- arg tokenising --------------------------------------------------------
//
// Split a run of space-separated mondo args (or the inside of a mini call's
// parens) into atomic tokens. A quoted string, a bracket group (`<…>` `[…]`),
// and a parenthesised group each count as ONE token however much whitespace
// they hold; everything else breaks on whitespace (mondo) or a top-level comma
// (mini).

const OPEN = { '<': '>', '[': ']', '(': ')', '{': '}' };
const CLOSE = new Set(['>', ']', ')', '}']);
// The glued mini modifier characters — `*n /n @n !n ?n %n :n` and the `..`
// range — that stay attached to a `<…>` / `[…]` group as one token.
const MINI_MODIFIER_RE = /[*/@!?%:.\d]/;

// Read one token starting at `i`; returns { text, end } or null at end-of-input.
function readToken(src, i) {
  const n = src.length;
  while (i < n && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n')) i++;
  if (i >= n) return null;
  const start = i;
  const ch = src[i];
  if (ch === '"' || ch === "'" || ch === '`') {
    i++;
    while (i < n && src[i] !== ch) { if (src[i] === '\\') i++; i++; }
    i++; // closing quote (or end of input for a backtick left open across lines)
    return { text: src.slice(start, i), end: i };
  }
  if (OPEN[ch]) {
    let depth = 0;
    for (; i < n; i++) {
      const c = src[i];
      if (c === '"' || c === "'" || c === '`') { i++; while (i < n && src[i] !== c) { if (src[i] === '\\') i++; i++; } continue; }
      if (OPEN[c]) depth++;
      else if (CLOSE.has(c)) { depth--; if (depth === 0) { i++; break; } }
    }
    // A mini modifier glued to the group is part of the same token: `<0 1>*2`,
    // `[0 1]!3`, `<0 1>*4/2`, `0 .. 3` — the same `@ ! ? * / % : ..` grammar
    // the sequence parser reads, so it has to survive both directions of the
    // transform intact.
    while (i < n && MINI_MODIFIER_RE.test(src[i])) i++;
    return { text: src.slice(start, i), end: i };
  }
  // bare token: to next whitespace, but keep any bracket/quote group glued to
  // it whole (`sine.range(200,2000)`, `Weather:3`).
  while (i < n) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n') break;
    if (c === '"' || c === "'" || c === '`' || OPEN[c]) { const t = readToken(src, i); i = t.end; continue; }
    i++;
  }
  return { text: src.slice(start, i), end: i };
}

function tokenizeSpaced(src) {
  const out = [];
  let i = 0;
  for (;;) {
    const t = readToken(src, i);
    if (!t) break;
    out.push(t.text);
    i = t.end;
  }
  return out;
}

// Split the inside of a mini call's parens on top-level commas.
function splitTopLevelCommas(src) {
  const out = [];
  let depth = 0, start = 0, i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '"' || c === "'" || c === '`') { i++; while (i < n && src[i] !== c) { if (src[i] === '\\') i++; i++; } i++; continue; }
    if (OPEN[c]) depth++;
    else if (CLOSE.has(c)) depth--;
    else if (c === ',' && depth === 0) { out.push(src.slice(start, i).trim()); start = i + 1; }
    i++;
  }
  const last = src.slice(start).trim();
  if (last || out.length) out.push(last);
  return out;
}

// A quoted arg whose content is a mini-notation pattern: it starts with a
// `<` / `[` bracket (glued modifiers may trail it — `"<0 1>*2"`). Unquoted to
// bare in mondo. A literal string (`"wcl"`, `"Monaco"`, a device label) never
// starts with a bracket, so it keeps its quotes.
const BRACKET_STRING_RE = /^(['"])([<[][\s\S]*)\1$/;

// --- mondo → mini --------------------------------------------------------
//
// Line-for-line, so the transpiler's position-based ids and every error
// line/col stay put:
//   `$ head a b`   → `$: head(a, b)`
//   `# method a b` → `.method(a, b)`
// A bracket token becomes a quoted mini string; a quoted or bare token is
// carried through unchanged. Every other line (Hydra preamble, blank,
// comment, a plain Strudel statement) is emitted verbatim.
export function mondoToMini(body) {
  return String(body ?? '').split('\n').map((line) => {
    let m = line.match(/^(\s*)\$[ \t]+(\S[\s\S]*?)\s*$/);
    if (m && !/^\s*\$:/.test(line)) return `${m[1]}$: ${lowerMondoCall(m[2])}`;
    m = line.match(/^(\s*)#[ \t]+(\S[\s\S]*?)\s*$/);
    if (m) return `${m[1]}.${lowerMondoCall(m[2])}`;
    return line;
  }).join('\n');
}

function lowerMondoCall(rest) {
  const toks = tokenizeSpaced(rest);
  const name = toks.shift() || '';
  const args = toks.map((t) => {
    // A bracket group (with any glued modifiers) is a mini-notation pattern —
    // quote it so Strudel mini-parses it. Anything else — a quoted string, a
    // number, a bare identifier, a `(expr)` — is carried through as written.
    if (t[0] === '<' || t[0] === '[') return JSON.stringify(t);
    return t;
  });
  return `${name}(${args.join(', ')})`;
}

// --- mini → mondo --------------------------------------------------------
//
// The metaprogram parser eats the `$`/`#` grammar, so a mini metaprogram is
// rewritten to it before tokenising. A voice is a `$:` line plus its
// `.method(...)` chain (inline or on continuation lines); it becomes a `$`
// line then one `#` line per method. A quoted mini-notation pattern
// (`"<0 1>"`, `"[0 1]"`) is unquoted; every other arg — a quoted metric
// (`"wcl"`), a number, a bare token — is carried through, comma-joined args
// becoming space-separated.
//
// Line count is preserved when the mini was already written one segment per
// line (the natural form, and the one the docs show); an all-on-one-line
// chain expands to several mondo lines, so an error square below it can land
// a line or two off.
export function miniToMondo(body) {
  const src = String(body ?? '');
  const lines = src.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    // A `*$:` button declaration (JPattern editor): lower the voice after the
    // `*` and put the `*` back, so `*$: participants("<2a 2b>")` reads as the
    // `*$ participants <2a 2b>` the button scanner expects.
    const decl = line.match(/^(\s*)\*[ \t]*(\$:.*)$/);
    if (decl) { out.push(`${decl[1]}* ${miniToMondo(decl[2]).trim()}`); i++; continue; }
    if (!/^\s*\$:/.test(line)) { out.push(line); i++; continue; }
    // Gather this voice: the `$:` line and every following line that is a
    // `.method(` continuation (or the tail of a call left open across lines).
    let buf = line;
    let j = i + 1;
    while (j < lines.length) {
      const nxt = lines[j];
      if (/^\s*\$:/.test(nxt) || /^\s*\$[ \t]/.test(nxt) || /^\s*#[ \t]/.test(nxt)) break;
      if (/^\s*\.[A-Za-z_$]/.test(nxt) || !balanced(buf)) { buf += '\n' + nxt; j++; continue; }
      break;
    }
    const indent = (line.match(/^(\s*)/) || ['', ''])[1];
    const mondo = voiceToMondo(buf, indent);
    out.push(...mondo);
    // A voice written one segment per line produces exactly as many mondo
    // lines; pad if it produced fewer so nothing below shifts up. (An
    // all-on-one-line chain still expands — accepted, see the doc above.)
    for (let pad = mondo.length; pad < j - i; pad++) out.push('');
    i = j;
  }
  return out.join('\n');
}

function balanced(s) {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' || c === "'" || c === '`') { i++; while (i < s.length && s[i] !== c) { if (s[i] === '\\') i++; i++; } continue; }
    if (OPEN[c]) depth++;
    else if (CLOSE.has(c)) depth--;
  }
  return depth <= 0;
}

// `$: head(a, b).m1(c).m2(d)` (newlines allowed) → ['$ head a b', '# m1 c', '# m2 d']
function voiceToMondo(buf, indent) {
  const body = buf.replace(/^\s*\$:\s*/, '');
  const segs = splitCallChain(body); // [{name, args}]
  if (!segs.length) return [`${indent}$: ${body.trim()}`]; // unrecognised — leave it
  const lines = [];
  segs.forEach((seg, k) => {
    const args = splitTopLevelCommas(seg.args).map(unquoteMiniPattern).filter((a) => a !== '');
    const head = k === 0 ? `${indent}$ ` : `${indent}# `;
    lines.push(`${head}${seg.name}${args.length ? ' ' + args.join(' ') : ''}`.trimEnd());
  });
  return lines;
}

// Break `name(args).name(args).name(args)` into segments at top-level `.`
// followed by an identifier and `(`.
function splitCallChain(src) {
  const segs = [];
  let i = 0;
  const n = src.length;
  const readName = () => {
    const m = src.slice(i).match(/^([A-Za-z_$][\w$]*)\s*\(/);
    if (!m) return null;
    i += m[0].length; // past the '('
    let depth = 1;
    const argStart = i;
    while (i < n && depth > 0) {
      const c = src[i];
      if (c === '"' || c === "'") { i++; while (i < n && src[i] !== c) { if (src[i] === '\\') i++; i++; } i++; continue; }
      if (c === '(' || OPEN[c]) depth++;
      else if (c === ')' || CLOSE.has(c)) depth--;
      if (depth === 0) break;
      i++;
    }
    const args = src.slice(argStart, i);
    i++; // past ')'
    return { name: m[1], args };
  };
  const first = readName();
  if (!first) return [];
  segs.push(first);
  while (i < n) {
    while (i < n && /\s/.test(src[i])) i++;
    if (src[i] !== '.') break;
    i++;
    while (i < n && /\s/.test(src[i])) i++;
    const seg = readName();
    if (!seg) break;
    segs.push(seg);
  }
  return segs;
}

// `"<0 1>"` / `'[0 1]'` → `<0 1>` / `[0 1]`; anything else unchanged.
function unquoteMiniPattern(arg) {
  const m = arg.match(BRACKET_STRING_RE);
  return m ? m[2] : arg;
}

// --- one call for a caller that just wants the consumable form -----------

// Lower `body` (directive already stripped) to the notation `target` editor
// consumes ('mini' for personal/bot, 'mondo' for the metaprogram). Returns
// { text, notation, error }: `error` is set only for a 'mixed' buffer.
export function toConsumableNotation(body, target) {
  const notation = detectNotation(body);
  if (notation === 'mixed') {
    return {
      text: String(body ?? ''),
      notation,
      error: 'this buffer mixes mini ($: …) and mondo ($ … / # …) notation — a program is written entirely in one or the other',
    };
  }
  if (target === 'mini') {
    return { text: notation === 'mondo' ? mondoToMini(body) : String(body ?? ''), notation: notation === 'mondo' ? 'mondo' : 'mini' };
  }
  // target 'mondo' (the metaprogram)
  return { text: notation === 'mini' ? miniToMondo(body) : String(body ?? ''), notation: notation === 'mini' ? 'mini' : 'mondo' };
}

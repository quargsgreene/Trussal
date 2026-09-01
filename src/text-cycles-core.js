// Pure logic for Text Cycles: mini-notation escaping, CSS/href sanitising and
// statement scanning. No DOM, no Strudel — runs identically in the browser
// bundle and under node:test. The browser glue lives in text-cycles.js.
//
// --- Why any of this is needed ----------------------------------------------
//
// A text pattern wants two incompatible things from one string: mini notation
// operators must stay live (`<a b>` alternates, `~` rests, `?` degrades, `@2`
// elongates) while the words themselves must survive verbatim — spaces, "?",
// emoji, "#" and ":" included. Strudel's krill grammar cannot express that:
// a bare atom is `unicode_letter / [0-9~] / "-" / "#" / "." / "^" / "_"`
// (krill.pegjs:107), so an emoji is a parse error, "color:#fff" is an atom with
// a sample index, and a literal "?" is impossible.
//
// So every literal atom is MINTED into a placeholder token (`tc0`, `tc1`, …)
// that is trivially grammar-legal, and the real text is carried out-of-band in
// an atom table the renderer resolves at trigger time. Operators are passed
// through untouched, so the pattern still means what it looks like.
//
// Escaping: a backslash makes the next character literal atom text, so `\~`
// renders a tilde instead of resting. This MUST run on raw source, before
// Strudel's transpiler: JS itself discards unknown escapes ("\~" === "~"), and
// the transpiler's double-quote plugin reads node.value — the post-escape
// string — so a backslash that reaches evaluate() is already gone.

// Params that carry text-cycles values. `size` and `color` are deliberately
// absent: they are pre-existing Strudel controls (roomsize alias, and color),
// reused as-is so registering ours would not clobber `.size()` for every audio
// voice in the room. They are still rewritten — see TEXT_VALUE_PARAMS.
// `css` is deliberately absent: styling is its own capability now, declared
// with initCss() and addressing selectors rather than the words themselves.
// A text span is reachable from there as `.tc-word` or `.tc-p-<jitsiId>`.
export const TEXT_PARAMS = [
  'word', 'w', 'typeface', 't', 'weight', 'spacing', 'slant',
  'hover', 'hyperlink', 'underline',
];

// Everything rewritten inside a text statement, including the two borrowed
// controls. Longest-first so `word` is consumed before `w` can see it.
export const TEXT_VALUE_PARAMS = [...TEXT_PARAMS, 'size', 'color']
  .sort((a, b) => b.length - a.length);

// Mini operators that keep their meaning when unescaped. `~` rests and `?`
// degrades, which is exactly what an escape has to be able to opt out of.
const STRUCTURAL = new Set(['<', '>', '[', ']', '{', '}', ',', '|', '~']);

// Operators taking a trailing numeric argument (`*2`, `@2`, `?0.3`, `!3`).
// The number is pattern structure, never text, so it passes through verbatim.
const NUM_ARG_OPS = new Set(['*', '/', '!', '@', '%', '?']);

const STRING_LITERAL = '("(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`(?:[^`\\\\]|\\\\.)*`)';

// A labeled voice line: `$: …` or `name: …`. Statements are split on these so
// a text rewrite never reaches an audio voice sharing the same program.
const LABEL_RE = /^\s*(?:\$|[a-zA-Z_$][\w$]*)\s*:/;

// `word(` / `w(` in any position, including as a chained method — unlike
// rewriteLiveCaptureCalls we WANT to match `.word(`, so "." is allowed to precede.
export const WORD_CALL_RE = /(?:^|[^\w$])(?:word|w)\s*\(/;

const INIT_TEXT_CYCLES_RE = /^\s*await\s+initTextCycles\s*\(/m;

// The declaration rule as a serialisable descriptor, for consumers that cannot
// import a module — the bot's page scripts are function bodies handed to
// Chromium by puppeteer and can only receive JSON. Mirrors INIT_HYDRA_PATTERN.
export const INIT_TEXT_CYCLES_PATTERN = {
  source: INIT_TEXT_CYCLES_RE.source,
  flags: INIT_TEXT_CYCLES_RE.flags,
};

export function hasTextCycles(code) {
  return INIT_TEXT_CYCLES_RE.test(String(code ?? ''));
}

// Split a program into statements, each flagged with whether it contains a
// word() call. A text param outside such a statement is inert (nothing renders
// without a word), so leaving those alone keeps audio voices untouched.
export function splitStatements(code) {
  const lines = String(code ?? '').split('\n');
  const out = [];
  let cur = [];
  for (const line of lines) {
    if (LABEL_RE.test(line) && cur.length) {
      out.push(cur.join('\n'));
      cur = [];
    }
    cur.push(line);
  }
  if (cur.length) out.push(cur.join('\n'));
  return out.map((text) => ({ text, hasWord: WORD_CALL_RE.test(text) }));
}

// Walk one mini string, minting literal atoms and passing operators through.
// `mint(text)` records the atom and returns its placeholder token.
export function encodeMiniText(src, mint) {
  let out = '';
  let atom = '';
  const flush = () => {
    if (atom === '') return;
    // A lone "." is mini's subdivision operator; inside a word it is just text
    // ("google.com"), which is why this is checked on the whole atom.
    out += atom === '.' ? '.' : mint(atom);
    atom = '';
  };
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '\\') {
      // Escape: next character is literal text, backslash consumed. A trailing
      // backslash has nothing to escape and is literal itself.
      if (i + 1 < src.length) atom += src[++i];
      else atom += '\\';
      continue;
    }
    if (/\s/.test(c)) { flush(); out += c; continue; }
    if (STRUCTURAL.has(c)) { flush(); out += c; continue; }
    if (NUM_ARG_OPS.has(c)) {
      flush();
      out += c;
      let j = i + 1;
      while (j < src.length && /[0-9.]/.test(src[j])) out += src[j++];
      i = j - 1;
      continue;
    }
    if (c === '(') {
      // Euclid arguments are numeric structure — copy through to the match.
      flush();
      let depth = 0;
      let j = i;
      for (; j < src.length; j++) {
        out += src[j];
        if (src[j] === '(') depth++;
        else if (src[j] === ')' && --depth === 0) break;
      }
      i = j;
      continue;
    }
    atom += c;
  }
  flush();
  return out;
}

// Raw JS string literal → the characters between its quotes, with the quoting
// style. Deliberately NOT JSON.parse: that would eat the backslashes this
// module exists to read.
function literalBody(raw) {
  return { quote: raw[0], body: raw.slice(1, -1) };
}

// Rewrite every text param in `code`, minting literal atoms into tokens.
// Returns the rewritten source plus the atom table entries it created.
//
// A single-quoted argument is left fully literal (no mini): the transpiler
// ignores single quotes, so `word('I like ~ squirrels?')` is one whole phrase
// with no escaping needed. It is still minted, so the renderer can attribute
// it to a peer like any other atom.
export function rewriteTextCalls(code, { peer = null, counter = { n: 0 } } = {}) {
  const atoms = {};
  const mint = (text) => {
    const token = `tc${counter.n++}`;
    atoms[token] = { text, peer };
    return token;
  };

  // One pass over each statement, alternating longest-name-first so `word`
  // wins over `w`. A pass per param would renumber tokens out of source order
  // and re-scan text an earlier param had already rewritten.
  const re = new RegExp(
    `((?:^|[^\\w$])(?:${TEXT_VALUE_PARAMS.join('|')})\\s*\\(\\s*)${STRING_LITERAL}`,
    'g',
  );

  const rewriteStatement = ({ text, hasWord }) => {
    if (!hasWord) return text;
    const out = text.replace(re, (match, head, raw) => {
      // An interpolated template literal cannot be decoded statically.
      if (raw[0] === '`' && raw.includes('${')) return match;
      const { quote, body } = literalBody(raw);
      // Single quotes bypass mini entirely — the whole body is one atom.
      const encoded = quote === "'" ? mint(body) : encodeMiniText(body, mint);
      return `${head}"${encoded}"`;
    });
    // Attach the renderer to THIS statement only. It carries the dominant
    // onTrigger, which suppresses webaudio for the voice — appending it to a
    // whole block (the way effects are appended) would silence audio voices
    // sharing the program. On its own line so a trailing // comment is safe.
    return `${out.replace(/[\s;]+$/, '')}\n._tcRender()`;
  };

  // Paragraph-aware (blank-line-separated), not just label-aware: splitStatements
  // has no notion of a blank line, so anything that follows a word()/typeface()
  // voice with no `$:` label of its own — a bare capability declaration, or an
  // unlabeled trailing audio pattern — is swept into the SAME statement and
  // gets `._tcRender()` appended directly onto it instead of onto the voice
  // alone. On a declaration (`await initTextCycles()._tcRender()`) that throws
  // outright, taking the WHOLE program's evaluate() down; on a bare pattern it
  // silently mutes it, since the dominant trigger it never asked for now sits
  // on its hap too. Splitting into paragraphs first keeps each on its own line,
  // exactly as it reads on the page.
  const rewritten = String(code ?? '').split(/\n\n+/)
    .map((paragraph) => splitStatements(paragraph).map(rewriteStatement).join('\n'))
    .join('\n\n');

  return { code: rewritten, atoms };
}

// --- Sanitising -------------------------------------------------------------
//
// Every word, style and link a peer writes is injected into EVERY participant's
// DOM, so none of it is trusted. Text itself is safe by construction (the
// renderer uses textContent), but CSS reaches a stylesheet and links reach an
// href, and both need real filtering.

// Values that can fetch, escape the rule, or execute.
const CSS_VALUE_BLOCK = /url\s*\(|expression\s*\(|javascript\s*:|@import|<\/|[{}<>;]/i;
const CSS_PROP_OK = /^-{0,2}[a-zA-Z][a-zA-Z0-9-]*$/;
// Legacy properties that load and run code from a stylesheet. Layout props are
// deliberately NOT blocked — "margin: 50%" is the kind of disruption this
// instrument is for.
const CSS_PROP_BLOCK = new Set(['behavior', '-moz-binding']);

// "color: blue; margin: 50%" or {color: 'blue'} → [[prop, value], …].
// Anything unparseable or dangerous is dropped rather than escaped, so a bad
// declaration can never reshape the rule it sits in.
export function sanitizeDeclarations(input) {
  if (!input) return [];
  const pairs = [];
  if (typeof input === 'object') {
    for (const [prop, value] of Object.entries(input)) pairs.push([prop, value]);
  } else {
    for (const chunk of String(input).split(';')) {
      if (!chunk.trim()) continue;
      const idx = chunk.indexOf(':');
      if (idx === -1) continue;
      pairs.push([chunk.slice(0, idx), chunk.slice(idx + 1)]);
    }
  }
  const out = [];
  for (const [rawProp, rawValue] of pairs) {
    const prop = String(rawProp).trim().toLowerCase();
    const value = String(rawValue ?? '').trim();
    if (!prop || !value) continue;
    if (!CSS_PROP_OK.test(prop) || CSS_PROP_BLOCK.has(prop)) continue;
    // The split above already consumed ";", so a survivor means an injection
    // attempt; braces/angles would break out of the generated rule.
    if (CSS_VALUE_BLOCK.test(value)) continue;
    out.push([prop, value]);
  }
  return out;
}

// A bare domain gets https. Only http/https/mailto survive; javascript: and
// data: are the phishing/XSS vectors and are dropped outright.
export function sanitizeHref(url) {
  const raw = String(url ?? '').trim();
  if (!raw || /[\s<>"']/.test(raw)) return null;
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw) ? raw : `https://${raw}`;
  if (!/^(https?|mailto):/i.test(withScheme)) return null;
  return withScheme;
}

// Per-participant CSS class. Each peer's words are scoped to their own class so
// one performer's styling can never restyle another's lines.
export function peerTextClass(jitsiId) {
  const safe = String(jitsiId ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return `tc-p-${safe || 'anon'}`;
}

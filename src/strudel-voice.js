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

const LABEL_AT_START_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*\s*:/;
const LABEL_ANYWHERE_RE = /^[a-zA-Z_$][a-zA-Z0-9_$]*\s*:/m;
const DECL_RE = /^\s*(let|const|var|function\b|class\b)/m;
const LINE_DECL_RE = /^\s*(let|const|var|function\b|class\b)/;
// The declaration lines a capability preamble is built from — see
// hydra-code.js's INIT_HYDRA_RE for the Hydra sibling of this rule. A
// declaration is a side-effecting call, not a pattern: wrapping it as a `$:`
// voice hands its return value to Strudel as if it were a pattern.
const CAPABILITY_DECL_LINE_RE = /^await\s+init(?:TextCycles|Css)\s*\(\s*\)\s*;?$/;

function isBareDeclaration(text) {
  if (DECL_RE.test(text)) return true;
  return text.split('\n').every((line) => {
    const t = line.trim();
    return t === '' || CAPABILITY_DECL_LINE_RE.test(t);
  });
}

// Split preamble from trailing expression for a paragraph with no label
// anywhere: `let x = 5\nn(x)` labels only the expression, since wrapping a
// declaration in `$: (...)` is a SyntaxError (declarations are statements).
function splitDeclAndExpr(code) {
  const lines = code.split('\n');
  let lastDeclLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (LINE_DECL_RE.test(lines[i])) lastDeclLine = i;
  }
  if (lastDeclLine === -1) return null;
  let exprStart = -1;
  for (let i = lastDeclLine + 1; i < lines.length; i++) {
    if (lines[i].trim()) { exprStart = i; break; }
  }
  if (exprStart === -1) return null;
  return {
    preamble: lines.slice(0, exprStart).join('\n').trim(),
    expr: lines.slice(exprStart).join('\n').trim(),
  };
}

// Append `fx` to a paragraph that IS a single labeled statement (label at
// position 0), across however many lines its body spans.
function wrapLabeledParagraph(text, fx) {
  if (!fx) return text;
  const m = text.match(/^([a-zA-Z_$][a-zA-Z0-9_$]*\s*:\s*)([\s\S]+)$/);
  if (!m) return text;
  const [, label, body] = m;
  return `${label}(${body.trim()})${fx}`;
}

function wrapParagraph(text, fx) {
  const trimmed = text.trim();
  if (!trimmed) return '';
  if (isBareDeclaration(trimmed)) return trimmed;
  if (LABEL_AT_START_RE.test(trimmed)) return wrapLabeledParagraph(trimmed, fx);
  const labelPos = trimmed.search(LABEL_ANYWHERE_RE);
  if (labelPos > 0) {
    const decl = trimmed.slice(0, labelPos).trim();
    const rest = trimmed.slice(labelPos);
    const declPart = isBareDeclaration(decl) ? decl : `$: (${decl})${fx}`;
    return `${declPart}\n${wrapLabeledParagraph(rest, fx)}`;
  }
  // A plain pattern with no label at all — the performer's one "real" voice,
  // left unlabeled because on its own it needs no name. Give it an anonymous
  // voice so it is collected into the stack instead of silently discarded.
  return `$: (${trimmed})${fx}`;
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
    return code.split(/\n\n+/).map((p) => wrapParagraph(p, fx)).filter(Boolean).join('\n\n');
  }

  // No label anywhere: a bare pattern, or declarations followed by one.
  if (DECL_RE.test(code)) {
    const split = splitDeclAndExpr(code);
    if (split) return `${split.preamble}\n$: (${split.expr})${fx}`;
    // Declarations only, no trailing expression — nothing to play.
    return code;
  }
  return `$: (${code})${fx}`;
}

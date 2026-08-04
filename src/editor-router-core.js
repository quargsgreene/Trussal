// Editor routing — pure core.
//
// Two editors coexist in the studio: the personal Strudel textarea
// ('.ts-code' in the detail panel) and the global Net Cycles metaprogram
// editor ('.ts-code.nc-code', CRDT-bound). Head-cursor mutators, gesture
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

// classNames: iterable/array of class names (e.g. from element.classList).
export function classifyEditor(classNames) {
  const set = new Set(classNames || []);
  if (set.has('nc-code')) return 'netcycles';
  if (set.has('ts-code')) return 'strudel';
  return null;
}

// User-defined regex mutation, shared by both editor targets. Invalid
// patterns are a no-op (never throw mid-performance).
export function applyRegexMutation(code, pattern, replacement) {
  try { return code.replace(new RegExp(pattern, 'g'), replacement ?? ''); } catch { return code; }
}

// NetCyclesButton snippet toggling on metaprogram text: first dwell adds the
// line, next dwell comments it out, next re-activates (mirrors the Strudel
// voice-button marker convention).
export const NC_BTN_MARKER = ' // netcycles-btn';

// A `*`-prefixed statement declares a button instead of running: `*$ …` for a
// scheduling voice, `*# …` for an effect. The declaration itself is inert (the
// parser skips the line); the button is what writes it into the program. This
// is the metaprogram's half of the personal editor's `*name: code` buttons —
// same declaration shape, same toggle, same head-cursor dwell target.
const NC_BTN_DECL_RE = /^[ \t]*\*[ \t]*([$#])[ \t]*(\S[^\n]*?)[ \t\r]*$/;

// Every button a metaprogram declares, in source order:
//   { snippet, label, active }
// `snippet` is the statement the button writes ('$ participants <2a>');
// `active` says whether it is currently in force, which for a scheduling
// voice means its tokens are in the live sequence and for anything else means
// its marked line is present and uncommented.
export function parseNetCyclesButtons(text) {
  const buttons = [];
  const seen = new Set();
  for (const line of String(text ?? '').split('\n')) {
    const m = NC_BTN_DECL_RE.exec(line);
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
      active: isNetCyclesSnippetActive(text, snippet)
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
  const m = /^\$\s*participants\s*[<[]([^\]>]*)[\]>]\s*$/.exec(String(snippet ?? '').trim());
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
export function isNetCyclesSnippetActive(text, snippet) {
  const cur = text || '';
  const tokens = participantTokensIn(snippet);
  if (tokens) return hasParticipantSequence(cur) && tokens.every(t => programHasParticipant(cur, t));
  return cur.includes(`\n${snippet}${NC_BTN_MARKER}`);
}

export function toggleNetCyclesSnippet(text, snippet) {
  const cur = text || '';
  const tokens = participantTokensIn(snippet);
  if (tokens) {
    if (!hasParticipantSequence(cur)) {
      const head = cur.replace(/\s*$/, '');
      return head ? `${head}\n${snippet}\n` : `${snippet}\n`;
    }
    // Turning a voice off empties the ring when it is the only one in it. That
    // is an invalid program and the editor says so, but it is recoverable —
    // pressing the button again puts the voice straight back.
    const on = tokens.every(t => programHasParticipant(cur, t));
    return tokens.reduce(
      (acc, t) => (on ? removeParticipantFromProgram(acc, t) : appendParticipantToProgram(acc, t)),
      cur
    );
  }
  const active = `\n${snippet}${NC_BTN_MARKER}`;
  const commented = `\n// ${snippet}${NC_BTN_MARKER}`;
  if (cur.includes(commented)) return cur.replace(commented, active);
  if (cur.includes(active)) return cur.replace(active, commented);
  return cur + active;
}

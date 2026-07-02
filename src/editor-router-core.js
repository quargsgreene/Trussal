// Editor routing — pure core.
//
// Two editors coexist in the studio: the personal Strudel textarea
// ('.ts-code' in the detail panel) and the global Net Cycles metaprogram
// editor ('.ts-code.nc-code', CRDT-bound). Head-cursor mutators, gesture
// handlers, and the on-screen keyboard all act on "whichever editor is
// focused"; classification and the regex mutation itself are pure so they
// run under node:test.

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

export function toggleNetCyclesSnippet(text, snippet) {
  const cur = text || '';
  const active = `\n${snippet}${NC_BTN_MARKER}`;
  const commented = `\n// ${snippet}${NC_BTN_MARKER}`;
  if (cur.includes(commented)) return cur.replace(commented, active);
  if (cur.includes(active)) return cur.replace(active, commented);
  return cur + active;
}

// css-cycles-suppress.js — one flag: may peer CSS Cycles sheets restyle THIS
// browser's view?
//
// The per-user "Disable CSS changes" theme toggle (src/theme-context.js) flips
// it. css-cycles.js reads it before installing any peer's compiled sheet and
// subscribes here so a toggle takes effect at once rather than on the next
// peer-state tick.
//
// It lives in its own module — with no imports — so theme-context.js can set it
// from the lobby without pulling css-cycles.js and its peer-state dependency
// graph onto the welcome page.

let suppressed = false;
const subscribers = new Set();

export function isCssCyclesSuppressed() {
  return suppressed;
}

export function setCssCyclesSuppressed(on) {
  const next = !!on;
  if (next === suppressed) return;
  suppressed = next;
  for (const fn of subscribers) {
    try { fn(suppressed); } catch (e) { /* a listener throwing is not this module's problem */ }
  }
}

export function onCssCyclesSuppressChange(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

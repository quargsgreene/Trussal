// theme-context.js — the per-user theme store.
//
// One place that holds a single viewer's theme choices, persists them to THIS
// browser's localStorage, and applies them to the live page — the lobby, the
// prejoin screen and the in-call UI alike. Nothing here crosses the wire: a
// theme is a personal view preference, so changing it only ever repaints the
// one browser that changed it (unlike CSS Cycles, which every peer receives).
//
// The flat monochrome theme (docker-jitsi-meet/jitsi-web/custom.css and
// src/studio.css) is authored against four CSS custom properties:
//
//   --trussal-primary     the light anchor — "what is currently #EEEEEE"
//   --trussal-secondary   the dark anchor  — "what is currently #111111"
//   --trussal-font        the UI font
//   --trussal-font-scale  a unitless multiplier on every studio font-size (1 = as authored)
//
// so a personal theme is those values reassigned on :root:
//
//   * Dark mode   — swaps the two anchors.
//   * Primary / Secondary colour fields — replace an anchor outright (a filled
//     field wins; Dark mode then swaps the resulting pair).
//   * Font        — picks --trussal-font from a web-safe list.
//   * Font scale  — multiplies --trussal-font-scale; studio.css folds it into
//     every `font-size` via calc(), so 2 renders the studio's text twice as big.
//   * Invert      — a root-level CSS filter that flips every rendered colour
//     (media excepted), on top of whatever the anchors resolve to.
//   * Disable CSS changes — routed to css-cycles-suppress.js: peer CSS Cycles
//     sheets stop restyling this view, so the personal theme is not overridden.

import { setCssCyclesSuppressed } from './css-cycles-suppress.js';

const STORAGE_KEY = 'trussal.theme.v1';

// Defaults the CSS `var(--trussal-*, <fallback>)` references also carry, so the
// page still renders correctly in the window before this module runs (and if
// localStorage is unreadable). The light anchor is #eeeeee — the documented
// canonical value the theme is built around.
export const DEFAULT_PRIMARY = '#eeeeee';
export const DEFAULT_SECONDARY = '#111111';
export const DEFAULT_FONT = 'Arial, Helvetica, sans-serif';

// The "Font scale:" field. 1 renders the studio text at its authored size; the
// value is a plain multiplier (2 → twice as large). Clamped to a range that
// stays legible without collapsing or bursting the fixed-size overlay.
export const DEFAULT_FONT_SCALE = 1;
export const MIN_FONT_SCALE = 0.5;
export const MAX_FONT_SCALE = 5;

// The dropdown's options: families installed on effectively every desktop OS,
// plus the two generic stacks. `value` is dropped into `font-family` verbatim.
export const WEB_SAFE_FONTS = [
  { label: 'Arial (default)', value: DEFAULT_FONT },
  { label: 'Helvetica', value: 'Helvetica, Arial, sans-serif' },
  { label: 'Verdana', value: 'Verdana, Geneva, sans-serif' },
  { label: 'Tahoma', value: 'Tahoma, Geneva, sans-serif' },
  { label: 'Trebuchet MS', value: '"Trebuchet MS", Helvetica, sans-serif' },
  { label: 'Georgia', value: 'Georgia, "Times New Roman", serif' },
  { label: 'Times New Roman', value: '"Times New Roman", Times, serif' },
  { label: 'Courier New', value: '"Courier New", Courier, monospace' },
  { label: 'Monospace', value: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
];

const DEFAULT_THEME = {
  darkMode: false,
  disableCss: false,
  invert: false,
  primary: '',     // '' → use DEFAULT_PRIMARY
  secondary: '',    // '' → use DEFAULT_SECONDARY
  font: DEFAULT_FONT,
  fontScale: DEFAULT_FONT_SCALE,  // stored raw (may be a string from the form); normalised on apply
};

// --- Pure helpers (unit-tested without a DOM) -------------------------------

// A 3- or 6-digit hex colour, with or without the leading '#'. Anything else
// (a name, an rgb(), junk) is rejected — the picker only promises hex.
export function isHexColor(value) {
  return typeof value === 'string' && /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value.trim());
}

// A hex colour normalised to `#rrggbb` lower-case, or '' when it is not one.
export function normalizeHex(value) {
  if (!isHexColor(value)) return '';
  let hex = value.trim().replace(/^#/, '').toLowerCase();
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  return `#${hex}`;
}

// True when `value` is (or parses to) a finite number inside the allowed font-
// scale range. Accepts a string so the form's raw field value can be checked.
export function isFontScale(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  return Number.isFinite(n) && n >= MIN_FONT_SCALE && n <= MAX_FONT_SCALE;
}

// A font-scale coerced to a number and clamped into range; anything unparseable
// falls back to DEFAULT_FONT_SCALE (the same "invalid → default" rule the colour
// fields follow).
export function normalizeFontScale(value) {
  const n = typeof value === 'number' ? value : parseFloat(value);
  if (!Number.isFinite(n)) return DEFAULT_FONT_SCALE;
  return Math.min(MAX_FONT_SCALE, Math.max(MIN_FONT_SCALE, n));
}

// The pair of anchor colours a theme resolves to, before Invert. A filled
// colour field replaces its default; Dark mode swaps the resulting pair.
export function effectiveAnchors(theme) {
  const t = { ...DEFAULT_THEME, ...(theme || {}) };
  let primary = normalizeHex(t.primary) || DEFAULT_PRIMARY;
  let secondary = normalizeHex(t.secondary) || DEFAULT_SECONDARY;
  if (t.darkMode) [primary, secondary] = [secondary, primary];
  return { primary, secondary };
}

// --- Store ----------------------------------------------------------------

let state = { ...DEFAULT_THEME };
const subscribers = new Set();

function loadState() {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY);
    if (raw) state = { ...DEFAULT_THEME, ...JSON.parse(raw) };
  } catch (e) {
    console.warn('[theme] could not read the stored theme', e);
  }
}

function persist() {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn('[theme] could not persist the theme', e);
  }
}

export function getTheme() {
  return { ...state };
}

// Merge a partial change, persist it, apply it, and notify subscribers.
// Unknown keys are ignored so a caller can hand the whole form object in.
export function setTheme(patch) {
  const next = { ...state };
  for (const key of Object.keys(DEFAULT_THEME)) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }
  state = next;
  persist();
  applyTheme();
  for (const fn of subscribers) {
    try { fn(getTheme()); } catch (e) { /* a subscriber throwing is its own problem */ }
  }
  return getTheme();
}

export function subscribeTheme(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// --- Apply --------------------------------------------------------------

const INVERT_STYLE_ID = 'trussal-personal-invert';

function ensureInvertStyle(on) {
  const doc = globalThis.document;
  if (!doc?.head) return;
  let el = doc.getElementById(INVERT_STYLE_ID);
  if (!on) {
    el?.remove();
    return;
  }
  if (!el) {
    el = doc.createElement('style');
    el.id = INVERT_STYLE_ID;
    doc.head.appendChild(el);
  }
  // Flip the whole document, then flip real media back so only the chrome
  // inverts. `filter` on <html> establishes a containing block for fixed
  // elements — acceptable for an opt-in personal toggle.
  el.textContent = [
    'html { filter: invert(1) hue-rotate(180deg); }',
    'img, video, canvas, iframe, #largeVideo, #largeVideoWrapper,',
    '#hydra-canvas, [id^="hydra"], .videocontainer video, .videocontainer canvas',
    '{ filter: invert(1) hue-rotate(180deg); }',
  ].join('\n');
}

// Write the resolved theme onto the live page. Safe to call repeatedly and
// safe to call before <head> exists (the invert <style> is simply deferred to
// the next call).
export function applyTheme() {
  const doc = globalThis.document;
  const root = doc?.documentElement;
  if (root?.style) {
    const { primary, secondary } = effectiveAnchors(state);
    root.style.setProperty('--trussal-primary', primary);
    root.style.setProperty('--trussal-secondary', secondary);
    root.style.setProperty('--trussal-font', state.font || DEFAULT_FONT);
    root.style.setProperty('--trussal-font-scale', String(normalizeFontScale(state.fontScale)));
  }
  ensureInvertStyle(state.invert);
  setCssCyclesSuppressed(state.disableCss);
}

// --- Boot -------------------------------------------------------------

loadState();
applyTheme();

if (globalThis.document && globalThis.document.readyState === 'loading') {
  // <head> may not exist yet for the invert <style>; re-apply once it does.
  globalThis.document.addEventListener('DOMContentLoaded', applyTheme, { once: true });
}

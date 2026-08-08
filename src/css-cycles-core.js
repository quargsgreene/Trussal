// Pure logic for CSS Cycles: SCSS scanning, statement rewriting, guardrail
// validation and colour maths. No DOM, no Strudel, no network — runs
// identically in the browser bundle and under node:test. The browser glue
// lives in css-cycles.js, the SCSS compile itself on the latency sidecar.
//
// --- The shape of a statement ------------------------------------------------
//
//   $: css(`.example { &:hover { text-decoration: underline } }`)
//        .color("<#ffffff #eeeeee #34e3df>/4")
//        .borderRadius("<^2em / 1em 3em 0.5em^ ^0.2em 1em 4em 1em^>")
//        .fast(3)
//
// The backticked argument is SCSS — nesting, `&`, `$vars`, `@media`,
// `@keyframes`. Backticks rather than double quotes for two reasons: a
// double-quoted string is mini-parsed, so `.example` would hit `.` as the
// subdivision operator; and `{}` is dropped outright by value sanitising.
//
// Chained camelCase names that are real CSS properties become patterned
// declarations on that block. Everything else in the chain (`fast`, `slow`,
// `every`, `off`, `jux`…) is left alone as Strudel pattern structure.
//
// --- Two speeds --------------------------------------------------------------
//
// SCSS is compiled once per code-state update (the cold path: editor change →
// sendLocalScss → sidecar → compiledCss broadcast). Patterned values cannot
// wait for that round-trip, so each one compiles to a CSS custom property and
// the per-hap trigger only reassigns it on :root. The var name is derived from
// the statement's own token, so every browser computes the same name the
// authoring browser baked into the sheet.
//
// --- Reach -------------------------------------------------------------------
//
// A rule reaches the full property set only where it matches inside a Trussal
// root. Everywhere else in the page it is re-emitted carrying the allowlist
// alone: every colour, border and font property — layout, position, size and
// visibility stay Trussal-surface-only. Both copies are subject to every
// guardrail.

import { splitStatements } from './text-cycles-core.js';

// --- Property tables ---------------------------------------------------------

// Hyphenated CSS property names the chain may address. Static rather than
// probed from CSSStyleDeclaration on purpose: the rewrite has to be identical
// on every browser in the room, and a client shipping a newer property than
// its peers would otherwise mint a different program from the same source.
const CSS_PROPERTIES = new Set([
  'accent-color', 'align-content', 'align-items', 'align-self', 'all', 'animation',
  'animation-delay', 'animation-direction', 'animation-duration', 'animation-fill-mode',
  'animation-iteration-count', 'animation-name', 'animation-play-state', 'animation-timing-function',
  'aspect-ratio', 'backdrop-filter', 'backface-visibility', 'background', 'background-attachment',
  'background-blend-mode', 'background-clip', 'background-color', 'background-image',
  'background-origin', 'background-position', 'background-repeat', 'background-size',
  'block-size', 'border', 'border-block', 'border-bottom', 'border-bottom-color',
  'border-bottom-left-radius', 'border-bottom-right-radius', 'border-bottom-style',
  'border-bottom-width', 'border-collapse', 'border-color', 'border-image', 'border-image-outset',
  'border-image-repeat', 'border-image-slice', 'border-image-source', 'border-image-width',
  'border-inline', 'border-left', 'border-left-color', 'border-left-style', 'border-left-width',
  'border-radius', 'border-right', 'border-right-color', 'border-right-style', 'border-right-width',
  'border-spacing', 'border-style', 'border-top', 'border-top-color', 'border-top-left-radius',
  'border-top-right-radius', 'border-top-style', 'border-top-width', 'border-width', 'bottom',
  'box-shadow', 'box-sizing', 'caption-side', 'caret-color', 'clear', 'clip-path', 'color',
  'color-scheme', 'column-count', 'column-gap', 'column-rule', 'column-rule-color',
  'column-rule-style', 'column-rule-width', 'column-span', 'column-width', 'columns', 'content',
  'content-visibility', 'counter-increment', 'counter-reset', 'cursor', 'direction', 'display',
  'empty-cells', 'filter', 'flex', 'flex-basis', 'flex-direction', 'flex-flow', 'flex-grow',
  'flex-shrink', 'flex-wrap', 'float', 'font', 'font-family', 'font-feature-settings',
  'font-kerning', 'font-optical-sizing', 'font-size', 'font-size-adjust', 'font-stretch',
  'font-style', 'font-synthesis', 'font-variant', 'font-variant-caps', 'font-variant-numeric',
  'font-variation-settings', 'font-weight', 'gap', 'grid', 'grid-area', 'grid-auto-columns',
  'grid-auto-flow', 'grid-auto-rows', 'grid-column', 'grid-column-end', 'grid-column-start',
  'grid-row', 'grid-row-end', 'grid-row-start', 'grid-template', 'grid-template-areas',
  'grid-template-columns', 'grid-template-rows', 'height', 'hyphens', 'image-rendering',
  'inline-size', 'inset', 'inset-block', 'inset-inline', 'isolation', 'justify-content',
  'justify-items', 'justify-self', 'left', 'letter-spacing', 'line-break', 'line-height',
  'list-style', 'list-style-image', 'list-style-position', 'list-style-type', 'margin',
  'margin-block', 'margin-bottom', 'margin-inline', 'margin-left', 'margin-right', 'margin-top',
  'mask', 'mask-image', 'mask-mode', 'mask-position', 'mask-repeat', 'mask-size', 'max-block-size',
  'max-height', 'max-inline-size', 'max-width', 'min-block-size', 'min-height', 'min-inline-size',
  'min-width', 'mix-blend-mode', 'object-fit', 'object-position', 'offset', 'opacity', 'order',
  'outline', 'outline-color', 'outline-offset', 'outline-style', 'outline-width', 'overflow',
  'overflow-wrap', 'overflow-x', 'overflow-y', 'overscroll-behavior', 'padding', 'padding-block',
  'padding-bottom', 'padding-inline', 'padding-left', 'padding-right', 'padding-top',
  'page-break-after', 'page-break-before', 'page-break-inside', 'perspective', 'perspective-origin',
  'place-content', 'place-items', 'place-self', 'pointer-events', 'position', 'quotes', 'resize',
  'right', 'rotate', 'row-gap', 'scale', 'scroll-behavior', 'scroll-margin', 'scroll-padding',
  'scrollbar-color', 'scrollbar-width', 'shape-outside', 'tab-size', 'table-layout', 'text-align',
  'text-align-last', 'text-decoration', 'text-decoration-color', 'text-decoration-line',
  'text-decoration-style', 'text-decoration-thickness', 'text-emphasis', 'text-indent',
  'text-justify', 'text-orientation', 'text-overflow', 'text-rendering', 'text-shadow',
  'text-transform', 'text-underline-offset', 'text-wrap', 'top', 'touch-action', 'transform',
  'transform-box', 'transform-origin', 'transform-style', 'transition', 'transition-delay',
  'transition-duration', 'transition-property', 'transition-timing-function', 'translate',
  'unicode-bidi', 'user-select', 'vertical-align', 'visibility', 'white-space', 'width',
  'will-change', 'word-break', 'word-spacing', 'writing-mode', 'z-index', 'zoom',
  // The vendor-prefixed handful that still has no unprefixed equivalent
  // everywhere. Reached as webkitTextFillColor, webkitBackdropFilter, …
  '-webkit-text-fill-color', '-webkit-text-stroke', '-webkit-text-stroke-color',
  '-webkit-text-stroke-width', '-webkit-background-clip', '-webkit-backdrop-filter',
]);

// Properties that keep their full meaning anywhere on the page: every colour,
// border and font property CSS_PROPERTIES defines. A performer's css() may
// fully dictate how the room's native UI looks and reads — paint, border,
// typeface — wherever their selector reaches, not only inside a Trussal root.
// Everything else (layout, position, size, visibility…) stays Trussal-surface-
// only, per the reach decision; the guardrails below apply identically either
// way, so widening this set only widens WHERE a rule may land, never what
// values it may carry.
const EXPLICIT_COLOR_PROPS = new Set([
  'accent-color', 'caret-color', 'color', 'color-scheme', 'scrollbar-color',
  'box-shadow', 'text-shadow',
  'filter', 'backdrop-filter', '-webkit-backdrop-filter', '-webkit-background-clip',
  '-webkit-text-fill-color',
]);
const EXPLICIT_FONT_PROPS = new Set([
  'letter-spacing', 'line-height', 'word-spacing', 'text-transform', 'text-emphasis',
  'text-decoration', 'text-decoration-color', 'text-decoration-line',
  'text-decoration-style', 'text-decoration-thickness', 'text-underline-offset', 'text-wrap',
  '-webkit-text-stroke', '-webkit-text-stroke-color', '-webkit-text-stroke-width',
]);
const isColorProp = (p) => p.startsWith('background') || EXPLICIT_COLOR_PROPS.has(p);
const isBorderProp = (p) => p === 'border' || p.startsWith('border-')
  || p.startsWith('outline') || p.startsWith('column-rule');
const isFontProp = (p) => p === 'font' || p.startsWith('font-') || EXPLICIT_FONT_PROPS.has(p);

const OUTSIDE_TRUSSAL_ALLOW = new Set(
  [...CSS_PROPERTIES].filter((p) => isColorProp(p) || isBorderProp(p) || isFontProp(p)),
);

// The Trussal-owned roots. A rule gets the full property set only where it
// matches inside one of these; the scoping wrapper is built from this list.
export const TRUSSAL_ROOTS = [
  '#trussal-studio-overlay',
  '#trussal-studio-toggle',
  '#trussal-text-cycles',
  '#trussal-hv-panel',
  '#trussal-hv-toggle',
  '#trussal-hv-backdrop',
  '#trussal-kbd-panel',
  '#trussal-kbd-btn',
  '#trussal-fg-panel',
  '#trussal-fg-cursor',
  '#trussal-welcome-overlay',
  '#jamulus-welcome-panel',
  '#jamulus-info-banner',
];

// Every addressable property, hyphenated. The glue registers one `_cc_*`
// control per entry, so this table and the rewrite can never drift apart.
export const CSS_PROPERTY_LIST = [...CSS_PROPERTIES];

// Hyphenated CSS property → the camelCase name the performer chains.
export function methodForCssProp(prop) {
  return String(prop).replace(/^-/, '').replace(/-([a-z])/g, (m, c) => c.toUpperCase());
}

// camelCase chain name → hyphenated CSS property, or null if the name is not
// a CSS property (so `.fast(3)` and friends fall through untouched).
export function cssPropForMethod(name) {
  const raw = String(name ?? '');
  if (!raw) return null;
  let hyphenated = raw.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
  // webkitFilter → -webkit-filter: a vendor prefix owns a leading dash.
  if (/^(webkit|moz|ms|o)-/.test(hyphenated)) hyphenated = `-${hyphenated}`;
  return CSS_PROPERTIES.has(hyphenated) ? hyphenated : null;
}

export function isOutsideTrussalAllowed(prop) {
  return OUTSIDE_TRUSSAL_ALLOW.has(String(prop ?? '').toLowerCase());
}

// --- Guardrail constants -----------------------------------------------------

// WCAG's floor for large text and UI components. Exact-equality would be
// defeated by #fffffe, so text is held to a ratio instead.
export const CONTRAST_FLOOR = 3.0;
// A blur past this is indistinguishable from hiding the element.
export const MAX_BLUR_PX = 8;
// Opacity floor used when a runtime value has to be clamped rather than refused.
export const MIN_OPACITY = 0.04;

// Size properties that may not be zero. margin, padding and every *radius are
// exempt by specification; border and outline widths are exempt too, since a
// zero border hides nothing.
const ZERO_FORBIDDEN_SIZE = new Set([
  'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
  'inline-size', 'block-size', 'min-inline-size', 'min-block-size',
  'max-inline-size', 'max-block-size', 'flex-basis', 'font-size', 'line-height',
  'column-width', 'zoom', 'scale',
]);

// Properties whose value can push an element out of view.
const POSITION_PROPS = new Set([
  'top', 'left', 'right', 'bottom', 'inset', 'inset-block', 'inset-inline',
  'margin', 'margin-top', 'margin-bottom', 'margin-left', 'margin-right',
  'margin-block', 'margin-inline', 'text-indent', 'transform', 'translate',
  'offset', 'perspective-origin', 'transform-origin', 'object-position',
]);

// Legacy properties that load and run code from a stylesheet.
const PROP_BLOCK = new Set(['behavior', '-moz-binding']);
// A property name has to be a plain identifier before it reaches a sheet.
const PROP_OK = /^-{0,2}[a-zA-Z][a-zA-Z0-9-]*$/;
// Values that can execute or break out of the rule they sit in.
const VALUE_BLOCK = /expression\s*\(|javascript\s*:|@import|<\/|[{}<>;]/i;
// url() is permitted only where a background or border image is the point.
const URL_OK_PROPS = new Set([
  'background', 'background-image', 'border-image', 'border-image-source',
  'list-style', 'list-style-image', 'content', 'cursor',
]);

// --- The ^…^ literal fence ---------------------------------------------------
//
// A multi-parameter CSS value collides with mini notation: `2em 1em` is a
// two-step sequence, not `border-radius: 2em 1em`. Carets fence one literal
// value, so spaces, commas and slashes inside them are CSS rather than mini
// operators — which is also the only way to write the slash form,
// `^2em / 1em 3em 0.5em^`.

const STRUCTURAL = new Set(['<', '>', '[', ']', '{', '}', ',', '|', '~']);
const NUM_ARG_OPS = new Set(['*', '/', '!', '@', '%', '?']);

// Walk one patterned CSS value, minting literals and passing operators through.
// `mint(text)` records the value and returns its grammar-legal placeholder.
export function encodeCssValue(src, mint) {
  let out = '';
  let atom = '';
  const flush = () => {
    if (atom === '') return;
    out += mint(atom);
    atom = '';
  };
  for (let i = 0; i < String(src).length; i++) {
    const c = src[i];
    if (c === '^') {
      // Fenced literal: everything to the closing caret is one CSS value.
      flush();
      let j = i + 1;
      let body = '';
      while (j < src.length && src[j] !== '^') body += src[j++];
      out += mint(body.trim());
      i = j;
      continue;
    }
    if (c === '\\') {
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
    atom += c;
    if (c === '(') {
      // A function call — copy through to its matching paren so
      // `rgb(255, 0, 0)` survives without carets.
      let depth = 1;
      let j = i + 1;
      for (; j < src.length && depth > 0; j++) {
        if (src[j] === '(') depth++;
        else if (src[j] === ')') depth--;
        atom += src[j];
      }
      i = j - 1;
    }
  }
  flush();
  return out;
}

// Every literal a patterned value can produce. Refusing a statement means
// checking all of them, since any one can surface on some cycle.
export function collectValues(src) {
  const values = [];
  encodeCssValue(src, (text) => { values.push(text); return 'x'; });
  return values;
}

// --- Colour ------------------------------------------------------------------

const NAMED_COLORS = {
  black: [0, 0, 0], white: [255, 255, 255], red: [255, 0, 0], green: [0, 128, 0],
  blue: [0, 0, 255], yellow: [255, 255, 0], cyan: [0, 255, 255], magenta: [255, 0, 255],
  gray: [128, 128, 128], grey: [128, 128, 128], silver: [192, 192, 192],
  maroon: [128, 0, 0], olive: [128, 128, 0], lime: [0, 255, 0], aqua: [0, 255, 255],
  teal: [0, 128, 128], navy: [0, 0, 128], fuchsia: [255, 0, 255], purple: [128, 0, 128],
  orange: [255, 165, 0], pink: [255, 192, 203], brown: [165, 42, 42],
};

// "#rgb" / "#rrggbb" / "#rrggbbaa" / "rgb()" / "rgba()" / "hsl()" / a name
// → { r, g, b, a } with channels 0-255 and alpha 0-1, or null if unreadable.
export function parseColor(input) {
  const raw = String(input ?? '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'transparent') return { r: 0, g: 0, b: 0, a: 0 };
  if (NAMED_COLORS[raw]) {
    const [r, g, b] = NAMED_COLORS[raw];
    return { r, g, b, a: 1 };
  }
  const hex = raw.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    const h = hex[1];
    const wide = h.length <= 4 ? h.split('').map((c) => c + c).join('') : h;
    if (wide.length !== 6 && wide.length !== 8) return null;
    return {
      r: parseInt(wide.slice(0, 2), 16),
      g: parseInt(wide.slice(2, 4), 16),
      b: parseInt(wide.slice(4, 6), 16),
      a: wide.length === 8 ? parseInt(wide.slice(6, 8), 16) / 255 : 1,
    };
  }
  const fn = raw.match(/^(rgba?|hsla?)\s*\(([^)]*)\)$/);
  if (!fn) return null;
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
  if (parts.length < 3) return null;
  const num = (s) => {
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : 0;
  };
  const alpha = parts.length > 3 ? (parts[3].endsWith('%') ? num(parts[3]) / 100 : num(parts[3])) : 1;
  if (fn[1].startsWith('rgb')) {
    const chan = (s) => (s.endsWith('%') ? (num(s) / 100) * 255 : num(s));
    return { r: chan(parts[0]), g: chan(parts[1]), b: chan(parts[2]), a: alpha };
  }
  return { ...hslToRgb(num(parts[0]), num(parts[1]) / 100, num(parts[2]) / 100), a: alpha };
}

function hslToRgb(h, s, l) {
  const hue = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1));
  const m = l - c / 2;
  const seg = Math.floor(hue / 60) % 6;
  const [r1, g1, b1] = [
    [c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x],
  ][seg];
  return {
    r: Math.round((r1 + m) * 255),
    g: Math.round((g1 + m) * 255),
    b: Math.round((b1 + m) * 255),
  };
}

function toHex({ r, g, b }) {
  const p = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0');
  return `#${p(r)}${p(g)}${p(b)}`;
}

function relativeLuminance({ r, g, b }) {
  const chan = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * chan(r) + 0.7152 * chan(g) + 0.0722 * chan(b);
}

export function contrastRatio(a, b) {
  const ca = typeof a === 'string' ? parseColor(a) : a;
  const cb = typeof b === 'string' ? parseColor(b) : b;
  if (!ca || !cb) return Infinity; // unreadable → not our business to police
  const la = relativeLuminance(ca);
  const lb = relativeLuminance(cb);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// Text that has collided with its container is walked away from the background
// in lightness until it clears the floor, rather than being refused: the
// collision is a two-party accident (one peer's colour, another's background)
// and neither statement is illegal alone.
export function adjustColorForBackground(color, background, floor = CONTRAST_FLOOR) {
  const fg = parseColor(color);
  const bg = parseColor(background);
  if (!fg || !bg) return color;
  if (fg.a === 0) return color; // alpha-0 text is refused elsewhere, not nudged
  if (contrastRatio(fg, bg) >= floor) return color;

  // Move away from the background: toward white on a dark one, toward black on
  // a light one, so the adjusted colour still reads as a nudge of the original.
  const towardWhite = relativeLuminance(bg) < 0.5;
  const target = towardWhite ? 255 : 0;
  for (let step = 1; step <= 20; step++) {
    const t = step / 20;
    const candidate = {
      r: fg.r + (target - fg.r) * t,
      g: fg.g + (target - fg.g) * t,
      b: fg.b + (target - fg.b) * t,
    };
    if (contrastRatio(candidate, bg) >= floor) {
      return fg.a < 1
        ? `rgba(${Math.round(candidate.r)}, ${Math.round(candidate.g)}, ${Math.round(candidate.b)}, ${fg.a})`
        : toHex(candidate);
    }
  }
  return towardWhite ? '#ffffff' : '#000000';
}

// --- Guardrails --------------------------------------------------------------

// A length whose magnitude takes an element out of view. Percentages and
// viewport units are read against the viewport; px against a generous bound.
function isOffscreenLength(token) {
  const m = String(token).match(/^([+-]?[\d.]+)(px|em|rem|%|vw|vh|vmin|vmax|pt|cm|in)?$/);
  if (!m) return false;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return false;
  const unit = m[2] || 'px';
  const mag = Math.abs(n);
  if (unit === '%' || unit === 'vw' || unit === 'vh' || unit === 'vmin' || unit === 'vmax') {
    return mag >= 100;
  }
  if (unit === 'em' || unit === 'rem') return mag >= 60;
  if (unit === 'pt') return mag >= 1500;
  if (unit === 'cm' || unit === 'in') return mag >= 50;
  return mag >= 2000 || n <= -1000;
}

function isZero(token) {
  const m = String(token).match(/^([+-]?[\d.]+)([a-z%]*)$/i);
  if (!m) return false;
  return parseFloat(m[1]) === 0;
}

// Every function call in a value, as [name, argsString].
function functionCalls(value) {
  const out = [];
  const re = /([a-zA-Z-]+)\s*\(/g;
  let m;
  while ((m = re.exec(value))) {
    let depth = 1;
    let i = re.lastIndex;
    let args = '';
    for (; i < value.length && depth > 0; i++) {
      if (value[i] === '(') depth++;
      else if (value[i] === ')') { depth--; if (!depth) break; }
      args += value[i];
    }
    out.push([m[1].toLowerCase(), args]);
  }
  return out;
}

// Filters hide as thoroughly as display:none, so the same rules reach inside
// them: no alpha or luminance driven to zero, and blur capped at legible.
function checkFilter(value) {
  for (const [fn, args] of functionCalls(value)) {
    const n = parseFloat(args);
    if (fn === 'opacity' && Number.isFinite(n) && (args.includes('%') ? n === 0 : n === 0)) {
      return 'filter: opacity(0) hides the element';
    }
    if ((fn === 'brightness' || fn === 'contrast') && Number.isFinite(n) && n === 0) {
      return `filter: ${fn}(0) hides the element`;
    }
    if (fn === 'blur') {
      const px = /(\d[\d.]*)\s*px/.exec(args);
      if (px && parseFloat(px[1]) > MAX_BLUR_PX) {
        return `filter: blur() above ${MAX_BLUR_PX}px is illegible`;
      }
    }
  }
  return null;
}

// One declaration against every guardrail. Returns null when legal, otherwise
// a human-readable reason the statement is refused.
//
// The text-vs-container rule is deliberately absent: it depends on the live
// computed background, can be created by a second peer after this statement
// was accepted, and is handled by auto-adjustment at apply time instead.
export function checkDeclaration(prop, value, { inTrussal = true } = {}) {
  const p = String(prop ?? '').trim().toLowerCase();
  const v = String(value ?? '').trim();
  if (!p || !v) return null;
  if (!PROP_OK.test(p)) return `"${prop}" is not a CSS property name`;
  if (PROP_BLOCK.has(p)) return `${p} can execute code from a stylesheet`;
  if (/javascript\s*:|expression\s*\(|@import/i.test(v)) return `${p}: value can execute or fetch code`;

  // url() reaches the network from every participant's browser, so it is
  // confined to the properties where an image is the point and to schemes that
  // cannot execute. Its contents are checked here and then masked out of the
  // break-out scan below: a data:image URI legitimately carries the very
  // semicolon that scan exists to catch.
  let scannable = v;
  if (/url\s*\(/i.test(v)) {
    if (!URL_OK_PROPS.has(p)) return `url() is not permitted on ${p}`;
    for (const [fn, args] of functionCalls(v)) {
      if (fn !== 'url') continue;
      const href = args.trim().replace(/^["']|["']$/g, '');
      if (!/^(https?:\/\/|data:image\/|\/)/i.test(href)) {
        return 'url() must be http(s), a data:image, or same-origin';
      }
      // Nothing that could close the url() and reopen as something else.
      if (/[{}<>"'`\s\\]/.test(href)) return 'url() contains characters that could break out of it';
    }
    scannable = v.replace(/url\s*\([^)]*\)/gi, 'url(_)');
  }
  if (VALUE_BLOCK.test(scannable)) {
    return `${p}: value contains characters that could break out of the rule`;
  }

  const lower = v.toLowerCase();

  if (!inTrussal && !isOutsideTrussalAllowed(p)) {
    return `${p} only applies inside Trussal surfaces`;
  }

  // z-index is banned outright — no layering, anywhere, by any selector.
  if (p === 'z-index') return 'z-index may not be changed';
  if (p === 'display' && lower === 'none') return 'display: none would hide the UI';
  if ((p === 'overflow' || p === 'overflow-x' || p === 'overflow-y') && /hidden|clip/.test(lower)) {
    return `${p}: ${v} would hide content`;
  }
  if (p === 'visibility' && /hidden|collapse/.test(lower)) return `visibility: ${v} would hide the UI`;
  if (p === 'content-visibility' && lower === 'hidden') return 'content-visibility: hidden would hide the UI';
  // Not in the specified list, but an unclickable UI is as non-functional as an
  // invisible one; drop this line if pointer-events should be reachable.
  if (p === 'pointer-events' && lower === 'none') return 'pointer-events: none would break interaction';

  if (p === 'opacity') {
    const n = parseFloat(v);
    if (Number.isFinite(n) && n <= 0) return 'opacity: 0 would hide the UI';
  }
  // Alpha-0 text is invisible text. A transparent background is ordinary.
  if (p === 'color' || p === '-webkit-text-fill-color') {
    const c = parseColor(v);
    if (c && c.a === 0) return `${p}: an alpha of 0 would hide the text`;
  }

  if (ZERO_FORBIDDEN_SIZE.has(p) && v.split(/[\s,]+/).some(isZero)) {
    return `${p}: 0 would collapse the element`;
  }

  if (p === 'filter' || p === 'backdrop-filter') {
    const reason = checkFilter(v);
    if (reason) return reason;
  }

  if (p === 'clip-path') {
    for (const [fn, args] of functionCalls(v)) {
      if (fn === 'inset' && args.split(/\s+/).some((t) => /^(100|1[0-9][0-9])%$/.test(t))) {
        return 'clip-path: inset(100%) would hide the element';
      }
      if ((fn === 'circle' || fn === 'ellipse') && /(^|\s)0(px|%|em|rem)?(\s|$)/.test(args)) {
        return `clip-path: ${fn}(0) would hide the element`;
      }
    }
  }

  if (POSITION_PROPS.has(p)) {
    if (p === 'transform' || p === 'translate' || p === 'scale') {
      for (const [fn, args] of functionCalls(v)) {
        if (/^(translate|translatex|translatey|translate3d)$/.test(fn)) {
          if (args.split(/[\s,]+/).some(isOffscreenLength)) {
            return `${p}: ${fn}() would move the element off-screen`;
          }
        }
        if (/^(scale|scalex|scaley|scale3d)$/.test(fn)) {
          if (args.split(/[\s,]+/).filter(Boolean).some(isZero)) {
            return `${p}: ${fn}(0) would collapse the element`;
          }
        }
      }
      if (p === 'translate' && v.split(/[\s,]+/).some(isOffscreenLength)) {
        return 'translate: would move the element off-screen';
      }
    } else if (v.split(/[\s,]+/).some(isOffscreenLength)) {
      return `${p}: ${v} would move the element off-screen`;
    }
  }

  return null;
}

// A runtime value cannot refuse its statement — the statement was already
// accepted, and the value only exists now. Clamp to the nearest legal thing so
// the gesture keeps its shape instead of disappearing.
export function clampValue(prop, value, { inTrussal = true } = {}) {
  const p = String(prop ?? '').trim().toLowerCase();
  const v = String(value ?? '').trim();
  if (!checkDeclaration(p, v, { inTrussal })) return v;

  if (p === 'opacity') {
    const n = parseFloat(v);
    if (Number.isFinite(n) && n <= 0) return String(MIN_OPACITY);
  }
  if (ZERO_FORBIDDEN_SIZE.has(p) && isZero(v)) return '1px';
  if (p === 'display' && v.toLowerCase() === 'none') return 'block';
  if (p === 'visibility') return 'visible';
  if (p === 'overflow' || p === 'overflow-x' || p === 'overflow-y') return 'auto';
  if (p === 'pointer-events') return 'auto';
  if (p === 'color') {
    const c = parseColor(v);
    if (c && c.a === 0) return toHex(c);
  }
  if (p === 'filter' || p === 'backdrop-filter') {
    return v
      .replace(/\bopacity\s*\(\s*0\s*%?\s*\)/gi, `opacity(${MIN_OPACITY})`)
      .replace(/\b(brightness|contrast)\s*\(\s*0\s*%?\s*\)/gi, '$1(0.1)')
      .replace(/\bblur\s*\(\s*([\d.]+)px\s*\)/gi, (m, px) =>
        (parseFloat(px) > MAX_BLUR_PX ? `blur(${MAX_BLUR_PX}px)` : m));
  }
  // Nothing sensible to clamp to (an off-screen position, a banned z-index):
  // dropping the declaration leaves the previous value standing.
  return null;
}

// --- SCSS scanning -----------------------------------------------------------
//
// Enough of a parser to find every declaration, block and @keyframes in the
// performer's source. Not a compiler — that runs on the sidecar — but the
// guardrails have to see declarations written directly in the SCSS, not only
// the ones arriving through the chain.

// Split source into top-level constructs, tracking brace depth and skipping
// strings and comments so a `{` inside content: "…" cannot unbalance the scan.
function scanBlocks(src) {
  const text = String(src ?? '');
  const blocks = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  let quote = null;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; i++; continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '{') {
      depth++;
      i++;
      continue;
    }
    if (c === '}') {
      depth--;
      i++;
      if (depth === 0) {
        blocks.push({ text: text.slice(start, i), start, end: i });
        start = i;
      }
      continue;
    }
    i++;
  }
  const tail = text.slice(start).trim();
  if (tail) blocks.push({ text: text.slice(start), start, end: text.length, bare: true });
  return blocks;
}

// Every `prop: value` in the source, with the offsets needed to splice one out.
export function parseScssDeclarations(src) {
  const text = String(src ?? '');
  const out = [];
  let i = 0;
  let quote = null;
  let propStart = -1;
  let colon = -1;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; i++; continue; }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      propStart = -1; colon = -1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      propStart = -1; colon = -1;
      continue;
    }
    if (c === '{') {
      // A colon before `{` was a selector (`&:hover {`), not a declaration.
      propStart = -1; colon = -1;
      i++;
      continue;
    }
    if (c === '}') {
      // The last declaration in a block may drop its semicolon, so the closing
      // brace has to emit as well — otherwise `.x { display: none }` would
      // reach the sheet without ever being checked.
      if (colon !== -1 && propStart !== -1) {
        const value = text.slice(colon + 1, i).trim();
        if (value) {
          out.push({
            prop: text.slice(propStart, colon).trim(),
            value,
            start: propStart,
            end: i,
          });
        }
      }
      propStart = -1; colon = -1;
      i++;
      continue;
    }
    if (c === ':' && colon === -1 && propStart !== -1) { colon = i; i++; continue; }
    if (c === ';') {
      if (colon !== -1 && propStart !== -1) {
        out.push({
          prop: text.slice(propStart, colon).trim(),
          value: text.slice(colon + 1, i).trim(),
          start: propStart,
          end: i + 1,
        });
      }
      propStart = -1; colon = -1;
      i++;
      continue;
    }
    if (!/\s/.test(c) && propStart === -1) propStart = i;
    i++;
  }
  // A final declaration may drop its semicolon before the closing brace.
  if (colon !== -1 && propStart !== -1) {
    const rest = text.slice(colon + 1).trim();
    if (rest) {
      out.push({
        prop: text.slice(propStart, colon).trim(),
        value: rest,
        start: propStart,
        end: text.length,
      });
    }
  }
  return out.filter((d) => d.prop && !d.prop.startsWith('$') && !d.prop.startsWith('@'));
}

// Top-level @keyframes blocks, which cannot be nested inside a selector and so
// have to be lifted out of the scoping wrapper.
export function extractKeyframes(src) {
  const text = String(src ?? '');
  const frames = [];
  let rest = '';
  for (const block of scanBlocks(text)) {
    const m = block.text.match(/@(-\w+-)?keyframes\s+([\w-]+)/);
    if (m) frames.push({ name: m[2], text: block.text });
    else rest += block.text;
  }
  return { frames, rest };
}

// --- Statement rewriting -----------------------------------------------------

export function hasCssCycles(code) {
  return /^\s*await\s+initCss\s*\(/m.test(String(code ?? ''));
}

// `css(` in any position, including chained.
export const CSS_CALL_RE = /(?:^|[^\w$])css\s*\(/;

export function splitCssStatements(code) {
  return splitStatements(code).map((s) => ({ ...s, hasCss: CSS_CALL_RE.test(s.text) }));
}

// A bare `await initTextCycles()`/`await initCss()` declaration, with nothing
// else on its statement — splitStatements always gives one of these its own
// chunk when it precedes a labeled voice with no blank line before it (the
// shape every capability's own docs use), so keeping only hasWord/hasCss
// chunks below would drop the declaration and leave the voice it activates
// never turned on.
const BARE_INIT_RE = /^\s*await\s+init(?:TextCycles|Css)\s*\(\s*\)\s*;?\s*$/;

// Keep only the statements that make no sound — words and styling, plus the
// capability declarations that turn them on. Both are per-page and neither
// rides the published track, so an excluded remote peer's text and CSS must
// survive the exclusion that drops their audio; otherwise you would only
// ever see your own.
//
// Paragraph-aware (blank-line-separated, the same unit hydra-code.js and
// strudel-voice.js split on), not just label-aware: splitStatements has no
// notion of a blank line, so a trailing plain audio pattern with no label of
// its own gets grouped into whichever labeled text/css statement precedes it
// and would otherwise be kept — and forwarded as a SECOND voice for that
// peer's audio, playing it twice.
export function keepSilentStatements(code) {
  const src = String(code ?? '');
  const kept = src.split(/\n\n+/).map((paragraph) => {
    if (!paragraph.trim()) return null;
    const survivors = splitCssStatements(paragraph)
      .filter((s) => s.hasWord || s.hasCss || BARE_INIT_RE.test(s.text.trim()))
      .map((s) => s.text);
    return survivors.length ? survivors.join('\n') : null;
  }).filter((p) => p !== null);
  return kept.join('\n\n').trim();
}

// The custom property carrying one patterned declaration. Derived from the
// statement's own token so the sheet the sidecar compiled and the hap trigger
// running in every browser agree on the name without coordinating.
export function cssVarName(token, prop) {
  return `--cc-${token}-${prop}`;
}

// Find the backticked argument of a css( call starting at `open` (the index of
// its "("). Returns null if the argument is not a template literal.
function readTemplateArg(text, open) {
  let i = open + 1;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] !== '`') return null;
  const start = i;
  i++;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '`') return { start, end: i + 1, body: text.slice(start + 1, i) };
    i++;
  }
  return null;
}

// Read a chain of `.name(arg)` calls following `from`, stopping at the end of
// the statement. Returns the calls and where the chain ended.
function readChain(text, from) {
  const calls = [];
  let i = from;
  for (;;) {
    let j = i;
    while (j < text.length && /[\s\n]/.test(text[j])) j++;
    if (text[j] !== '.') break;
    const m = /^\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(text.slice(j));
    if (!m) break;
    const open = j + m[0].length - 1;
    let depth = 1;
    let k = open + 1;
    let quote = null;
    for (; k < text.length && depth > 0; k++) {
      const c = text[k];
      if (quote) {
        if (c === '\\') k++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') { quote = c; continue; }
      if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    calls.push({ name: m[1], argStart: open + 1, argEnd: k - 1, start: j, end: k });
    i = k;
  }
  return { calls, end: i };
}

// Rewrite every css() statement, minting SCSS and literal values into
// grammar-legal tokens and turning chained CSS property calls into `_cc_*`
// controls. Returns the rewritten source, the atom table, and one record per
// statement describing the sheet the sidecar has to compile.
export function rewriteCssCalls(code, { peer = null, counter = { n: 0 } } = {}) {
  const atoms = {};
  const sheets = [];
  const errors = [];
  const mint = (text, kind = 'value') => {
    const token = `cc${counter.n++}`;
    atoms[token] = { text, peer, kind };
    return token;
  };

  const rewriteStatement = ({ text, hasCss }) => {
    if (!hasCss) return text;

    const call = CSS_CALL_RE.exec(text);
    const open = text.indexOf('(', call.index);
    const arg = readTemplateArg(text, open);
    if (!arg) {
      errors.push('css() takes SCSS in backticks, e.g. css(`.example { color: red }`)');
      return text;
    }

    const scssToken = mint(arg.body, 'scss');
    const { calls, end: chainEnd } = readChain(text, arg.end + 1);

    // Split the chain: CSS properties become patterned declarations, anything
    // else is Strudel structure and is left exactly where the performer put it.
    const props = [];
    let out = `${text.slice(0, call.index + call[0].length - 1)}("${scssToken}")`;
    for (const c of calls) {
      const prop = cssPropForMethod(c.name);
      const argText = text.slice(c.argStart, c.argEnd);
      if (!prop) {
        out += text.slice(c.start, c.end);
        continue;
      }
      // A double-quoted argument is a patterned value; anything else (a
      // slider, a variable, a call) is passed through and guarded at runtime.
      const literal = /^\s*"(?:[^"\\]|\\.)*"\s*$/.test(argText);
      if (literal) {
        const body = argText.trim().slice(1, -1);
        const encoded = encodeCssValue(body, (v) => mint(v));
        out += `._cc_${c.name}("${encoded}")`;
        props.push({ prop, method: c.name, values: collectValues(body), literal: true });
      } else {
        out += `._cc_${c.name}(${argText})`;
        props.push({ prop, method: c.name, values: [], literal: false });
      }
    }
    out += text.slice(chainEnd);

    sheets.push({ token: scssToken, scss: arg.body, props, peer });
    // The renderer carries the dominant trigger that keeps a css voice silent,
    // and is attached per statement so an audio voice sharing the program is
    // never muted by it.
    return `${out.replace(/[\s;]+$/, '')}\n._ccRender()`;
  };

  // Paragraph-aware (blank-line-separated), not just label-aware: splitCssStatements
  // has no notion of a blank line, so a bare capability declaration sitting in
  // its own paragraph right after a css() voice — `await initCss()\n\n$: css(...)`
  // followed later by `await initTextCycles()` — gets swept into the SAME
  // statement as the css() chain (nothing but a `$:` line starts a new one).
  // `out += text.slice(chainEnd)` then appends that declaration directly onto
  // the chain, and `._ccRender()` lands on it too: `await initTextCycles()
  // ._ccRender()` throws (a boolean has no such method), which took the
  // WHOLE program's evaluate() down — Hydra frozen, no audio, no text, no CSS,
  // for everyone. Splitting into paragraphs first keeps that declaration in
  // its own statement, exactly as it reads on the page.
  const rewritten = String(code ?? '').split(/\n\n+/)
    .map((paragraph) => splitCssStatements(paragraph).map(rewriteStatement).join('\n'))
    .join('\n\n');

  return { code: rewritten, atoms, sheets, errors };
}

// --- Sheet assembly ----------------------------------------------------------

// Validate one statement's SCSS and chained properties. Returns every reason
// the statement is refused; an empty array means it may be compiled.
export function checkSheet(sheet) {
  const errors = [];
  const { frames, rest } = extractKeyframes(sheet.scss);

  for (const src of [rest, ...frames.map((f) => f.text)]) {
    for (const decl of parseScssDeclarations(src)) {
      // A declaration written into the SCSS is checked against BOTH reaches:
      // the same rule is emitted inside Trussal and out, and the outside copy
      // simply drops what it may not carry rather than refusing the statement.
      const reason = checkDeclaration(decl.prop, decl.value, { inTrussal: true });
      if (reason) errors.push(reason);
    }
  }

  for (const p of sheet.props) {
    for (const v of p.values) {
      const reason = checkDeclaration(p.prop, v, { inTrussal: true });
      if (reason) errors.push(`${p.method}(): ${reason}`);
    }
  }
  return errors;
}

// Rebuild SCSS carrying only the declarations that reach outside Trussal.
function filterToAllowlist(src) {
  const decls = parseScssDeclarations(src);
  let out = String(src ?? '');
  for (const d of [...decls].reverse()) {
    if (isOutsideTrussalAllowed(d.prop.toLowerCase())) continue;
    out = out.slice(0, d.start) + out.slice(d.end);
  }
  return out;
}

// Inject the patterned declarations into a block's first top-level selector.
// Each becomes a var() reference the hap trigger reassigns, so a value change
// never needs another compile.
//
// !important: unlike the hand-written SCSS around it, a patterned declaration
// is the entire point of chaining `.color()`/`.backgroundColor()`/… onto a
// css() call — a performer set it precisely so it tracks the pattern. Losing
// it to an app default of equal-or-lower specificity (most of Trussal's own
// UI gives its text/background/font a direct, non-inherited rule per element,
// which a same-specificity or ancestor-targeting Cycles rule cannot out-cascade
// by source order or specificity alone) is indistinguishable from the pipeline
// being broken, so it may never lose. Hand-authored declarations in the
// backticked SCSS itself keep the normal cascade — the fix for those staying
// unreachable is still to drop `!important` from the app's own rule.
function withPatternedProps(scss, sheet, { allowlistOnly = false } = {}) {
  const decls = sheet.props
    .filter((p) => !allowlistOnly || isOutsideTrussalAllowed(p.prop))
    .map((p) => `  ${p.prop}: var(${cssVarName(sheet.token, p.prop)}) !important;`)
    .join('\n');
  if (!decls) return scss;

  const src = String(scss).trim();
  const brace = src.indexOf('{');
  if (brace === -1) {
    // A bare selector — wrap it.
    return `${src} {\n${decls}\n}`;
  }
  return `${src.slice(0, brace + 1)}\n${decls}\n${src.slice(brace + 1)}`;
}

// --- Receiving side ----------------------------------------------------------
//
// A peer's compiled sheet arrives over the bus and goes into this browser's
// head, so it is checked AGAIN here. The outbound checks are the performer's
// error messages; these are the room's actual defence. The sidecar compiles
// whatever it is sent and cannot tell an honest client from a patched one, so
// a sheet that never passed a browser guardrail on the way out still has to
// fail on the way in.

// Does this selector genuinely stay inside a Trussal root? Starting with the
// root is not enough — `#trussal-studio-overlay ~ *` starts there and selects
// everything beside it — so sibling combinators disqualify the selector.
function isTrussalScoped(selectorPart) {
  const sel = String(selectorPart).trim();
  const root = TRUSSAL_ROOTS.find((r) => sel === r || sel.startsWith(`${r} `) || sel.startsWith(`${r}>`)
    || sel.startsWith(`${r}:`) || sel.startsWith(`${r}.`) || sel.startsWith(`${r}[`));
  if (!root) return false;
  return !/[~+]/.test(sel.slice(root.length));
}

// Walk compiled CSS into flat rules. At-rules that hold rules (@media,
// @supports, @layer, @container) recurse; @keyframes carries declarations that
// still have to pass the off-screen and opacity rules.
function walkCssRules(css, out = [], inherited = null) {
  const text = String(css ?? '');
  let i = 0;
  let prelude = '';
  let quote = null;
  while (i < text.length) {
    const c = text[i];
    if (quote) {
      prelude += c;
      if (c === '\\') { prelude += text[++i] ?? ''; }
      else if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; prelude += c; i++; continue; }
    if (c === '}') { i++; prelude = ''; continue; }
    if (c !== '{') { prelude += c; i++; continue; }

    // Found a block — take its body by brace matching.
    let depth = 1;
    let j = i + 1;
    let q = null;
    for (; j < text.length && depth > 0; j++) {
      const d = text[j];
      if (q) {
        if (d === '\\') j++;
        else if (d === q) q = null;
        continue;
      }
      if (d === '"' || d === "'") { q = d; continue; }
      if (d === '{') depth++;
      else if (d === '}') depth--;
    }
    const body = text.slice(i + 1, j - 1);
    const head = prelude.trim();

    if (/^@(media|supports|layer|container|scope)\b/i.test(head)) {
      // A media query hides the UI for a screen size range only by carrying
      // rules that do; recursing means those are held to the same guardrails
      // regardless of the viewport this browser happens to have.
      walkCssRules(body, out, inherited);
    } else if (/^@keyframes\b/i.test(head) || /^@-\w+-keyframes\b/i.test(head)) {
      walkCssRules(body, out, { selector: head, keyframes: true });
    } else if (head.startsWith('@')) {
      // @font-face, @page and friends carry no selector we can place.
      out.push({ selector: head, body, atRule: true });
    } else {
      out.push({ selector: inherited?.selector ?? head, body, keyframes: !!inherited?.keyframes });
    }
    prelude = '';
    i = j;
  }
  return out;
}

// Check a compiled sheet before it is installed. Returns the reasons it is
// refused; an empty array means it may go into the document.
export function checkCompiledCss(css) {
  const errors = [];
  for (const rule of walkCssRules(css)) {
    if (rule.atRule) continue;
    // A rule reaches outside Trussal unless EVERY selector in its list stays
    // inside; one escaping alternative is enough to hold the whole rule to the
    // allowlist, since they share one declaration block.
    const parts = String(rule.selector).split(',').filter((p) => p.trim());
    const inTrussal = rule.keyframes || (parts.length > 0 && parts.every(isTrussalScoped));
    for (const decl of parseScssDeclarations(rule.body)) {
      // var() references are the hot path's own plumbing; their values are
      // checked when the trigger assigns them, not here.
      if (/^var\(--cc-/.test(decl.value.trim())) continue;
      const reason = checkDeclaration(decl.prop, decl.value, { inTrussal });
      if (reason) errors.push(`${rule.selector.slice(0, 60)} — ${reason}`);
    }
  }
  return errors;
}

// One peer's whole contribution as SCSS, ready for the sidecar.
//
// Emitted twice: once nested under every Trussal root, where the full property
// set applies and the extra id gives it the specificity to win; once bare,
// carrying the allowlist alone, for the rest of the page. @keyframes are
// lifted out (they cannot nest inside a selector) and namespaced per peer.
// Either copy's patterned declarations (see withPatternedProps) carry
// !important, since specificity and source order alone are not enough: most
// of Trussal's own UI declares colour/background/font directly on the exact
// element rather than an ancestor, which no amount of specificity on a
// same-property, different-selector Cycles rule can out-cascade.
export function buildPeerScss(sheets, { peerClass = 'anon' } = {}) {
  const parts = [];
  for (const sheet of sheets) {
    if (checkSheet(sheet).length) continue;
    const { frames, rest } = extractKeyframes(sheet.scss);

    for (const frame of frames) {
      // Namespaced so two performers animating `spin` do not collide.
      parts.push(frame.text.replace(
        /@(-\w+-)?keyframes\s+([\w-]+)/,
        (m, vendor, name) => `@${vendor || ''}keyframes ${peerClass}-${name}`,
      ));
    }

    const named = (src) => src.replace(
      /(animation(?:-name)?\s*:)([^;}]*)/g,
      (m, head, val) => head + frames.reduce(
        (acc, f) => acc.replace(new RegExp(`\\b${f.name}\\b`, 'g'), `${peerClass}-${f.name}`),
        val,
      ),
    );

    const full = withPatternedProps(named(rest), sheet);
    if (full.trim()) {
      parts.push(`${TRUSSAL_ROOTS.join(',\n')} {\n${full}\n}`);
    }
    const outside = withPatternedProps(filterToAllowlist(named(rest)), sheet, { allowlistOnly: true });
    if (parseScssDeclarations(outside).length) parts.push(outside);
  }
  return parts.join('\n\n');
}

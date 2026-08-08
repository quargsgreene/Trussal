// CSS Cycles — Strudel patterns that play into the page's stylesheet.
//
// `await initCss()` declares a program's styling presence, exactly as
// `await initTextCycles()` declares its words. After it, a voice like
//
//   $: css(`.ts-chip { &:hover { border-color: #fff } }`)
//        .color("<#ffffff #eeeeee #34e3df>/4")
//        .borderRadius("<^2em / 1em 3em^ ^0.2em 1em 4em 1em^>")
//        .fast(3)
//
// `.ts-chip` (the participant strip) is a real selector inside
// #trussal-studio-overlay, so this is literally paste-able — a class that
// exists nowhere in the DOM compiles and runs without error but visibly does
// nothing, since its rule then matches zero elements.
//
// restyles the running UI in time. Silent by construction, the same way Text
// Cycles is: the renderer carries a dominant onTrigger, so a css voice cannot
// reach superdough even if it also names a sound.
//
// --- Two speeds --------------------------------------------------------------
//
// SCSS cannot be compiled per hap, so the work is split:
//
//   cold  editor change → buildPeerScss → sidecar compiles → compiledCss is
//         broadcast on the peer bus → every browser installs that peer's sheet
//   hot   each hap reassigns CSS custom properties on :root, which the compiled
//         rules already reference through var()
//
// Only the authoring browser compiles its own SCSS; everyone else receives the
// result over the bus. That keeps one compile per edit for the whole room, and
// means a peer's styling appears identically everywhere without each client
// re-deriving it.
//
// --- Reach -------------------------------------------------------------------
//
// The full property set applies only where a rule matches inside a Trussal
// root. The same rule is re-emitted bare for the rest of the page carrying
// every colour, border and font property — layout, position, size and
// visibility stay Trussal-surface-only. Both copies pass every guardrail; see
// css-cycles-core.js for the rules themselves.

import { subscribePeerState, getAllPeers, getLocalPeer, getPeerByJitsiId, sendLocalScss, sendPeerScss, isPeerNetCyclesTurn } from './peer-state.js';
import {
  CSS_PROPERTY_LIST,
  adjustColorForBackground,
  buildPeerScss,
  checkCompiledCss,
  checkSheet,
  clampValue,
  cssPropForMethod,
  cssVarName,
  methodForCssProp,
  parseColor,
} from './css-cycles-core.js';
import { peerTextClass } from './text-cycles-core.js';

const STYLE_PREFIX = 'trussal-css-cycles-';

let atoms = {};             // token → { text, peer, kind }
let active = false;         // flipped by initCss()
let sheetsByToken = new Map(); // token → sheet record for the running program
let refused = new Set();    // tokens whose statement failed a guardrail
let styleEls = new Map();   // peerId → <style>
let lastSentScss = '';      // dedupes the sidecar round-trip
let lastSentScssByBot = new Map(); // botJitsiId → last SCSS this browser sent for it
let bgCache = new Map();    // selector → { color, at } — throttles the contrast pass
// "selector||prop" → the room's own computed value, captured from the DOM the
// FIRST time any CSS Cycles hap ever targets that pair — before this module
// has ever called setProperty for it. A benched peer's property is pinned
// here instead of their pattern's value, so mutual exclusion always resolves
// to a known baseline rather than whichever peer happened to write last.
let baselineValues = new Map();

const BG_CACHE_MS = 250;

// Replace the atom table. Called by strudel.js immediately before evaluate(),
// so tokens in the program about to run always resolve against their own text.
export function setCssAtoms(table) {
  atoms = table || {};
}

function resolve(value) {
  if (value == null) return null;
  const key = String(value);
  const atom = atoms[key];
  return atom ? atom.text : key;
}

// --- Sheet installation ------------------------------------------------------

// Register the running program's stylesheets and hand the local peer's SCSS to
// the sidecar. Called by strudel.js after every rebuild with EVERY peer's
// sheets, not just ours: this browser evaluates every peer's program, so it is
// this browser that assigns the custom properties their installed rules read.
// Only the SENDING is local — each peer compiles their own.
export function publishCssSheets(sheets) {
  sheetsByToken = new Map(sheets.map((s) => [s.token, s]));
  refused = new Set();

  const local = getLocalPeer();
  const problems = [];
  for (const sheet of sheets) {
    const errors = checkSheet(sheet);
    if (!errors.length) continue;
    refused.add(sheet.token);
    // Only our own refusals are reported. A remote peer's broken statement is
    // theirs to see in their own editor; every browser shouting about it would
    // just be noise.
    if (sheet.peer === local?.jitsiId) problems.push(...errors);
  }
  if (problems.length) {
    // Refused statements are not a silent condition: the performer needs to
    // know which rule of theirs the room is not running.
    console.error('[css-cycles] statement refused:', problems.join('; '));
    document.dispatchEvent(new CustomEvent('trussal-css-errors', { detail: problems }));
  }

  const mine = sheets.filter((s) => s.peer === local?.jitsiId);
  const scss = buildPeerScss(mine, { peerClass: peerTextClass(local?.jitsiId) });
  // A rebuild that changed only an audio voice must not cost a compile.
  if (scss !== lastSentScss) {
    lastSentScss = scss;
    sendLocalScss(scss);
  }

  // A bot's own connection never runs this pipeline (its REPL is a bare
  // @strudel/repl with none of Trussal's controls — see
  // bots/src/bot/page-scripts.js), so no browser is ever "local" to a bot's
  // peer id. Every human viewer's own program builds the same parroted sheets
  // for that bot (buildBotSilentBlock in strudel.js), so this browser
  // compiles and sends on the bot's behalf too — redundant sends from
  // multiple viewers converge on the same SCSS and are harmless.
  const botIds = new Set(sheets.map((s) => s.peer).filter((p) => p && p !== local?.jitsiId));
  for (const botId of botIds) {
    const peer = getPeerByJitsiId(botId);
    if (!peer?.isBot || !peer.peerId) continue;
    const botSheets = sheets.filter((s) => s.peer === botId);
    const botScss = buildPeerScss(botSheets, { peerClass: peerTextClass(botId) });
    if (botScss === lastSentScssByBot.get(botId)) continue;
    lastSentScssByBot.set(botId, botScss);
    sendPeerScss(peer.peerId, botScss);
  }
}

// Install one peer's compiled CSS. Sheets are ordered by jitsiId so the cascade
// resolves the same way in every browser — two performers styling the same
// selector must not disagree about who wins depending on join order.
function installPeerCss(peerId, css) {
  let el = styleEls.get(peerId);
  if (css) {
    // The sidecar compiles what it is handed and cannot tell an honest client
    // from a patched one, so the guardrails are enforced again here, on the
    // way into this document. Refuse the whole sheet, matching the way a
    // statement is refused on the authoring side.
    const errors = checkCompiledCss(css);
    if (errors.length) {
      console.error(`[css-cycles] refused the sheet from ${peerId}:`, errors.join('; '));
      css = '';
    }
  }
  if (!css) {
    el?.remove();
    styleEls.delete(peerId);
    return;
  }
  let added = false;
  if (!el) {
    el = document.createElement('style');
    el.id = `${STYLE_PREFIX}${peerId}`;
    el.dataset.ccPeer = peerId;
    styleEls.set(peerId, el);
    added = true;
  }
  if (el.textContent !== css) {
    el.textContent = css;
    // Anything the guardrails measure against the live document is now stale.
    bgCache.clear();
  }
  // Re-appending moves the node, which costs a style recalc — and this runs on
  // every peer-state event, which is metrics-frequent. Only the arrival of a
  // new peer can change the order.
  if (added) reorderSheets();
}

// Sheets are ordered by jitsiId so the cascade resolves the same way in every
// browser — two performers styling the same selector must not disagree about
// who wins depending on the order they happened to join in.
function reorderSheets() {
  const ordered = [...styleEls.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [, node] of ordered) document.head.appendChild(node);
}

// Peer state carries compiledCss the same way it carries pattern text, so a
// sheet arrives (and leaves) with its author.
function syncFromPeers() {
  const seen = new Set();
  for (const peer of getAllPeers()) {
    if (!peer.jitsiId) continue;
    seen.add(peer.jitsiId);
    // Styling stops with the music, like text and audio — otherwise a hostile
    // sheet would outlive the performer who wrote it.
    installPeerCss(peer.jitsiId, peer.playing ? (peer.compiledCss || '') : '');
  }
  for (const peerId of [...styleEls.keys()]) {
    if (!seen.has(peerId)) installPeerCss(peerId, '');
  }
}

// --- The contrast pass -------------------------------------------------------

// The nearest ancestor background that is actually painted. Text sits on
// whatever is behind it, which may be several transparent layers up. Returns
// null when nothing in the chain is opaque: an unmeasurable background is not
// a collision, and guessing one would push the text the wrong way.
function effectiveBackground(el) {
  let node = el;
  while (node) {
    const bg = getComputedStyle(node).backgroundColor;
    const parsed = parseColor(bg);
    if (parsed && parsed.a > 0.1) return bg;
    node = node.parentElement;
  }
  return null;
}

// The background a statement's rule will land on, cached briefly: the hot path
// runs per hap and getComputedStyle forces layout.
function backgroundForSelector(selector) {
  const now = Date.now();
  const hit = bgCache.get(selector);
  if (hit && now - hit.at < BG_CACHE_MS) return hit.color;
  let color = null;
  try {
    const el = document.querySelector(selector);
    if (el) color = effectiveBackground(el);
  } catch (e) {
    // An unparseable selector is the performer's problem, not a crash.
    console.warn('[css-cycles] could not resolve selector', selector, e);
  }
  bgCache.set(selector, { color, at: now });
  return color;
}

// The selector a statement's patterned declarations land on — everything in the
// SCSS before its first brace. A rule can match many elements sitting on
// different backgrounds; the first match is sampled as a representative, since
// one custom property serves the whole rule.
function selectorOf(sheet) {
  const src = String(sheet?.scss ?? '').trim();
  const brace = src.indexOf('{');
  return (brace === -1 ? src : src.slice(0, brace)).trim();
}

// The room's own value for a selector+prop, read off the live DOM before this
// module has ever overridden it. Cached forever per pair: capturing it again
// after an override has been applied would just record our own prior hap.
function captureBaseline(selector, prop) {
  const key = `${selector}||${prop}`;
  if (baselineValues.has(key)) return baselineValues.get(key);
  let value = null;
  try {
    const el = selector ? document.querySelector(selector) : null;
    if (el) value = getComputedStyle(el).getPropertyValue(prop) || null;
  } catch (e) {
    console.warn('[css-cycles] could not capture baseline for', selector, prop, e);
  }
  baselineValues.set(key, value);
  return value;
}

// --- Trigger -----------------------------------------------------------------

function applyHap(value) {
  const token = String(value.css);
  const sheet = sheetsByToken.get(token);
  if (!sheet || refused.has(token)) return;

  // Mutual exclusion: only the peer currently holding the scheduler's slot
  // gets their pattern's values on screen. Everyone else's custom properties
  // are pinned at the room's captured default instead of drifting stale from
  // whatever they last painted before their turn closed. Bots are exempt —
  // they are operator-puppeted via remote-control rather than live turn-taking
  // performers, so an edit should be visible the moment it lands rather than
  // waiting on the ring to reach their slot.
  const gateOpen = getPeerByJitsiId(sheet.peer)?.isBot || isPeerNetCyclesTurn(sheet.peer);
  const selector = selectorOf(sheet);

  for (const [key, raw] of Object.entries(value)) {
    if (!key.startsWith('_cc_')) continue;
    const prop = cssPropForMethod(key.slice(4));
    if (!prop) continue;

    const varName = cssVarName(token, prop);
    const baseline = captureBaseline(selector, prop);

    if (!gateOpen) {
      if (baseline != null) document.documentElement.style.setProperty(varName, baseline);
      continue;
    }

    let resolved = resolve(raw);
    if (resolved == null || resolved === '') continue;

    // A value that was not a literal in source could not be checked when the
    // statement was accepted, so it is clamped now rather than refused.
    const declared = sheet.props.find((p) => p.prop === prop);
    if (!declared?.literal) {
      resolved = clampValue(prop, resolved);
      if (resolved == null) continue;
    }

    // Text that has collided with its container is walked away from the
    // background instead of being refused — the collision is a two-party
    // accident and neither statement is illegal alone.
    if (prop === 'color') {
      const bg = backgroundForSelector(selector);
      if (bg) resolved = adjustColorForBackground(resolved, bg);
    }

    document.documentElement.style.setProperty(varName, resolved);
  }
}

// Strudel calls this ahead of time so audio can be sampled accurately; the
// restyle is deferred by the same lead so it lands on the beat rather than
// early.
function handleTrigger(hap, currentTime, cps, targetTime) {
  if (!active) return;
  const value = hap?.value;
  if (!value || value.css == null) return;
  const lead = Number(targetTime) - Number(currentTime);
  const delayMs = Number.isFinite(lead) ? Math.max(0, lead * 1000) : 0;
  setTimeout(() => {
    try {
      applyHap(value);
    } catch (e) {
      console.error('[css-cycles] apply failed', e);
      throw e;
    }
  }, delayMs);
}

// --- Install -----------------------------------------------------------------

let cssSubscribed = false;

// Called once from ensureStrudel after initStrudel. Registers the css control,
// one `_cc_*` control per CSS property, and the renderer; returns the names to
// merge into evalScope so `css(…)` and `await initCss()` resolve in a pattern.
export function installCssCycles(mod) {
  const { registerControl, register } = mod;

  const scope = { ...registerControl('css') };
  for (const prop of CSS_PROPERTY_LIST) {
    // Underscore-namespaced: registering `color` or `filter` would clobber the
    // audio control and the Pattern method every other voice in the room uses.
    Object.assign(scope, registerControl(`_cc_${methodForCssProp(prop)}`));
  }

  // Dominant trigger: this is what makes a css voice silent.
  register('_ccRender', (pat) => pat.onTrigger(handleTrigger, true));

  scope.initCss = async () => {
    active = true;
    if (!cssSubscribed) {
      cssSubscribed = true;
      subscribePeerState(syncFromPeers);
      syncFromPeers();
    }
    return true;
  };

  return scope;
}

// Styling stops with the music: every sheet is pulled and every custom property
// released, so a refused or hostile rule can always be undone by stopping.
export function stopCssCycles() {
  active = false;
  for (const [peerId] of [...styleEls]) installPeerCss(peerId, '');
  for (const sheet of sheetsByToken.values()) {
    for (const p of sheet.props) {
      document.documentElement.style.removeProperty(cssVarName(sheet.token, p.prop));
    }
  }
  sheetsByToken = new Map();
  refused = new Set();
  lastSentScss = '';
  lastSentScssByBot = new Map();
  bgCache.clear();
  baselineValues.clear();
}

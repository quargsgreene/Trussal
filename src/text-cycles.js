// Text Cycles — Strudel patterns that play into the Jitsi chat window.
//
// `await initTextCycles()` declares a program's text presence, exactly as
// `await initHydra()` declares its visuals. After it, a voice like
//
//   $: typeface("Times New Roman").word("<I like@2 ~ squirrels\?>")
//        .size("<12px 24px>*2").color("<#346234 #bfe968>")
//
// paints one styled <span> per hap into a chat bubble, one bubble per cycle
// per performer. Every browser evaluates every peer's program (see strudel.js),
// so all clients render the same words at the same time with no chat traffic —
// nothing is sent over XMPP and nothing lands in the room's message history.
//
// SILENT BY CONSTRUCTION. The renderer is attached with onTrigger(fn, dominant
// = true), and repl.mjs skips defaultOutput whenever a hap carries a dominant
// trigger — so a text voice cannot reach superdough even if it also names a
// sound. Tempo still applies, because *2, @2, fast and slow are pattern
// structure rather than output.
//
// Words arrive as placeholder tokens, not text: krill's grammar cannot hold an
// emoji, a space or a literal "?" in an atom, so text-cycles-core.js mints every
// literal atom into a grammar-legal token and carries the real characters in the
// atom table set here before each evaluate.

import { getPeerByJitsiId } from './peer-state.js';
import { sanitizeDeclarations, sanitizeHref, peerTextClass } from './text-cycles-core.js';

const CONTAINER_ID = 'trussal-text-cycles';
const STYLE_ID = 'trussal-text-cycles-style';
// Chat scrollback cap. Bubbles are per cycle, so a fast pattern still only adds
// one per cycle per performer, but a long set would grow without this.
const MAX_BUBBLES = 200;

let atoms = {};            // token → { text, peer }
let active = false;        // flipped by initTextCycles()
let container = null;      // our node inside #chatconversation; we own its children
let styleEl = null;
let bubbles = new Map();   // `${peer}:${cycle}` → element, newest last
let hoverClasses = new Map(); // `${peerClass}|${declarations}` → generated class
let hoverSeq = 0;

// Named param → CSS property. `size` reads roomsize because Strudel's `size`
// is an alias of the reverb control (controls.mjs:2478) which we reuse rather
// than re-register — overriding it would break .size() for every audio voice.
const CSS_BY_PARAM = [
  ['typeface', 'font-family'],
  ['roomsize', 'font-size'],
  ['weight', 'font-weight'],
  ['color', 'color'],
  ['spacing', 'letter-spacing'],
  ['slant', 'font-style'],
  ['underline', 'text-decoration'],
];

// Replace the atom table. Called by strudel.js immediately before evaluate(),
// so tokens in the program about to run always resolve against their own text.
export function setTextAtoms(table) {
  atoms = table || {};
}

export function isTextCyclesActive() { return active; }

// Token → the characters the performer actually typed. A value that is not a
// token (a runtime string from an uninterpolatable template) is used as-is.
function resolve(value) {
  if (value == null) return null;
  const key = String(value);
  const atom = atoms[key];
  return atom ? atom.text : key;
}

function peerOf(value) {
  const atom = atoms[String(value)];
  return atom ? atom.peer : null;
}

function ensureStyle() {
  if (styleEl && document.contains(styleEl)) return styleEl;
  styleEl = document.getElementById(STYLE_ID) || document.createElement('style');
  styleEl.id = STYLE_ID;
  if (!styleEl.textContent) {
    // Deliberately minimal: with no user CSS, words must inherit Jitsi's own
    // chat typography, so nothing here sets a font, colour or size.
    styleEl.textContent = `
#${CONTAINER_ID} .tc-bubble { margin: 4px 0; padding: 0 16px; overflow-wrap: anywhere; }
#${CONTAINER_ID} .tc-name { font-size: 12px; opacity: .6; }
#${CONTAINER_ID} .tc-line { white-space: pre-wrap; }
`;
  }
  if (!document.contains(styleEl)) document.head.appendChild(styleEl);
  return styleEl;
}

// Attach (or re-attach) our container inside Jitsi's chat log. The panel is
// unmounted whenever chat is closed and React re-renders the log on every real
// message, so this is re-checked on every paint. Re-inserting the SAME element
// keeps the bubbles we already built — they reappear when chat is reopened.
function ensureContainer() {
  if (!container) {
    container = document.createElement('div');
    container.id = CONTAINER_ID;
  }
  ensureStyle();
  // While chat is CLOSED the panel is unmounted entirely, so the container
  // stays detached and keeps collecting words rather than dropping them —
  // re-inserting the same element when chat reopens brings the backlog with it.
  const log = document.getElementById('chatconversation');
  if (log && container.parentNode !== log) {
    // #messagesListEnd is the sentinel Jitsi's IntersectionObserver watches to
    // decide "scrolled to bottom", so it has to stay last.
    const sentinel = document.getElementById('messagesListEnd');
    if (sentinel && sentinel.parentNode === log) log.insertBefore(container, sentinel);
    else log.appendChild(container);
  }
  return container;
}

// Ask Jitsi to open the chat panel. OPEN_CHAT is a real action type in the
// deployed bundle; if the store shape ever changes this simply does nothing
// and words accumulate until the user opens chat themselves.
function openChatPanel() {
  try {
    window.APP?.store?.dispatch({ type: 'OPEN_CHAT' });
  } catch (e) {
    console.warn('[text-cycles] could not open the chat panel', e);
  }
}

// One reusable hover rule per (participant, declaration) pair. Inline styles
// cannot express :hover, so these are the only generated stylesheet rules.
function hoverClassFor(peerClass, declarations) {
  const decls = sanitizeDeclarations(declarations);
  if (!decls.length) return null;
  const key = `${peerClass}|${decls.map(([p, v]) => `${p}:${v}`).join(';')}`;
  if (hoverClasses.has(key)) return hoverClasses.get(key);
  const cls = `tc-h${hoverSeq++}`;
  const body = decls.map(([p, v]) => `${p}:${v}`).join(';');
  ensureStyle().textContent += `\n#${CONTAINER_ID} .${peerClass} .${cls}:hover { ${body} }`;
  hoverClasses.set(key, cls);
  return cls;
}

function bubbleFor(peerId, cycle, peerClass) {
  const key = `${peerId}:${cycle}`;
  // Checked against the container, not isConnected: while chat is closed the
  // container is detached, and isConnected would report every bubble as gone
  // and mint a duplicate for the same cycle on every hap.
  const existing = bubbles.get(key);
  if (existing && existing.parentNode === container) return existing;

  const bubble = document.createElement('div');
  bubble.className = `tc-bubble ${peerClass}`;

  const peer = peerId ? getPeerByJitsiId(peerId) : null;
  const name = document.createElement('div');
  name.className = 'tc-name';
  // textContent throughout — a display name is user-controlled too.
  name.textContent = peer?.displayName || 'text';
  bubble.appendChild(name);

  const line = document.createElement('div');
  line.className = 'tc-line';
  bubble.appendChild(line);

  container.appendChild(bubble);
  bubbles.set(key, bubble);

  while (bubbles.size > MAX_BUBBLES) {
    const oldest = bubbles.keys().next().value;
    bubbles.get(oldest)?.remove();
    bubbles.delete(oldest);
  }
  return bubble;
}

function paint(value, cycle) {
  ensureContainer();
  const text = resolve(value.word);
  if (text == null || text === '') return;

  const peerId = peerOf(value.word);
  const peerClass = peerTextClass(peerId);
  const bubble = bubbleFor(peerId, cycle, peerClass);
  const line = bubble.lastChild;

  const span = document.createElement('span');
  span.className = `tc-word ${peerClass}`;
  span.textContent = text;

  for (const [param, prop] of CSS_BY_PARAM) {
    if (value[param] == null) continue;
    // Route through the same sanitiser as css() so one path governs what can
    // reach a style, and so "underline" or a colour cannot smuggle a url().
    for (const [p, v] of sanitizeDeclarations(`${prop}: ${resolve(value[param])}`)) {
      span.style.setProperty(p, v);
    }
  }
  // css() last, so it wins on conflict — it is the arbitrary-property escape
  // hatch and should be able to override a named param.
  if (value.css != null) {
    const raw = typeof value.css === 'object' ? value.css : resolve(value.css);
    for (const [p, v] of sanitizeDeclarations(raw)) span.style.setProperty(p, v);
  }
  if (value.hover != null) {
    const cls = hoverClassFor(peerClass, resolve(value.hover));
    if (cls) span.classList.add(cls);
  }

  let node = span;
  if (value.hyperlink != null) {
    const href = sanitizeHref(resolve(value.hyperlink));
    if (href) {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.appendChild(span);
      node = a;
    }
  }

  if (line.childNodes.length) line.appendChild(document.createTextNode(' '));
  line.appendChild(node);

  // Follow the conversation only if the reader is already at the bottom, so
  // scrolling back through chat is not yanked away by the next word.
  const log = container.parentNode;
  if (log && log.scrollHeight - log.scrollTop - log.clientHeight < 80) {
    log.scrollTop = log.scrollHeight;
  }
}

// Scheduler trigger. Strudel calls this ahead of time so audio can be sampled
// accurately; the paint is deferred by the same lead so words land in step with
// the beat rather than early.
function handleTrigger(hap, currentTime, cps, targetTime) {
  if (!active) return;
  const value = hap?.value;
  if (!value || value.word == null) return;
  const begin = hap.whole?.begin ?? hap.part?.begin;
  const cycle = Math.floor(Number(begin?.valueOf?.() ?? begin ?? 0));
  const lead = Number(targetTime) - Number(currentTime);
  const delayMs = Number.isFinite(lead) ? Math.max(0, lead * 1000) : 0;
  setTimeout(() => {
    try {
      paint(value, cycle);
    } catch (e) {
      console.error('[text-cycles] paint failed', e);
      throw e;
    }
  }, delayMs);
}

// Called once from ensureStrudel after initStrudel. Registers the text controls
// and the renderer, and returns the names to merge into evalScope so `word(…)`
// and `await initTextCycles()` resolve inside a pattern.
export function installTextCycles(mod) {
  const { registerControl, register } = mod;

  // `size` and `color` are intentionally NOT registered — they already exist
  // and are reused, so .size("12px") and .color("#346234") work as written
  // without clobbering the reverb and colour controls other voices depend on.
  const scope = {
    ...registerControl('word', 'w'),
    ...registerControl('typeface', 't'),
    ...registerControl('weight'),
    ...registerControl('spacing'),
    ...registerControl('slant'),
    ...registerControl('hover'),
    ...registerControl('hyperlink'),
    ...registerControl('underline'),
    ...registerControl('css'),
  };

  // Dominant trigger: this is what makes a text voice silent.
  register('_tcRender', (pat) => pat.onTrigger(handleTrigger, true));

  scope.initTextCycles = async () => {
    if (!active) {
      active = true;
      openChatPanel();
    }
    ensureContainer();
    return true;
  };

  return scope;
}

// Text stops with the music. The bubbles already painted stay in the chat —
// they read as conversation history, not as live state.
export function stopTextCycles() {
  active = false;
}

// Text Cycles — Strudel patterns that play into the Jitsi chat window.
//
// `await initTextCycles()` declares a program's text presence, exactly as
// `await initHydra()` declares its visuals. After it, a voice like
//
//   $: typeface('Times New Roman').word("<I like@2 ~ squirrels\?>")
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
//
// Double-quoted values go through MINI notation, where a bare space separates
// sequence steps — that is how `.weight("400 200 100 800")` cycles through four
// weights across a cycle. A value that must stay ONE atom despite its own
// spaces (a font family like "Times New Roman") needs single quotes instead,
// which bypass mini entirely (see rewriteTextCalls in text-cycles-core.js) —
// double-quoting it would mint three separate one-third-cycle steps.

import { getPeerByJitsiId, getLocalPeer, isPeerNetCyclesTurn } from './peer-state.js';
import { sanitizeDeclarations, sanitizeHref, peerTextClass } from './text-cycles-core.js';
import { textLog, textLogChanged, textHapLog, textWarn, registerTextProbe, clip } from './text-debug.js';
// The room's `#` effects, as they apply to words and their styling. The
// mutations are pure and SEEDED there, so every browser paints the same
// characters from the same shared program.
import { crushWord, noiseWord, mutateNumber } from './audio-net/av-effects/TextState.js';

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
  // STORAGE POINT 4: the words as characters, keyed by the token the program
  // carries. A token the renderer cannot find here paints as raw "tc7".
  textLogChanged('atoms', {
    count: Object.keys(atoms).length,
    table: Object.fromEntries(Object.entries(atoms).map(([t, a]) => [t, `${a.text} (${a.peer ?? 'no peer'})`])),
  });
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
  // STORAGE POINT 6: where the painted spans actually are. Detached is not an
  // error state — that is how the backlog survives a closed chat — but it IS
  // the state in which a perfectly working pipeline shows nothing at all, so
  // it has to be visible. Logged on transitions only; this runs per hap.
  textLogChanged('container', {
    attached: container.parentNode === log && !!log,
    chatLogInDocument: !!log,
    bubbles: bubbles.size,
    ...(log ? {} : { why: chatAbsenceReason() }),
  });
  return container;
}

// --- entering the chat --------------------------------------------------------
//
// Jitsi gates the message LOG behind a nickname. With no name on the local
// participant the chat panel renders its DisplayNameForm INSTEAD of the message
// container, so #chatconversation is not in the document at all — our container
// never finds a parent and every word is painted into a detached div. That is
// indistinguishable, from the outside, from a pipeline that never ran.
//
// Running a text pattern is the gesture that asks for the chat, so it also
// supplies the nickname: the performer's Net Cycles room index, which is the
// token the metaprogram already addresses them by, so a bubble is labelled with
// the identity the room uses rather than an anonymous "text".
//
// A performer who chose their own name keeps it — the prompt is already
// satisfied for them, and the name is theirs across the whole meeting UI, not
// just this panel.

// The chat DOM is missing for two quite different reasons and the fix differs,
// so say which.
function chatAbsenceReason() {
  const state = jitsiState();
  if (!state) return 'no Jitsi store yet';
  const local = state['features/base/participants']?.local;
  if (!local?.name) {
    return 'the local participant has no display name — Jitsi is showing the chat nickname prompt instead of the message list';
  }
  return 'the chat panel is closed (words are collecting in a detached container and appear when it reopens)';
}

function jitsiState() {
  const store = typeof window !== 'undefined' ? window.APP?.store : null;
  return store && typeof store.getState === 'function' ? store.getState() : null;
}

function localParticipantName() {
  const state = jitsiState();
  const name = state?.['features/base/participants']?.local?.name;
  return typeof name === 'string' && name.trim() ? name : null;
}

// The performer's Net Cycles token. Assigned by the sidecar in its roster, so
// it can arrive after the first evaluate — which is why the entry below
// retries rather than giving up on the first miss.
function localToken() {
  const index = getLocalPeer()?.roomIndex;
  return index == null || index === '' ? null : String(index);
}

// Exactly what Jitsi's own nickname form dispatches (updateSettings →
// SETTINGS_UPDATED). The base/settings middleware copies displayName onto the
// local participant as `name`, which is the field the chat panel's prompt
// tests, so this both dismisses the prompt and names us in the room.
function setNickname(name) {
  const store = typeof window !== 'undefined' ? window.APP?.store : null;
  if (!store || typeof store.dispatch !== 'function') return false;
  store.dispatch({ type: 'SETTINGS_UPDATED', settings: { displayName: name } });
  return true;
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

let chatEntryTimer = null;
let chatEntryTries = 0;
// ~20s. Long enough to cover the sidecar handshake that assigns the token and
// the React renders that mount the panel, short enough that a page which will
// never get there says so instead of retrying for the whole set.
const CHAT_ENTRY_MAX_TRIES = 40;
const CHAT_ENTRY_INTERVAL_MS = 500;

// Take a nickname, open the panel, attach the container — retrying while the
// pieces arrive. Stops as soon as the container is in the document, so a
// performer who later closes the chat is not fought over it.
function ensureChatEntry() {
  if (chatEntryTimer !== null) return;
  chatEntryTries = 0;
  const attempt = () => {
    chatEntryTimer = null;
    if (!active) {
      textLog('chat-entry:abandoned', { reason: 'text cycles stopped before the chat opened' });
      return;
    }
    chatEntryTries++;

    const name = localParticipantName();
    const token = localToken();
    if (!name) {
      if (token) {
        const dispatched = setNickname(token);
        textLog('chat-entry:nickname', {
          token,
          dispatched,
          note: dispatched ? 'set as the display name — this is what dismisses the chat nickname prompt' : 'no Jitsi store to dispatch to',
        });
      } else {
        textLog('chat-entry:waiting', {
          try: chatEntryTries,
          reason: 'the sidecar has not assigned a room index yet, so there is no token to use as the nickname',
        });
      }
    }
    openChatPanel();
    const attached = ensureContainer().parentNode != null;

    textLog('chat-entry', {
      try: chatEntryTries,
      participantName: localParticipantName(),
      token,
      chatLogInDocument: !!document.getElementById('chatconversation'),
      attached,
    });
    if (attached) return;
    if (chatEntryTries >= CHAT_ENTRY_MAX_TRIES) {
      // Not fatal: the container keeps collecting, and a later paint attaches
      // it the moment the log appears — including if the performer opens chat
      // or types a nickname by hand.
      textWarn('chat-entry', 'gave up opening the chat; words are collecting in a detached container and will appear if it opens later', {
        tries: chatEntryTries,
        why: chatAbsenceReason(),
      });
      return;
    }
    chatEntryTimer = setTimeout(attempt, CHAT_ENTRY_INTERVAL_MS);
  };
  attempt();
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
  // A new bubble for this peer means their previous turn is over, which is the
  // first moment its last word is KNOWN to have been last — so that is where
  // echo's repeats go.
  if (!bubbles.has(key)) echoLastWord(peerId);
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

// --- effect plumbing ----------------------------------------------------------

// Per-(peer, cycle) word counter. It NAMES the occurrence a mutation is drawn
// for, so the third word of a turn mutates the same way in every browser while
// the first and second do not follow it.
let wordCounters = new Map();
function nextWordIndex(peerId, cycle) {
  const key = `${peerId}:${cycle}`;
  const n = (wordCounters.get(key) ?? 0);
  wordCounters.set(key, n + 1);
  // The map is keyed by cycle, so it would grow for the length of a set.
  if (wordCounters.size > 512) {
    for (const k of wordCounters.keys()) {
      if (wordCounters.size <= 256) break;
      wordCounters.delete(k);
    }
  }
  return n;
}

// A stable integer for a peer id. hashSeed mixes integers, and the peer has to
// be part of the seed or two performers saying the same word in the same cycle
// would have it mutated identically.
function peerSeed(peerId) {
  const s = String(peerId ?? '');
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  return h;
}

// Numbers inside a declaration, quantized by crush and jittered by noise. The
// unit is preserved — only the magnitude moves — and a value with no number in
// it (a font family, `italic`, `underline`) passes through untouched.
const NUMBER_UNIT_RE = /(-?\d*\.?\d+)(px|em|rem|%|pt|vh|vw)?/g;
const HEX_COLOUR_RE = /#([0-9a-fA-F]{6})\b/g;

function mutateDeclaration(prop, value, fx, cycle, peer, index) {
  if (!fx || (!(fx.quantizeStep > 1) && !(fx.jitter > 0) && !(fx.colorLevels > 0 && fx.colorLevels < 256))) {
    return value;
  }
  let out = String(value);
  // Colour is quantized by BIT DEPTH rather than by the numeric step: posterizing
  // the channels is what crush means for a colour, and running it through the
  // generic number path would instead nudge the digits of the hex string.
  if (fx.colorLevels > 0 && fx.colorLevels < 256) {
    const levels = Math.max(2, Math.round(fx.colorLevels));
    out = out.replace(HEX_COLOUR_RE, (_m, hex) => {
      const step = 255 / (levels - 1);
      const channel = (i) => {
        const v = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        return Math.round(Math.round(v / step) * step).toString(16).padStart(2, '0');
      };
      return `#${channel(0)}${channel(1)}${channel(2)}`;
    });
    // Channels are done; don't let the numeric pass walk the hex digits too.
    if (/^#/.test(out.trim())) return out;
  }
  let nth = 0;
  return out.replace(NUMBER_UNIT_RE, (match, num, unit) => {
    const mutated = mutateNumber(parseFloat(num), fx, cycle, peer, index * 16 + (nth++));
    if (!Number.isFinite(mutated)) return match;
    return `${Math.round(mutated * 100) / 100}${unit || ''}`;
  });
}

// The previous turn's declarations, per peer, for echo's CSS crossfade.
let previousTurnStyle = new Map();

function rememberTurnStyle(peerId, span) {
  previousTurnStyle.set(String(peerId), span.style.cssText);
}

// Paint the span with the PREVIOUS turn's declarations, then let the real ones
// transition in. A span is created fresh for every word, so there is otherwise
// nothing for a CSS transition to move from and the styling switches hard at
// the turn boundary — which is precisely what echo should soften.
function crossfadeFromPreviousTurn(span, peerId, fx) {
  const previous = previousTurnStyle.get(String(peerId));
  if (!previous) return;
  const target = span.style.cssText;
  if (previous === target) return;
  const seconds = Math.max(0.05, fx.fadeFromPrevious * 2);
  span.style.cssText = previous;
  span.style.transition = `all ${seconds.toFixed(2)}s linear`;
  // Next frame, so the browser has the starting values before they change.
  requestAnimationFrame(() => {
    span.style.cssText = `${target};transition:all ${seconds.toFixed(2)}s linear`;
  });
}

// echo — the last word of a turn comes back, fading. Called when a peer's
// bubble is superseded, which is the moment its last word is known to be last.
function echoLastWord(peerId) {
  const held = lastWordOfTurn.get(String(peerId));
  if (!held) return;
  lastWordOfTurn.delete(String(peerId));
  const { text, line, repeats, alpha, peerClass } = held;
  if (!(repeats > 0) || !line || !line.isConnected) return;
  for (let i = 1; i <= repeats; i++) {
    const echo = document.createElement('span');
    echo.className = `tc-word tc-echo ${peerClass}`;
    echo.textContent = text;
    // Each repeat quieter than the last, as a delay's are.
    echo.style.opacity = String(Math.max(0.05, alpha * Math.pow(0.6, i)));
    line.appendChild(document.createTextNode(' '));
    line.appendChild(echo);
  }
}

let lastWordOfTurn = new Map();

function paint(value, cycle) {
  ensureContainer();
  let text = resolve(value.word);
  if (text == null || text === '') {
    textHapLog('paint:empty', { token: value.word, note: 'token resolved to nothing — it is not in the atom table for the program that is running' });
    return;
  }

  const peerId = peerOf(value.word);
  const peerClass = peerTextClass(peerId);

  // Bots take their turn on the ring exactly like a human performer — a
  // word() voice a bot announces (its own, when textParrot/random:"full" is
  // set — see cluster-source.js's botScriptFor) is gated the same way. They
  // used to be exempt here (an operator-puppeted edit painted the moment it
  // landed, rather than waiting on the ring), but that predates bots having a
  // voice of their own to schedule at all.
  if (!isPeerNetCyclesTurn(peerId)) {
    textHapLog('paint:gated', {
      token: value.word,
      peer: peerId,
      note: "not this peer's turn — Net Cycles scheduling is active and their gate is closed",
    });
    return;
  }

  // The room's `#` chain, as it applies to words and their styling. Published
  // by the Effects Service (av-effects/index.js) rather than computed here,
  // and carrying the NET CYCLES cycle number — every mutation below is seeded
  // from it, so each browser paints the same characters. `cycle` above is the
  // Strudel hap's and is per-browser, which is exactly why it is not the seed.
  const fx = (typeof window !== 'undefined' && window._ncText) || null;
  const active = fx && fx.active ? fx : null;
  const seedCycle = active ? active.cycle : 0;
  const seedPeer = peerSeed(peerId);
  const wordIndex = nextWordIndex(peerId, cycle);

  if (active) {
    const authored = text;
    // crush first, then noise — the master path's order, so the glyphs a bed
    // adds are not themselves eaten by the decimation.
    text = crushWord(text, active.text.dropChance, seedCycle, seedPeer, wordIndex);
    // A word crushed away entirely paints nothing. That is the effect working,
    // not an error: the same directive is dropping samples out of the audio.
    if (!text) {
      textHapLog('paint:crushed-away', { authored, seedCycle, wordIndex, note: 'the room `#` chain dropped every character — the effect working, not a failure' });
      return;
    }
    text = noiseWord(text, active.text, seedCycle, seedPeer, wordIndex);
  }

  const bubble = bubbleFor(peerId, cycle, peerClass);
  const line = bubble.lastChild;

  const span = document.createElement('span');
  span.className = `tc-word ${peerClass}`;
  span.textContent = text;

  const styleFx = active ? active.css : null;
  for (const [param, prop] of CSS_BY_PARAM) {
    if (value[param] == null) continue;
    // Sanitised even though these are named params, so "underline" or a colour
    // cannot smuggle a url() into a style attribute.
    for (const [p, v] of sanitizeDeclarations(`${prop}: ${resolve(value[param])}`)) {
      span.style.setProperty(p, mutateDeclaration(p, v, styleFx, seedCycle, seedPeer, wordIndex));
    }
  }
  if (value.hover != null) {
    const cls = hoverClassFor(peerClass, resolve(value.hover));
    if (cls) span.classList.add(cls);
  }

  if (styleFx) {
    // room — the tail pushes the letters apart. ADDED to whatever the
    // performer wrote, so their own .spacing() stays legible in the result and
    // a room with no decay is a no-op rather than an override.
    if (styleFx.blurPx > 0) span.style.filter = `blur(${styleFx.blurPx.toFixed(2)}px)`;
    if (active.text.spacingPx > 0) {
      const authored = parseFloat(span.style.letterSpacing) || 0;
      span.style.letterSpacing = `${(authored + active.text.spacingPx).toFixed(2)}px`;
    }
    // echo — each turn's styling arrives out of the previous turn's instead of
    // switching hard. The span is new every time, so there is nothing for a
    // transition to move FROM: paint it with the previous turn's declarations,
    // then let the real ones transition in over the delay.
    if (styleFx.fadeFromPrevious > 0) crossfadeFromPreviousTurn(span, peerId, styleFx);
    rememberTurnStyle(peerId, span);
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

  // The last thing that can be said about a word: it is in the DOM. Whether a
  // human can SEE it is the container's question, one line up — a span in a
  // detached container is painted and invisible.
  textHapLog('paint', {
    text,
    peer: peerId,
    cycle,
    visible: !!container.parentNode,
    style: span.style.cssText || '(inherited from Jitsi chat)',
  });

  // Held rather than echoed now: which word is the turn's LAST is only known
  // once the turn ends (echoLastWord, from bubbleFor).
  if (active && active.text.repeats > 0 && active.text.repeatAlpha > 0) {
    lastWordOfTurn.set(String(peerId), {
      text, line, peerClass,
      repeats: active.text.repeats,
      alpha: active.text.repeatAlpha
    });
  }

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
  // STORAGE POINT 5b: the hap, as the scheduler hands it over. Reaching here
  // at all proves ._tcRender() was attached and the program evaluated; a hap
  // with no `word` is a text statement that lost its word() in the rewrite.
  if (!active) {
    textHapLog('trigger:inactive', { note: 'a hap arrived but initTextCycles() has not run in this evaluate', value: hap?.value });
    return;
  }
  const value = hap?.value;
  if (!value || value.word == null) {
    textHapLog('trigger:no-word', { value });
    return;
  }
  const begin = hap.whole?.begin ?? hap.part?.begin;
  const cycle = Math.floor(Number(begin?.valueOf?.() ?? begin ?? 0));
  const lead = Number(targetTime) - Number(currentTime);
  const delayMs = Number.isFinite(lead) ? Math.max(0, lead * 1000) : 0;
  textHapLog('trigger', { token: value.word, text: resolve(value.word), cycle, delayMs: Math.round(delayMs) });
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
  };

  // Dominant trigger: this is what makes a text voice silent.
  register('_tcRender', (pat) => pat.onTrigger(handleTrigger, true));

  scope.initTextCycles = async () => {
    const wasActive = active;
    active = true;
    // Every evaluate re-runs the preamble, so this is also the room's heartbeat
    // for "a text program is running" — but the chat entry only has to be
    // driven when it was not already.
    if (!wasActive) {
      textLog('init', {
        note: 'a program declared text presence — taking a nickname and opening the chat',
        participantName: localParticipantName(),
        token: localToken(),
      });
      ensureChatEntry();
    }
    ensureContainer();
    return true;
  };

  return scope;
}

// Text stops with the music. The bubbles already painted stay in the chat —
// they read as conversation history, not as live state.
export function stopTextCycles() {
  textLog('stop', { bubblesKept: bubbles.size });
  active = false;
  if (chatEntryTimer !== null) {
    clearTimeout(chatEntryTimer);
    chatEntryTimer = null;
  }
  // Per-turn effect state, dropped with the run. Words already painted stay as
  // history, but a turn that never ended must not echo its last word into the
  // next set, and a stale previous-turn style must not be what the next one
  // crossfades out of.
  lastWordOfTurn.clear();
  previousTurnStyle.clear();
  wordCounters.clear();
}

// Everything the renderer is holding right now, for __trussalText.state().
// Pulled rather than pushed: these are the questions asked AFTER the words
// failed to appear, and none of them is worth a line per hap.
registerTextProbe('renderer', () => ({
  active,
  atoms: Object.keys(atoms).length,
  bubbles: bubbles.size,
  containerAttached: !!(container && container.parentNode),
  chatLogInDocument: !!document.getElementById('chatconversation'),
  chatAbsenceReason: document.getElementById('chatconversation') ? null : chatAbsenceReason(),
  participantName: localParticipantName(),
  token: localToken(),
  wordsPainted: container ? container.querySelectorAll('.tc-word').length : 0,
  // The characters currently in the chat, so a page can be asked what it is
  // showing without reading the DOM by hand.
  lines: container
    ? Array.from(container.querySelectorAll('.tc-line')).slice(-5).map((el) => clip(el.textContent, 120))
    : [],
}));

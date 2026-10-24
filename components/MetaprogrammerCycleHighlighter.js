// Cycle highlighter: a rectangular outline around the part of the program the
// aggregator is playing RIGHT NOW — the participant token whose audio is
// streaming, or the `~` the program is resting at, each with the postfix
// operators that shape its turn (`4@3`, `10!2`, `2a?`) — drawn inside the shared
// editor (rather than a separate row of chips). A rest is a slot like any
// other, so it gets the same outline; the room hears no participant for its
// span, while the aggregator's master-bus reverb — untouched by the rest —
// rings on.
//
// The aggregator bot owns the ring (turns last the program's network-derived
// cycle length, so they stretch and tighten with the room) and broadcasts its current
// turn as `jp-active` over the sidecar; peer-state surfaces that as the
// 'trussal-jpattern-active' DOM event (and getActiveJPatternToken()). This
// highlighter outlines whichever token in the LIVE editor text matches the
// active token, and moves to the next one whenever a new turn is reported. With
// no aggregator in the room there is no signal, so no outline is drawn.
//
// Token pixel positions are measured with a hidden mirror <div> that replicates
// the textarea's box model, so the outline tracks the live text (edits,
// wrapping, scroll) with no framework. The pure text→offset half lives in
// metaprogrammer-cycle-highlighter-core.js (node:test covers it); this file is
// only the DOM. Its styles (overlay, mirror, outline box) live in
// MetaprogrammerCycleHighlighter.css, installed by src/styles.css.

import { participantPositions, restPositions } from './metaprogrammer-cycle-highlighter-core.js';
import {
  getActiveJPatternToken, getActiveJPatternIndex, getActiveJPatternKind
} from '../src/peer-state.js';


// Font/box metrics the mirror must share with the textarea for its glyph layout
// to line up. width is set explicitly too (see syncMetrics). syncMetrics hands
// each of these to the element as a --jp-hl-<prop> custom property; the
// .jp-play-mirror rule consumes them with !important — see the CSS file.
const MIRROR_PROPS = [
  'font-family', 'font-size', 'font-weight', 'font-style', 'font-variant',
  'letter-spacing', 'text-transform', 'word-spacing', 'text-indent', 'line-height',
  'tab-size', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left',
  'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width',
  'box-sizing'
];


// The overlay/mirror/box rules live in MetaprogrammerCycleHighlighter.css,
// installed by src/styles.css. The CSS file carries the notes on those rules'
// deliberate lack of !important so a CSS Cycles sheet can still restyle the
// overlay and box.

export function mountMetaprogrammerCycleHighlighter(container) {
  if (!container) return null;
  const ta = container.querySelector('.jp-code');
  if (!ta) return null;
  const host = ta.parentElement;
  if (!host || host.querySelector('.jp-play-overlay')) return null; // idempotent

  if (getComputedStyle(host).position === 'static') host.classList.add('jp-play-host');

  const overlay = document.createElement('div');
  overlay.className = 'jp-play-overlay';
  const mirror = document.createElement('div');
  mirror.className = 'jp-play-mirror';
  // One reused box, moved between tokens — avoids churning a DOM node on every
  // reposition (new turn, edit, scroll, resize). Hidden until .jp-shown.
  const box = document.createElement('div');
  box.className = 'jp-play-box';
  overlay.appendChild(box);
  host.append(overlay, mirror);

  // The aggregator's current ring turn (token + which occurrence, or a rest),
  // from peer-state.
  let activeToken = getActiveJPatternToken();
  let activeIndex = getActiveJPatternIndex();
  let activeKind = getActiveJPatternKind();

  // Copy font/box metrics onto the mirror and align the overlay to the
  // textarea. clientWidth already excludes any scrollbar, so the mirror wraps
  // exactly as the textarea does.
  //
  // The metrics ride as --jp-hl-* custom properties, consumed with !important
  // by .jp-play-mirror: custom.css ships `*, ::before, ::after { font-family: …
  // !important }` (the flat-theme font override). A <textarea> keeps its own
  // stack via a more specific `textarea` rule, but a plain <div> like this
  // mirror does not — so a plain `mirror.style.fontFamily = cs.fontFamily` was
  // silently overridden back to the theme font, and the mirror measured glyph
  // advances in a DIFFERENT font than the textarea renders. On any machine
  // where the two fonts have unequal metrics that pushed the outline box
  // further off the token the further into the line it sat. The
  // .jp-play-mirror class rule outspecifies the theme's bare `*`, so its
  // !important declarations win and the mirror always lays text out in the
  // textarea's real computed font.
  function syncMetrics() {
    const cs = getComputedStyle(ta);
    for (const p of MIRROR_PROPS) mirror.style.setProperty(`--jp-hl-${p}`, cs.getPropertyValue(p));
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0;
    mirror.style.setProperty('--jp-hl-width', (ta.clientWidth + bl + br) + 'px'); // border-box → content matches
    overlay.style.setProperty('--jp-hl-x', ta.offsetLeft + 'px');
    overlay.style.setProperty('--jp-hl-y', ta.offsetTop + 'px');
    overlay.style.setProperty('--jp-hl-w', ta.offsetWidth + 'px');
    overlay.style.setProperty('--jp-hl-h', ta.offsetHeight + 'px');
  }

  // Pixel rect of [offset, offset+len) relative to the textarea's border-box
  // top-left (before scrolling), via the mirror.
  function measureToken(text, offset, len) {
    mirror.textContent = '';
    const span = document.createElement('span');
    span.textContent = text.slice(offset, offset + len) || ' ';
    mirror.append(
      document.createTextNode(text.slice(0, offset)),
      span,
      document.createTextNode(text.slice(offset + len))
    );
    const m = mirror.getBoundingClientRect();
    const s = span.getBoundingClientRect();
    return { top: s.top - m.top, left: s.left - m.left, width: s.width, height: s.height };
  }

  const PAD = 2;
  function renderOutline() {
    const text = ta.value;
    // Outline the exact occurrence the aggregator is streaming: prefer the
    // ring-slot index (so `<0 1 0>` outlines the right `0`), falling back to the
    // first matching token only when the index doesn't line up with the live
    // text (e.g. the editor was edited ahead of the applied program). Nothing to
    // draw without a signal or when the token isn't in the text.
    let pos = null;
    if (activeKind === 'rest') {
      // Resting: outline the `~` the program is resting at, addressed by index
      // alone. Unlike a participant there is no token to cross-check the index
      // against, so an editor typed AHEAD of the applied program can renumber
      // the rests and land the box on a rest the program isn't resting at —
      // out of range draws nothing, in-range-but-stale draws the wrong glyph.
      // Both resolve themselves on the next apply; a rest slot is only ever
      // marking time, so a briefly misplaced box is cheaper than the round trip
      // it would take to make it authoritative.
      pos = activeIndex != null ? restPositions(text)[activeIndex] : null;
    } else if (activeToken != null) {
      const positions = participantPositions(text);
      const atIndex = activeIndex != null ? positions[activeIndex] : null;
      pos = (atIndex && atIndex.token === activeToken)
        ? atIndex
        : positions.find(p => p.token === activeToken);
    }
    if (!pos) { box.classList.remove('jp-shown'); return; }
    syncMetrics();
    const m = measureToken(text, pos.offset, pos.len);
    box.style.setProperty('--jp-box-w', (m.width + PAD * 2) + 'px');
    box.style.setProperty('--jp-box-h', (m.height + 2) + 'px');
    box.style.setProperty('--jp-box-tf',
      `translate(${m.left - ta.scrollLeft - PAD}px, ${m.top - ta.scrollTop - 1}px)`);
    box.classList.add('jp-shown');
  }

  // New turn from the aggregator → move (or clear) the outline.
  document.addEventListener('trussal-jpattern-active', (e) => {
    activeToken = e.detail ? e.detail.token : null;
    activeIndex = e.detail ? e.detail.index : null;
    activeKind = e.detail ? e.detail.kind : null;
    renderOutline();
  });

  // Keep the outline glued to the live text: edits, remote/roster program
  // changes, scrolling, and manual resize of the textarea.
  ta.addEventListener('input', renderOutline);
  ta.addEventListener('scroll', renderOutline);
  document.addEventListener('trussal-jpattern-program', renderOutline);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(renderOutline).observe(ta);
  }

  renderOutline();
  return overlay;
}

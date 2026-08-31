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
// only the DOM.

import { participantPositions, restPositions } from './metaprogrammer-cycle-highlighter-core.js';
import {
  getActiveJPatternToken, getActiveJPatternIndex, getActiveJPatternKind
} from '../src/peer-state.js';

// Font/box metrics the mirror must share with the textarea for its glyph layout
// to line up. width/whiteSpace are set explicitly (see syncMetrics).
const MIRROR_PROPS = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fontVariant',
  'letterSpacing', 'textTransform', 'wordSpacing', 'textIndent', 'lineHeight',
  'tabSize', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
  'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  'boxSizing'
];

function injectStyleOnce() {
  if (document.getElementById('jp-play-style')) return;
  const style = document.createElement('style');
  style.id = 'jp-play-style';
  // No !important: `html, body, body * { background: #ffffff }` (custom.css) is a
  // default, not a forced override (fixed in 0f02e39), and every class selector
  // here already outspecifies the bare `body *` it used to need beating. This host
  // mounts inside #trussal-studio-overlay, a Trussal root, so leaving these plain
  // lets a CSS Cycles sheet targeting .jp-play-overlay/.jp-play-box win normally
  // through the cascade instead of being unconditionally refused.
  style.textContent = `
    .jp-play-overlay { position:absolute; overflow:hidden; pointer-events:none; z-index:2; background:transparent; }
    .jp-play-mirror {
      position:absolute; top:0; left:-99999px; visibility:hidden;
      white-space:pre-wrap; overflow-wrap:break-word; word-wrap:break-word;
      background:transparent;
    }
    .jp-play-box {
      position:absolute; left:0; top:0; box-sizing:border-box;
      border:2.25px solid #111111; border-radius:0;
      background:transparent;
    }
  `;
  document.head.appendChild(style);
}

export function mountMetaprogrammerCycleHighlighter(container) {
  if (!container) return null;
  const ta = container.querySelector('.jp-code');
  if (!ta) return null;
  const host = ta.parentElement;
  if (!host || host.querySelector('.jp-play-overlay')) return null; // idempotent

  injectStyleOnce();
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

  const overlay = document.createElement('div');
  overlay.className = 'jp-play-overlay';
  const mirror = document.createElement('div');
  mirror.className = 'jp-play-mirror';
  // One reused box, moved between tokens — avoids churning a DOM node on every
  // reposition (new turn, edit, scroll, resize).
  const box = document.createElement('div');
  box.className = 'jp-play-box';
  box.style.display = 'none';
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
  function syncMetrics() {
    const cs = getComputedStyle(ta);
    for (const p of MIRROR_PROPS) mirror.style[p] = cs[p];
    const bl = parseFloat(cs.borderLeftWidth) || 0;
    const br = parseFloat(cs.borderRightWidth) || 0;
    mirror.style.width = (ta.clientWidth + bl + br) + 'px'; // border-box → content matches
    overlay.style.left = ta.offsetLeft + 'px';
    overlay.style.top = ta.offsetTop + 'px';
    overlay.style.width = ta.offsetWidth + 'px';
    overlay.style.height = ta.offsetHeight + 'px';
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
    if (!pos) { box.style.display = 'none'; return; }
    syncMetrics();
    const m = measureToken(text, pos.offset, pos.len);
    box.style.display = '';
    box.style.width = (m.width + PAD * 2) + 'px';
    box.style.height = (m.height + 2) + 'px';
    box.style.transform =
      `translate(${m.left - ta.scrollLeft - PAD}px, ${m.top - ta.scrollTop - 1}px)`;
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

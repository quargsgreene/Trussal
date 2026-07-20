// Cycle highlighter: a rectangular outline around the participant token that is
// currently "up" in the metaprogram's rotation, drawn INSIDE the shared editor
// (rather than a separate row of chips).
//
// There are no live slot events to drive this: the browser-side Net Cycles
// scheduler is dormant by design (setNetCyclesActive is never called in the
// shipping build — see src/audio-net/Metaprogrammer.js), which is exactly why
// the previous chip highlighter was dead. Instead this runs a self-contained
// LOCAL PREVIEW: it flattens the program's `$ participants` sequence into its
// written rotation order (the same flatten the aggregator bot's ring adopts —
// bots/src/bot/aggregator-bot.js `metaprogramTokenSequence`) and advances the
// outline one token every SLOT_MS, the fixed ~4s turn that ring uses.
//
// It previews the LIVE editor text, so the outline always sits on a token the
// user can see. Phase is NOT synced to the aggregator (no shared epoch): this
// is a score-follower for what you're writing, not a readout of which voice the
// assembled master is streaming this instant.

import { parseMetaprogram } from '../src/audio-net/MetaprogrammerParser.js';

// The ring's fixed turn length. Mirrors aggregator-bot.js DEFAULT_SLOT_MS; kept
// as a literal here so this stays a browser-only, no-bot-deploy change.
const SLOT_MS = 4000;

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
  if (document.getElementById('nc-play-style')) return;
  const style = document.createElement('style');
  style.id = 'nc-play-style';
  // The Trussal theme sets `body, body * { background: <panel-green> !important }`,
  // so every element's background is forced opaque unless we beat it with our own
  // !important. Without this the overlay would paint over the whole editor (hiding
  // the metaprogram text) and the box fill would hide the token inside the outline.
  style.textContent = `
    .nc-play-overlay { position:absolute; overflow:hidden; pointer-events:none; z-index:2; background:transparent !important; }
    .nc-play-mirror {
      position:absolute; top:0; left:-99999px; visibility:hidden;
      white-space:pre-wrap; overflow-wrap:break-word; word-wrap:break-word;
      background:transparent !important;
    }
    .nc-play-box {
      position:absolute; left:0; top:0; box-sizing:border-box;
      border:1.5px solid #1ff466; border-radius:3px;
      background:transparent !important;
    }
  `;
  document.head.appendChild(style);
}

// (line, col) are 1-based, as the parser emits them.
function lineColToOffset(text, line, col) {
  let offset = 0;
  const lines = text.split('\n');
  for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
  return offset + (col - 1);
}

// Participant token positions in `$ participants`, depth-first in WRITTEN order
// (every branch of a `|` choice, repeats included) — the same flatten the
// aggregator's ring adopts. Rests and non-participant nodes are skipped, so the
// rotation only ever lands on a real performer token.
function orderedParticipantPositions(text) {
  const { ast } = parseMetaprogram(text);
  const out = [];
  if (!ast.participants) return out;
  const walk = (els) => {
    for (const el of els || []) {
      if (!el) continue;
      if (el.type === 'participant' && el.token != null && el.line != null) {
        const token = String(el.token);
        out.push({ token, offset: lineColToOffset(text, el.line, el.col), len: token.length });
      } else if (el.type === 'choice') {
        (el.options || []).forEach(walk);
      } else if (el.type === 'sequence') {
        (el.stacks || []).forEach(st => walk(st.elements));
      }
    }
  };
  ast.participants.stacks.forEach(st => walk(st.elements));
  return out;
}

export function mountMetaprogrammerCycleHighlighter(container) {
  if (!container) return null;
  const ta = container.querySelector('.nc-code');
  if (!ta) return null;
  const host = ta.parentElement;
  if (!host || host.querySelector('.nc-play-overlay')) return null; // idempotent

  injectStyleOnce();
  if (getComputedStyle(host).position === 'static') host.style.position = 'relative';

  const overlay = document.createElement('div');
  overlay.className = 'nc-play-overlay';
  const mirror = document.createElement('div');
  mirror.className = 'nc-play-mirror';
  // One reused box, moved between tokens — avoids churning a DOM node on every
  // reposition (rotation tick, edit, scroll, resize).
  const box = document.createElement('div');
  box.className = 'nc-play-box';
  box.style.display = 'none';
  overlay.appendChild(box);
  host.append(overlay, mirror);

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
  let slotIndex = 0;
  function renderOutline() {
    const text = ta.value;
    const order = orderedParticipantPositions(text);
    if (!order.length) { box.style.display = 'none'; return; }
    const active = order[slotIndex % order.length];
    syncMetrics();
    const m = measureToken(text, active.offset, active.len);
    box.style.display = '';
    box.style.width = (m.width + PAD * 2) + 'px';
    box.style.height = (m.height + 2) + 'px';
    box.style.transform =
      `translate(${m.left - ta.scrollLeft - PAD}px, ${m.top - ta.scrollTop - 1}px)`;
  }

  renderOutline();
  setInterval(() => { slotIndex++; renderOutline(); }, SLOT_MS);

  // Keep the outline glued to the live text: edits, remote/roster program
  // changes, scrolling, and manual resize of the textarea.
  ta.addEventListener('input', renderOutline);
  ta.addEventListener('scroll', renderOutline);
  document.addEventListener('trussal-netcycles-program', renderOutline);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(renderOutline).observe(ta);
  }

  return overlay;
}

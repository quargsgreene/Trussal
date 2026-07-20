// Cycle highlighter: which performer is playing right now, drawn as a
// rectangular outline around that participant's token *inside* the shared
// metaprogram editor — rather than a separate row of chips.
//
// Slot events arrive ahead of time with network timestamps, so highlights are
// scheduled with the same network→local conversion the audio gates use — what
// lights up matches what is audible. Token pixel positions are measured with a
// hidden mirror <div> that replicates the textarea's box model, so the outline
// tracks the live text (edits, wrapping, scroll) with no framework.

import {
  subscribeSlotEvents,
  getProgramText,
  isNetCyclesActive
} from '../src/audio-net/Metaprogrammer.js';
import { parseMetaprogram } from '../src/audio-net/MetaprogrammerParser.js';

// Font/box metrics the mirror must share with the textarea for its glyph
// layout to line up. width/whiteSpace are set explicitly (see syncMetrics).
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
  style.textContent = `
    .nc-play-overlay { position:absolute; overflow:hidden; pointer-events:none; z-index:2; }
    .nc-play-mirror {
      position:absolute; top:0; left:-99999px; visibility:hidden;
      white-space:pre-wrap; overflow-wrap:break-word; word-wrap:break-word;
    }
    .nc-play-box {
      position:absolute; left:0; top:0; box-sizing:border-box;
      border:1.5px solid #1ff466; border-radius:3px;
      background:rgba(31,244,102,0.12);
      animation:nc-play-pulse 1.2s ease-in-out infinite;
    }
    @keyframes nc-play-pulse {
      0%,100% { box-shadow:0 0 5px rgba(31,244,102,0.35); }
      50%     { box-shadow:0 0 12px rgba(31,244,102,0.8); }
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

// Every participant token in the program with its source offset. Occurrences
// are kept (not deduped) so a token listed twice lights both spots.
function tokenPositions(text) {
  const { ast } = parseMetaprogram(text);
  const out = [];
  if (!ast.participants) return out;
  const walk = (els) => {
    for (const el of els) {
      if (el.token && el.line != null && el.col != null) {
        out.push({ token: el.token, offset: lineColToOffset(text, el.line, el.col), len: el.token.length });
      }
      if (el.type === 'sequence') el.stacks.forEach(s => walk(s.elements));
      if (el.type === 'choice') el.options.forEach(walk);
    }
  };
  ast.participants.stacks.forEach(s => walk(s.elements));
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
  host.append(overlay, mirror);

  const activeTokens = new Set();
  const timers = new Set();

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
  // top-left (i.e. before scrolling), via the mirror.
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
  function renderBoxes() {
    overlay.textContent = '';
    if (!activeTokens.size || !isNetCyclesActive()) return;
    const text = ta.value;
    syncMetrics();
    for (const p of tokenPositions(text)) {
      if (!activeTokens.has(p.token)) continue;
      const m = measureToken(text, p.offset, p.len);
      const box = document.createElement('div');
      box.className = 'nc-play-box';
      box.style.width = (m.width + PAD * 2) + 'px';
      box.style.height = (m.height + 2) + 'px';
      box.style.transform =
        `translate(${m.left - ta.scrollLeft - PAD}px, ${m.top - ta.scrollTop - 1}px)`;
      overlay.appendChild(box);
    }
  }

  // Slot events carry network time `t`; anchor the first one onto the wall
  // clock and schedule the rest relative to it (the scheduler emits within its
  // lookahead, so a plain delay tracks the audio gates).
  let refNet = null, refWall = null;
  const nowS = () => performance.now() / 1000;
  function relDelayMs(tNet) {
    if (refNet == null) { refNet = tNet; refWall = nowS(); }
    return Math.max(0, ((tNet - refNet) - (nowS() - refWall)) * 1000);
  }
  function schedule(fn, ms) {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
  }

  subscribeSlotEvents((ev) => {
    if (!isNetCyclesActive() || !ev.token) return;
    if (ev.type === 'slot-open') {
      schedule(() => { activeTokens.add(ev.token); renderBoxes(); }, relDelayMs(ev.t));
    } else if (ev.type === 'slot-close') {
      schedule(() => { activeTokens.delete(ev.token); renderBoxes(); }, relDelayMs(ev.t));
    }
  });

  // Keep the outline glued to the live text: edits, remote/roster program
  // changes, scrolling, and manual resize of the textarea.
  ta.addEventListener('input', renderBoxes);
  ta.addEventListener('scroll', renderBoxes);
  document.addEventListener('trussal-netcycles-program', renderBoxes);
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(renderBoxes).observe(ta);
  }

  document.addEventListener('trussal-netcycles-mode', (e) => {
    if (!e.detail || !e.detail.active) {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      activeTokens.clear();
      refNet = refWall = null;
      overlay.textContent = '';
    }
  });

  return overlay;
}

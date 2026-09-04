// panel-drag-resize.js
// Turns a floating fixed-position panel into a window: a drag handle to move it,
// four corner grips to resize it, and — when the MediaPipe head cursor is
// running — a ✥ / ⇲ pair that start head-cursor move / resize modes (dwell the
// button to grab, steer with your head, hold still ~1s to drop).
//
// The on-screen keyboard grew the mouse half of this first (see its
// _makeDraggable / _makeResizable). This module is that logic lifted out so
// Trussal Studio and the facial-control panel get the same window without
// three copies, and so the head-cursor variant lives in exactly one place.
//
// isHeadDragActive() is exported so the other head-cursor dwell loops
// (facial-gesture.js's _detectionLoop, on-screen-keyboard.js's _dwellTick) can
// pause their own dwell firing while a panel is being flown around — otherwise
// the same 1s hover that steers the panel also types a key / toggles a voice
// under it.

const STYLE_ID = 'trussal-panel-dr-style';
const HINT_ID  = 'trussal-panel-dr-hint';

const DEFAULT_MIN_W = 280;
const DEFAULT_MIN_H = 160;

// Head-cursor mode tuning.
const HEAD_RELEASE_MS   = 900;  // hold the cursor still this long to drop
const HEAD_STILL_RADIUS = 30;   // px; per-sample drift under this counts as "still"
const HEAD_COOLDOWN_MS  = 1600; // ignore a fresh ✥/⇲ dwell for this long after a drop

let _headMode       = null; // { panel, kind, lastX, lastY, stillX, stillY, stillSince, minW, minH }
let _headRaf        = null;
let _hintEl         = null;
let _cooldownUntil  = 0;

function _clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

/** True while the head cursor is steering (moving or resizing) a panel. */
export function isHeadDragActive() {
  return !!_headMode;
}

// Clear the CSS bottom/right anchors so an inline top/left is the ONLY
// constraint. A fixed element that honours both top and bottom (or both left
// and right) stretches instead of moving — the "dead space grows as you drag
// it up" bug the keyboard hit. 'auto' actually cancels the stylesheet value;
// '' only removes the inline one.
export function pinTopLeft(panel, rect) {
  panel.style.bottom = 'auto';
  panel.style.right  = 'auto';
  panel.style.top    = `${rect.top}px`;
  panel.style.left   = `${rect.left}px`;
}

function _injectStyles() {
  if (typeof document === 'undefined' || document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  // Authored against the per-user Personal Theme vars (src/theme-context.js):
  // --trussal-primary / --trussal-secondary / --trussal-font / --trussal-font-scale
  // on :root, each with its previous literal as the var() fallback, so these
  // shared drag/resize affordances retint with the rest of the app.
  s.textContent = `
    .tdr-grip {
      position: absolute; width: 18px; height: 18px; z-index: 20;
      background: transparent;
    }
    .tdr-grip-nw { top: 0;    left: 0;  cursor: nwse-resize; }
    .tdr-grip-ne { top: 0;    right: 0; cursor: nesw-resize; }
    .tdr-grip-sw { bottom: 0; left: 0;  cursor: nesw-resize; }
    .tdr-grip-se { bottom: 0; right: 0; cursor: nwse-resize; }
    /* Faint diagonal grip so the bottom-right corner reads as resizable. */
    .tdr-grip-se::after {
      content: ''; position: absolute; right: 3px; bottom: 3px;
      width: 8px; height: 8px;
      border-right: 2px solid color-mix(in srgb, var(--trussal-secondary, #111111) 45%, transparent);
      border-bottom: 2px solid color-mix(in srgb, var(--trussal-secondary, #111111) 45%, transparent);
    }
    /* Head-cursor move / resize buttons. They also carry .ts-dwell-btn so
       facial-gesture.js's dwell loop clicks them for free; these rules stand
       on their own so they still look right if that panel never opened. */
    .tdr-head-btn {
      background: var(--trussal-primary, #eeeeee);
      border: 1px solid var(--trussal-secondary, #111111);
      color: var(--trussal-secondary, #111111); cursor: pointer; border-radius: 4px;
      padding: 1px 6px; font-size: calc(11px * var(--trussal-font-scale, 1)); line-height: 1.5;
      font-family: var(--trussal-font, Arial, Helvetica, sans-serif); white-space: nowrap;
      /* Above the z-index:20 corner grips so a corner grip can't eat the
         button's clicks when it sits near a panel corner. */
      position: relative; z-index: 21; overflow: hidden;
      transition: background 0.1s, color 0.1s, border-color 0.1s;
    }
    .tdr-head-btn:hover { background: var(--trussal-secondary, #111111); color: var(--trussal-primary, #eeeeee); }
    .tdr-head-btn.on { border-color: var(--trussal-secondary, #111111); color: var(--trussal-primary, #eeeeee); background: var(--trussal-secondary, #111111); }
    .tdr-head-btn.strudel-dwell-hover { border-color: var(--trussal-secondary, #111111); }
    .tdr-head-btn.strudel-btn-active  { border-color: var(--trussal-secondary, #111111); background: var(--trussal-secondary, #111111); color: var(--trussal-primary, #eeeeee); }
    .tdr-head-btn::after {
      content: ''; position: absolute; bottom: 0; left: 0;
      width: 100%; height: calc(var(--dwell-prog, 0) * 100%);
      background: color-mix(in srgb, var(--trussal-secondary, #111111) 28%, transparent); pointer-events: none;
    }
    .tdr-head-target { outline: 2px solid var(--trussal-secondary, #111111); outline-offset: 2px; }
    #${HINT_ID} {
      position: fixed; z-index: 1000002; pointer-events: none;
      background: var(--trussal-primary, #eeeeee); color: var(--trussal-secondary, #111111);
      border: 1px solid var(--trussal-secondary, #111111); border-radius: 999px;
      font: 600 calc(11px * var(--trussal-font-scale, 1))/1.4 var(--trussal-font, Arial, Helvetica, sans-serif); padding: 3px 10px;
      box-shadow: 0 4px 16px rgba(0,0,0,0.2);
    }
  `;
  document.head.appendChild(s);
}

function _ensureGrips(panel) {
  if (panel.querySelector(':scope > .tdr-grip')) return;
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const g = document.createElement('div');
    g.className = `tdr-grip tdr-grip-${corner}`;
    panel.appendChild(g);
  }
}

// ── Mouse drag ────────────────────────────────────────────────────────────────
function _makeMouseDraggable(panel, handle) {
  if (!handle.style.cursor) handle.style.cursor = 'grab';
  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('button, select, input, textarea, a, .tdr-grip')) return;
    e.preventDefault();
    const rect = panel.getBoundingClientRect();
    const sx = e.clientX, sy = e.clientY;
    pinTopLeft(panel, rect);
    const ol = rect.left, ot = rect.top;
    const onMove = (ev) => {
      panel.style.left = `${ol + ev.clientX - sx}px`;
      panel.style.top  = `${ot + ev.clientY - sy}px`;
    };
    const onUp = () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

// ── Mouse resize (four corner grips) ──────────────────────────────────────────
// Each corner moves its own two edges and leaves the opposite corner fixed.
function _makeMouseResizable(panel, minW, minH) {
  panel.querySelectorAll(':scope > .tdr-grip').forEach((h) => {
    const west  = h.classList.contains('tdr-grip-nw') || h.classList.contains('tdr-grip-sw');
    const north = h.classList.contains('tdr-grip-nw') || h.classList.contains('tdr-grip-ne');
    h.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r  = panel.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY;
      pinTopLeft(panel, r);
      panel.style.width  = `${r.width}px`;
      panel.style.height = `${r.height}px`;
      const maxW = window.innerWidth  - 20;
      const maxH = window.innerHeight - 20;
      const onMove = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (west) {
          const w = Math.min(maxW, Math.max(minW, r.width - dx));
          panel.style.width = `${w}px`;
          panel.style.left  = `${r.left + (r.width - w)}px`;
        } else {
          panel.style.width = `${Math.min(maxW, Math.max(minW, r.width + dx))}px`;
        }
        if (north) {
          const ht = Math.min(maxH, Math.max(minH, r.height - dy));
          panel.style.height = `${ht}px`;
          panel.style.top    = `${r.top + (r.height - ht)}px`;
        } else {
          panel.style.height = `${Math.min(maxH, Math.max(minH, r.height + dy))}px`;
        }
      };
      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  });
}

// ── Head-cursor move / resize ─────────────────────────────────────────────────
function _headCursor() {
  const c = (typeof window !== 'undefined' && window.faceCtx) || null;
  if (!c) return null;
  return { x: c.cursorX, y: c.cursorY };
}

// Face lost / camera off parks the cursor dead-centre.
function _isParked(p) {
  return p.x === window.innerWidth / 2 && p.y === window.innerHeight / 2;
}

function _startHeadMode(panel, kind, minW, minH, forced) {
  _injectStyles();
  if (_headMode) _stopHeadMode();
  // A synthetic re-click from a dwell loop the instant after a drop would
  // re-grab the panel forever; a real (trusted) mouse click never waits.
  if (!forced && performance.now() < _cooldownUntil) return;

  // Nothing to steer with if the head cursor isn't live (Face off, or the face
  // is currently lost — the cursor parks dead-centre). A mouse user just uses
  // the drag handle / corner grips directly.
  const p = _headCursor();
  if (!p || _isParked(p)) return;

  const r = panel.getBoundingClientRect();
  pinTopLeft(panel, r);
  // An explicit box so resize has something concrete to grow from and move
  // doesn't fight a percentage width mid-drag.
  panel.style.width  = `${r.width}px`;
  panel.style.height = `${r.height}px`;
  // Absolute mapping from a rect captured ONCE — re-reading getBoundingClientRect
  // every frame and feeding width back in makes the panel creep (border-box vs
  // the content-box style.width we write), even with the head held still.
  _headMode = {
    panel, kind,
    originX: p.x, originY: p.y,
    startLeft: r.left, startTop: r.top, startW: r.width, startH: r.height,
    stillX: p.x, stillY: p.y, stillSince: performance.now(),
    minW: minW || DEFAULT_MIN_W, minH: minH || DEFAULT_MIN_H,
  };
  panel.classList.add('tdr-head-target');
  _markButton(panel, kind, true);
  _showHint(kind, p.x, p.y);
  if (!_headRaf) _headRaf = requestAnimationFrame(_headTick);
}

function _stopHeadMode() {
  if (!_headMode) return;
  _headMode.panel.classList.remove('tdr-head-target');
  _markButton(_headMode.panel, _headMode.kind, false);
  _headMode = null;
  _cooldownUntil = performance.now() + HEAD_COOLDOWN_MS;
  if (_headRaf) { cancelAnimationFrame(_headRaf); _headRaf = null; }
  _hideHint();
}

function _markButton(panel, kind, on) {
  const b = document.getElementById(`tdr-${kind}-${panel.id}`);
  if (b) b.classList.toggle('on', on);
}

function _headTick() {
  if (!_headMode) { _headRaf = null; return; }
  _headRaf = requestAnimationFrame(_headTick);

  const p = _headCursor();
  if (!p) return;
  // Face lost / camera off parks the cursor dead-centre — freeze rather than
  // fling the panel to the middle of the screen.
  if (_isParked(p)) return;

  const m = _headMode;
  const panel = m.panel;
  const totalX = p.x - m.originX;
  const totalY = p.y - m.originY;

  if (m.kind === 'move') {
    const maxLeft = window.innerWidth  - 48;
    const maxTop  = window.innerHeight - 40;
    panel.style.left = `${_clamp(m.startLeft + totalX, 48 - m.startW, maxLeft)}px`;
    panel.style.top  = `${_clamp(m.startTop  + totalY, 0, maxTop)}px`;
  } else {
    // Bottom-right corner tracks the head; top-left stays pinned.
    const maxW = Math.max(m.minW, window.innerWidth  - m.startLeft - 10);
    const maxH = Math.max(m.minH, window.innerHeight - m.startTop  - 10);
    panel.style.width  = `${_clamp(m.startW + totalX, m.minW, maxW)}px`;
    panel.style.height = `${_clamp(m.startH + totalY, m.minH, maxH)}px`;
  }

  // Hold the head still to release. The cursor EMA is smooth enough that a
  // genuine "stop" collapses drift to a few px; a real move blows past the
  // radius and re-arms the timer.
  const now = performance.now();
  if (Math.hypot(p.x - m.stillX, p.y - m.stillY) > HEAD_STILL_RADIUS) {
    m.stillX = p.x; m.stillY = p.y; m.stillSince = now;
  } else if (now - m.stillSince > HEAD_RELEASE_MS) {
    _stopHeadMode();
    return;
  }
  _moveHint(p.x, p.y);
}

function _showHint(kind, x, y) {
  _hideHint();
  _hintEl = document.createElement('div');
  _hintEl.id = HINT_ID;
  _hintEl.textContent = kind === 'move'
    ? '✥ steering — hold still to drop'
    : '⇲ resizing — hold still to set';
  document.body.appendChild(_hintEl);
  _moveHint(x, y);
}
function _moveHint(x, y) {
  if (!_hintEl) return;
  _hintEl.style.left = `${_clamp(x + 18, 4, window.innerWidth  - 220)}px`;
  _hintEl.style.top  = `${_clamp(y + 18, 4, window.innerHeight -  28)}px`;
}
function _hideHint() {
  if (_hintEl) { _hintEl.remove(); _hintEl = null; }
}

function _makeHeadButtons(panel, host, minW, minH) {
  if (!panel.id) panel.id = `tdr-panel-${Math.random().toString(36).slice(2, 8)}`;
  if (host.querySelector('.tdr-head-btn')) return;

  const mk = (kind, glyph, label) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tdr-head-btn ts-dwell-btn';
    b.id = `tdr-${kind}-${panel.id}`;
    b.textContent = glyph;
    b.title = label;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (_headMode && _headMode.panel === panel && _headMode.kind === kind) _stopHeadMode();
      else _startHeadMode(panel, kind, minW, minH, e.isTrusted === true);
    });
    return b;
  };

  const moveBtn   = mk('move',   '✥', 'Head-cursor move — dwell to grab, hold still to drop');
  const resizeBtn = mk('resize', '⇲', 'Head-cursor resize — dwell to grab, hold still to set');

  const anchor = host.querySelector(
    '#trussal-studio-collapse, .ts-collapse-btn, .ts-kbd-collapse-btn, #trussal-fg-collapse, .ts-close'
  );
  if (anchor && anchor.parentElement === host) {
    host.insertBefore(moveBtn, anchor);
    host.insertBefore(resizeBtn, anchor);
  } else {
    host.appendChild(moveBtn);
    host.appendChild(resizeBtn);
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Mouse drag (on `handle`) + four corner resize grips. */
export function attachMouseDragResize(panel, opts = {}) {
  if (typeof document === 'undefined' || !panel) return;
  _injectStyles();
  _ensureGrips(panel);
  _makeMouseDraggable(panel, opts.handle || panel);
  _makeMouseResizable(panel, opts.minW || DEFAULT_MIN_W, opts.minH || DEFAULT_MIN_H);
}

/** The ✥ / ⇲ head-cursor buttons in `handle` (or `headButtonHost`). */
export function attachHeadDragResize(panel, opts = {}) {
  if (typeof document === 'undefined' || !panel) return;
  _injectStyles();
  _makeHeadButtons(
    panel,
    opts.headButtonHost || opts.handle || panel,
    opts.minW || DEFAULT_MIN_W,
    opts.minH || DEFAULT_MIN_H
  );
}

/** Everything: mouse drag + mouse resize + head-cursor move/resize. */
export function attachPanelControls(panel, opts = {}) {
  attachMouseDragResize(panel, opts);
  attachHeadDragResize(panel, opts);
}

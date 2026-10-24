// on-screen-keyboard.js
// On-screen QWERTY keyboard with head-cursor dwell, drag, collapse, and word
// autocomplete ("autopredict"). It types into whichever Trussal Studio code
// editor was last focused — the personal Strudel textarea or the shared
// JPattern metaprogram editor — and its Eval key routes the same way
// studio.js's own eval does. Outside a meeting, where the Studio toolbar
// doesn't exist, it targets the two
// Jitsi-native name fields instead: the prejoin screen's display-name input
// and the lobby knock screen's name field (Eval is a no-op on those — see
// _isTypingTarget / PREJOIN_NAME_ID / LOBBY_NAME_ID).
//
// The autopredict row is a head-cursor affordance: its chips are dwell
// targets, so it only appears while the MediaPipe head cursor (the Face
// toggle) is on — see isHeadCursorEnabled() in _updatePredictions().
//
// The toggle lives in the Trussal Studio toolbar group (injectKeyboardToggle),
// next to the Face button. The panel itself stays a body-level fixed element
// so it can be dragged anywhere and span the full width; tickKbdUi() retracts
// it when the meeting ends, but it is no longer tied to any one Studio window.

import { wordPrefixAt, predictCompletions } from './on-screen-keyboard-core.js';
import { isHeadCursorEnabled, setHeadCursorEnabled, setGestureDetectionEnabled } from './facial-gesture.js';
import {
  attachHeadDragResize, isHeadDragActive, setPanelBox, pinTopLeft as _pinTopLeft,
} from './panel-drag-resize.js';

export { pinTopLeft as _pinTopLeft } from './panel-drag-resize.js';

const KBD_PANEL_ID  = 'trussal-kbd-panel';
const KBD_TOGGLE_ID = 'trussal-kbd-toggle';
const DWELL_MS      = 1000;

// The single-line fields that live outside a meeting — Trussal's own welcome
// overlay room-name box, the prejoin display-name input and the lobby knock
// name field — are the other typing targets the on-screen keyboard has to
// reach. They're why Landmark and Gesture Mode holds the keyboard open
// standalone on those screens (see setKeyboardStandalone below); without this
// a performer with no physical keyboard could open the panel there but nothing
// they pressed would land anywhere.
const WELCOME_ROOM_ID = 'trussal-room-input';
const PREJOIN_NAME_ID = 'premeeting-name-input';
const LOBBY_NAME_ID   = 'lobby-name-field';
const NATIVE_FIELD_IDS = [WELCOME_ROOM_ID, PREJOIN_NAME_ID, LOBBY_NAME_ID];

function _isTypingTarget(el) {
  return !!el && (
    (el.classList && el.classList.contains('ts-code')) ||
    NATIVE_FIELD_IDS.includes(el.id)
  );
}

// The prejoin and lobby name fields are React-controlled: assigning `.value`
// directly and firing `input` does nothing, because React's value tracker
// already recorded the new string via its own setter override and so sees no
// change to forward to onChange — React then reverts the DOM on its next
// render and the Join button never enables. Writing through the native
// prototype setter leaves the tracker stale, so the `input` event registers
// as a real change. Trussal's own welcome overlay input is a plain uncontrolled
// field, where this is simply equivalent to `el.value = v`.
function _setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value);
  else el.value = value;
}

// ── Layout (total = 14.5 flex-units per row) ────────────────────────────────────
const ROWS = [
  [
    {l:'`',k:'`',s:'~'},{l:'1',k:'1',s:'!'},{l:'2',k:'2',s:'@'},{l:'3',k:'3',s:'#'},
    {l:'4',k:'4',s:'$'},{l:'5',k:'5',s:'%'},{l:'6',k:'6',s:'^'},{l:'7',k:'7',s:'&'},
    {l:'8',k:'8',s:'*'},{l:'9',k:'9',s:'('},{l:'0',k:'0',s:')'},{l:'-',k:'-',s:'_'},
    {l:'=',k:'=',s:'+'},
    {l:'⌫',k:'Backspace',w:1.5},
  ],
  [
    {l:'⇥',k:'Tab',w:1.5},
    {l:'q',k:'q',s:'Q'},{l:'w',k:'w',s:'W'},{l:'e',k:'e',s:'E'},{l:'r',k:'r',s:'R'},
    {l:'t',k:'t',s:'T'},{l:'y',k:'y',s:'Y'},{l:'u',k:'u',s:'U'},{l:'i',k:'i',s:'I'},
    {l:'o',k:'o',s:'O'},{l:'p',k:'p',s:'P'},{l:'[',k:'[',s:'{'},{l:']',k:']',s:'}'},
    {l:'\\',k:'\\',s:'|'},
  ],
  [
    {l:'⇪',k:'CapsLock',w:1.5},
    {l:'a',k:'a',s:'A'},{l:'s',k:'s',s:'S'},{l:'d',k:'d',s:'D'},{l:'f',k:'f',s:'F'},
    {l:'g',k:'g',s:'G'},{l:'h',k:'h',s:'H'},{l:'j',k:'j',s:'J'},{l:'k',k:'k',s:'K'},
    {l:'l',k:'l',s:'L'},{l:';',k:';',s:':'},{l:"'",k:"'",s:'"'},
    {l:'↵',k:'Enter',w:2},
  ],
  [
    {l:'⇧',k:'ShiftLeft',w:2.25},
    {l:'z',k:'z',s:'Z'},{l:'x',k:'x',s:'X'},{l:'c',k:'c',s:'C'},{l:'v',k:'v',s:'V'},
    {l:'b',k:'b',s:'B'},{l:'n',k:'n',s:'N'},{l:'m',k:'m',s:'M'},{l:',',k:',',s:'<'},
    {l:'.',k:'.',s:'>'},{l:'/',k:'/',s:'?'},
    {l:'⇧',k:'ShiftRight',w:2.25},
  ],
  [
    {l:'←',k:'ArrowLeft',w:1.5},{l:'↑',k:'ArrowUp',w:1.5},{l:'↓',k:'ArrowDown',w:1.5}, {l:'→',k:'ArrowRight',w:1.5},
    {l:'space',k:' ',w:6.5}, {l:'↵eval',k:'Eval',w:2},
  ],
];

// ── State ──────────────────────────────────────────────────────────────────────
let _shift        = false;
let _caps         = false;
let _visible      = false;
// Standalone = the keyboard is held open by Landmark and Gesture Mode rather
// than by the Studio toolbar's Keys button, so it stays up on the welcome page
// and prejoin screen too and tickKbdUi() must not retract it.
let _standalone   = false;
let _collapsed    = false;
let _lastTA       = null;
let _dwellEl      = null;
let _dwellStart   = 0;
let _dwellFired   = false;
let _rafId        = null;
let _activityBound = false;

// Latch the editor the user last touched so on-screen keys and completions
// target it. Detached nodes (a peer switch rebuilds the detail panel) are
// rejected in _getTA(), so this can safely hold whatever was focused last.
document.addEventListener('focusin', (e) => {
  if (_isTypingTarget(e.target)) {
    _lastTA = e.target;
    _updatePredictions();
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────────
export function _esc(s) {
  return String(s).replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

function _getTA() {
  // A stale _lastTA is the classic autopredict failure: switching the selected
  // participant rebuilds the detail panel, so the textarea it pointed at is
  // now detached — reads see empty/old text and writes land nowhere. Drop it
  // the moment it leaves the document and fall back to the live personal
  // editor. :not(.jp-code) — the shared JPattern textarea is also a .ts-code.
  if (_lastTA && _lastTA.isConnected) return _lastTA;
  _lastTA = null;
  return document.querySelector('.ts-window[data-window="personal"] .ts-detail .ts-code:not(.jp-code)')
      || document.querySelector('.ts-window[data-window="personal"] .ts-code:not(.jp-code)')
      // The personal window only mounts after its toolbar button is clicked,
      // and the toolbar only mounts in a meeting — exactly when none of these
      // single-line fields exists, so never a Studio editor and one of these
      // at once.
      || document.getElementById(WELCOME_ROOM_ID)
      || document.getElementById(PREJOIN_NAME_ID)
      || document.getElementById(LOBBY_NAME_ID);
}

// ── Predictions ────────────────────────────────────────────────────────────────
function _updatePredictions() {
  const row = document.querySelector(`#${KBD_PANEL_ID} .ts-kbd-pred-row`);
  if (!row || !_visible) return;
  const ta = _getTA();
  // Autopredict is Strudel-keyword completion — meaningless over a plain name
  // field, so it only ever considers a real .ts-code editor. It's also a
  // head-cursor affordance: a suggestion is chosen by dwelling on its chip,
  // so the row only earns its space above the keys while the MediaPipe head
  // cursor is on.
  if (!ta || !ta.classList?.contains('ts-code') || !isHeadCursorEnabled()) {
    row.classList.remove('ts-kbd-pred-on');
    if (row.childElementCount) row.innerHTML = '';
    return;
  }
  const text  = ta.value;
  const caret = ta.selectionStart ?? text.length;
  const preds = predictCompletions(text, caret);
  // Hide the row entirely when there is nothing to suggest — an always-present
  // empty strip below the title bar is the "rectangle that does nothing".
  if (!preds.length) {
    row.classList.remove('ts-kbd-pred-on');
    if (row.childElementCount) row.innerHTML = '';
    return;
  }
  row.innerHTML = preds.map(p =>
    `<button class="ts-kbd-pred-btn" data-completion="${_esc(p)}">${_esc(p)}</button>`
  ).join('');
  row.querySelectorAll('.ts-kbd-pred-btn').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => _insertCompletion(btn.dataset.completion));
  });
  row.classList.add('ts-kbd-pred-on');
}

function _insertCompletion(word) {
  const ta = _getTA();
  if (!ta) return;
  const pos    = ta.selectionStart ?? ta.value.length;
  const prefix = wordPrefixAt(ta.value, pos);
  const start  = pos - prefix.length;
  _setNativeValue(ta, ta.value.slice(0, start) + word + ta.value.slice(pos));
  ta.setSelectionRange(start + word.length, start + word.length);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  _updatePredictions();
}

// Refresh predictions on ordinary typing too — physically at the keyboard, an
// arrow key moving the caret, or a click repositioning it. Without this the
// row only ever updated when a key was pressed ON the on-screen keyboard,
// which read as "autopredict isn't happening" for anyone typing normally.
function _bindEditorActivity() {
  if (_activityBound) return;
  _activityBound = true;
  const refresh = (e) => {
    if (!_visible) return;
    const t = e.target;
    if (_isTypingTarget(t)) { _lastTA = t; _updatePredictions(); }
  };
  document.addEventListener('input', refresh, true);
  document.addEventListener('keyup', refresh, true);
  document.addEventListener('selectionchange', () => {
    if (!_visible) return;
    const a = document.activeElement;
    if (_isTypingTarget(a)) { _lastTA = a; _updatePredictions(); }
  });
}

// ── Modifier display ────────────────────────────────────────────────────────────
function _renderModState() {
  const panel = document.getElementById(KBD_PANEL_ID);
  if (!panel) return;
  const upper = _shift || _caps;
  panel.querySelectorAll('.ts-kbd-key[data-lower]').forEach(el => {
    el.querySelector('.ts-kbd-label').textContent =
      upper ? el.dataset.shiftedLabel : el.dataset.lower;
  });
  panel.querySelectorAll('.ts-kbd-key[data-k="ShiftLeft"],.ts-kbd-key[data-k="ShiftRight"]').forEach(el => {
    el.classList.toggle('ts-kbd-mod-on', _shift);
  });
  panel.querySelectorAll('.ts-kbd-key[data-k="CapsLock"]').forEach(el => {
    el.classList.toggle('ts-kbd-mod-on', _caps);
  });
}

// ── Typing ─────────────────────────────────────────────────────────────────────
function _activateKeyDef(kd) {
  const upper = _shift || _caps;
  _typeKey((upper && kd.s) ? kd.s : kd.k);
}

function _typeKey(key) {
  if (key === 'CapsLock') { _caps = !_caps; _renderModState(); return; }
  if (key === 'ShiftLeft' || key === 'ShiftRight') { _shift = !_shift; _renderModState(); return; }

  if (key === 'Eval') {
    const ta = _getTA();
    // Eval routes by editor: the shared JPattern textarea (.jp-code — it also
    // carries .ts-code) applies the metaprogram; the personal editor evals
    // Strudel. studio.js handles the dispatch either way, keyed on the
    // 'jpattern' kind — the same name classifyEditor() uses, so every input
    // modality agrees on one vocabulary. Not a real editor (e.g. the
    // prejoin/lobby name field) → nothing to run; studio.js's listener would
    // otherwise try to eval whatever name the performer just typed as a
    // Strudel pattern.
    if (!ta || !ta.classList?.contains('ts-code')) return;
    document.dispatchEvent(new CustomEvent('trussal-kbd-eval', {
      detail: {
        code: ta.value,
        editor: ta.classList.contains('jp-code') ? 'jpattern' : 'strudel'
      }
    }));
    return;
  }

  const ta = _getTA();
  if (!ta) return;

  const s   = ta.selectionStart ?? ta.value.length;
  const e   = ta.selectionEnd   ?? ta.value.length;
  const val = ta.value;

  const isTextarea = ta.tagName === 'TEXTAREA';

  if (key === 'Backspace') {
    if (s !== e) {
      _setNativeValue(ta, val.slice(0, s) + val.slice(e));
      ta.setSelectionRange(s, s);
    } else if (s > 0) {
      _setNativeValue(ta, val.slice(0, s - 1) + val.slice(s));
      ta.setSelectionRange(s - 1, s - 1);
    }
  } else if (key === 'Enter') {
    if (isTextarea) {
      _setNativeValue(ta, val.slice(0, s) + '\n' + val.slice(e));
      ta.setSelectionRange(s + 1, s + 1);
    } else {
      // A single-line field (welcome room name, prejoin / lobby name) takes
      // no newline. Mimic a physical Enter so the screen's own submit-on-Enter
      // handler runs — that's the hands-free performer's way off this screen.
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      for (const type of ['keydown', 'keypress', 'keyup']) {
        ta.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
        }));
      }
      if (ta.form && typeof ta.form.requestSubmit === 'function') {
        try { ta.form.requestSubmit(); } catch { ta.form.submit(); }
      }
      _updatePredictions();
      return;
    }
  } else if (key === 'Tab') {
    if (isTextarea) {
      _setNativeValue(ta, val.slice(0, s) + '  ' + val.slice(e));
      ta.setSelectionRange(s + 2, s + 2);
    }
  } else if (key === 'ArrowLeft') {
    const p = Math.max(0, s - 1); ta.setSelectionRange(p, p);
  } else if (key === 'ArrowRight') {
    const p = Math.min(val.length, e + 1); ta.setSelectionRange(p, p);
  } else if (key === 'ArrowUp' || key === 'ArrowDown') {
    if (isTextarea) _moveLine(ta, key === 'ArrowUp' ? -1 : 1);
  } else if (key.length === 1) {
    _setNativeValue(ta, val.slice(0, s) + key + val.slice(e));
    ta.setSelectionRange(s + 1, s + 1);
    if (_shift) { _shift = false; _renderModState(); }
  }

  ta.dispatchEvent(new Event('input', { bubbles: true }));
  _updatePredictions();
}

function _moveLine(ta, dir) {
  const val       = ta.value;
  const pos       = ta.selectionStart ?? val.length;
  const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
  const col       = pos - lineStart;
  if (dir === -1) {
    if (lineStart === 0) return;
    const prevEnd   = lineStart - 1;
    const prevStart = val.lastIndexOf('\n', prevEnd - 1) + 1;
    ta.setSelectionRange(prevStart + Math.min(col, prevEnd - prevStart),
                         prevStart + Math.min(col, prevEnd - prevStart));
  } else {
    const lineEnd = val.indexOf('\n', pos);
    if (lineEnd === -1) return;
    const nextStart = lineEnd + 1;
    const nextEnd   = val.indexOf('\n', nextStart);
    const nextLen   = (nextEnd === -1 ? val.length : nextEnd) - nextStart;
    ta.setSelectionRange(nextStart + Math.min(col, nextLen),
                         nextStart + Math.min(col, nextLen));
  }
}

// ── Close (✕) ────────────────────────────────────────────────────────────────
// Closing the keyboard with the ✕ — never by collapsing it — takes the rest of
// Landmark and Gesture Mode with it: the MediaPipe head cursor, gesture actions
// and the mode flag itself, so no cursor is left drifting after the window
// closes. Hiding stops this panel's own dwell loop via _showPanel; dropping the
// standalone hold keeps Landmark and Gesture Mode from re-raising the panel
// under it (tickKbdUi). Everything stays down until the performer retriggers the
// mode — hold one eye shut for 2s (the camera keeps running watch-only), press
// →, click the Face button, or call gestureAndLandmarkConfig.
function _closeKeyboard() {
  _standalone = false;
  _showPanel(false);
  // The event flips the mode off through landmark-gesture-mode's shared handler
  // so its bookkeeping stays in step; the direct calls guarantee the cursor and
  // gesture actions are gone even if that flag had drifted out of sync.
  setHeadCursorEnabled(false);
  setGestureDetectionEnabled(false);
  try {
    document.dispatchEvent(new CustomEvent('trussal-landmark-gesture-mode', {
      detail: { on: false, source: 'keyboard-close' },
    }));
  } catch (e) { /* document not ready — cursor and gestures are already off */ }
}

// ── Collapse ───────────────────────────────────────────────────────────────────
function _setCollapsed(val) {
  _collapsed = val;
  const panel = document.getElementById(KBD_PANEL_ID);
  if (!panel) return;
  const btn  = panel.querySelector('.ts-kbd-collapse-btn');
  // The collapsed look is entirely CSS (.ts-kbd-collapsed hides the body and
  // drops the height back to auto, which also takes a resized window's
  // --tdr-h out of the picture; the property survives for the expand back).
  panel.classList.toggle('ts-kbd-collapsed', val);
  if (btn) btn.textContent = val ? '▲' : '▼';
}

const MIN_W = 320;
const MIN_H = 170;

// ── Drag ───────────────────────────────────────────────────────────────────────
// Pin the panel to a top/left box. _pinTopLeft clears the CSS bottom/right
// anchors (--tdr-bottom/--tdr-right: auto) so a moved top/left is the ONLY
// constraint — a fixed element that honours both top and bottom stretches
// vertically, the "dead space grows as you drag it up" bug (see
// panel-drag-resize.js).
function _makeDraggable(panel, handle) {
  handle.classList.add('tdr-draggable');
  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('button, .ts-kbd-resize')) return;
    e.preventDefault();
    handle.classList.add('tdr-dragging');
    const rect   = panel.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    _pinTopLeft(panel, rect);
    const origL = rect.left;
    const origT = rect.top;
    function onMove(ev) {
      setPanelBox(panel, { left: origL + ev.clientX - startX, top: origT + ev.clientY - startY });
    }
    function onUp() {
      handle.classList.remove('tdr-dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

// ── Resize (four corner handles) ───────────────────────────────────────────────
// Each corner moves its own two edges and leaves the opposite corner fixed.
// The body/rows are flex:1, so a taller panel means taller keys, not padding.
function _makeResizable(panel) {
  panel.querySelectorAll('.ts-kbd-resize').forEach((h) => {
    const west  = h.classList.contains('ts-kbd-resize-nw') || h.classList.contains('ts-kbd-resize-sw');
    const north = h.classList.contains('ts-kbd-resize-nw') || h.classList.contains('ts-kbd-resize-ne');
    h.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r  = panel.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY;
      _pinTopLeft(panel, r);
      setPanelBox(panel, { width: r.width, height: r.height });
      const maxW = window.innerWidth  - 20;
      const maxH = window.innerHeight - 20;
      function onMove(ev) {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (west) {
          const w = Math.min(maxW, Math.max(MIN_W, r.width - dx));
          setPanelBox(panel, { width: w, left: r.left + (r.width - w) });
        } else {
          setPanelBox(panel, { width: Math.min(maxW, Math.max(MIN_W, r.width + dx)) });
        }
        if (north) {
          const ht = Math.min(maxH, Math.max(MIN_H, r.height - dy));
          setPanelBox(panel, { height: ht, top: r.top + (r.height - ht) });
        } else {
          setPanelBox(panel, { height: Math.min(maxH, Math.max(MIN_H, r.height + dy)) });
        }
      }
      function onUp() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  });
}

// ── DOM construction ───────────────────────────────────────────────────────────

function _buildPanel() {
  const panel = document.createElement('div');
  panel.id = KBD_PANEL_ID;

  // ── Header (drag handle + collapse button) ──
  const header = document.createElement('div');
  header.className = 'ts-kbd-header';

  const title = document.createElement('span');
  title.className = 'ts-kbd-title';
  title.textContent = 'keyboard';

  const collapseBtn = document.createElement('button');
  collapseBtn.className = 'ts-kbd-collapse-btn';
  collapseBtn.type      = 'button';
  collapseBtn.title     = 'Collapse / expand keyboard';
  collapseBtn.textContent = '▼';
  collapseBtn.addEventListener('mousedown', e => e.preventDefault());
  collapseBtn.addEventListener('click', () => _setCollapsed(!_collapsed));

  header.appendChild(title);
  header.appendChild(collapseBtn);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'ts-kbd-close-btn';
  closeBtn.type      = 'button';
  closeBtn.title     = 'Close keyboard';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('mousedown', e => e.preventDefault());
  closeBtn.addEventListener('click', _closeKeyboard);
  header.appendChild(closeBtn);

  panel.appendChild(header);

  // ── Body (predictions + key rows) ──
  const body = document.createElement('div');
  body.className = 'ts-kbd-body';

  const predRow = document.createElement('div');
  predRow.className = 'ts-kbd-pred-row';
  body.appendChild(predRow);

  ROWS.forEach((row, ri) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'ts-kbd-row';
    row.forEach((kd, ki) => {
      const btn = document.createElement('button');
      btn.className    = 'ts-kbd-key';
      btn.type         = 'button';
      btn.dataset.k    = kd.k;
      btn.dataset.row  = ri;
      btn.dataset.key  = ki;
      // Width in flex units; the stylesheet reads --tsk-flex (see the .ts-kbd-key
      // rule) so no element styles are written here.
      if (kd.w) btn.style.setProperty('--tsk-flex', String(kd.w));
      if (kd.s) {
        btn.dataset.lower        = kd.l;
        btn.dataset.shiftedLabel = kd.s;
      }
      const label = document.createElement('span');
      label.className   = 'ts-kbd-label';
      label.textContent = kd.l;
      btn.appendChild(label);
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', () => { _activateKeyDef(kd); _flash(btn); });
      rowEl.appendChild(btn);
    });
    body.appendChild(rowEl);
  });

  panel.appendChild(body);

  // ── Corner resize handles ──
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const grip = document.createElement('div');
    grip.className = `ts-kbd-resize ts-kbd-resize-${corner}`;
    panel.appendChild(grip);
  }

  document.body.appendChild(panel);
  _makeDraggable(panel, header);
  _makeResizable(panel);
  // Head-cursor move/resize: ✥ / ⇲ buttons in the header, same as Studio and
  // the facial-control panel. Mouse drag/resize above stays as it was.
  attachHeadDragResize(panel, { handle: header, minW: MIN_W, minH: MIN_H });
}

function _flash(el) {
  el.classList.add('ts-kbd-flash');
  setTimeout(() => el.classList.remove('ts-kbd-flash'), 150);
}

function _ensureDOM() {
  if (document.getElementById(KBD_PANEL_ID)) return;
  _buildPanel();
  _bindEditorActivity();
}

// ── Dwell loop (head-cursor) ────────────────────────────────────────────────────
function _startDwellLoop() {
  if (_rafId) return;
  _rafId = requestAnimationFrame(_dwellTick);
}

function _stopDwellLoop() {
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  if (_dwellEl) {
    _dwellEl.style.setProperty('--dwell', '0');
    _dwellEl.classList.remove('ts-kbd-dwelling');
    _dwellEl = null;
  }
}

function _dwellTick() {
  if (!_visible) { _rafId = null; return; }
  _rafId = requestAnimationFrame(_dwellTick);

  // While the head cursor is dragging/resizing a panel (this one included),
  // don't also let a dwell land on a key under it. Drop any partial dwell so
  // it can't fire the instant the panel is released.
  if (isHeadDragActive()) {
    if (_dwellEl) {
      _dwellEl.style.setProperty('--dwell', '0');
      _dwellEl.classList.remove('ts-kbd-dwelling');
      _dwellEl = null;
    }
    return;
  }

  const ctx = window.faceCtx;
  if (!ctx || (ctx.cursorX === window.innerWidth / 2 && ctx.cursorY === window.innerHeight / 2)) return;

  const panel = document.getElementById(KBD_PANEL_ID);
  if (!panel || !panel.classList.contains('ts-kbd-on')) return;

  const cx = ctx.cursorX;
  const cy = ctx.cursorY;
  let hoveredEl = null;

  // Detect over keys, predictions, and the collapse button.
  for (const el of panel.querySelectorAll('.ts-kbd-key, .ts-kbd-pred-btn, .ts-kbd-collapse-btn, .ts-kbd-close-btn')) {
    const r = el.getBoundingClientRect();
    if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
      hoveredEl = el; break;
    }
  }

  const now = performance.now();
  if (hoveredEl !== _dwellEl) {
    if (_dwellEl) {
      _dwellEl.style.setProperty('--dwell', '0');
      _dwellEl.classList.remove('ts-kbd-dwelling');
    }
    _dwellEl    = hoveredEl;
    _dwellStart = hoveredEl ? now : 0;
    _dwellFired = false;
  }

  if (hoveredEl && !_dwellFired) {
    const p = Math.min((now - _dwellStart) / DWELL_MS, 1);
    hoveredEl.style.setProperty('--dwell', p.toFixed(3));
    hoveredEl.classList.toggle('ts-kbd-dwelling', p > 0.05);
    if (p >= 1) {
      _dwellFired = true;
      hoveredEl.style.setProperty('--dwell', '0');
      hoveredEl.classList.remove('ts-kbd-dwelling');
      _activateDwelled(hoveredEl);
    }
  }
}

function _activateDwelled(el) {
  _flash(el);
  if (el.classList.contains('ts-kbd-collapse-btn')) {
    _setCollapsed(!_collapsed);
    return;
  }
  if (el.classList.contains('ts-kbd-close-btn')) {
    _closeKeyboard();
    return;
  }
  if (el.classList.contains('ts-kbd-pred-btn')) {
    _insertCompletion(el.dataset.completion);
    return;
  }
  const ri = parseInt(el.dataset.row);
  const ki = parseInt(el.dataset.key);
  if (!isNaN(ri) && !isNaN(ki)) _activateKeyDef(ROWS[ri][ki]);
}

// ── Meeting visibility ──────────────────────────────────────────────────────────
function _inMeeting() {
  if (document.getElementById('trussal-welcome-overlay')) return false;
  if (document.querySelector('.prejoin-screen,.premeeting-screen,[class*="premeeting"],[class*="prejoin"]')) return false;
  const lv = document.getElementById('largeVideoContainer');
  if (!lv) return false;
  const r = lv.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function _showPanel(on) {
  _visible = on;
  const panel = document.getElementById(KBD_PANEL_ID);
  if (panel) panel.classList.toggle('ts-kbd-on', on);
  const toggle = document.getElementById(KBD_TOGGLE_ID);
  if (toggle) toggle.classList.toggle('on', on);
  if (on) { _startDwellLoop(); _updatePredictions(); }
  else    { _stopDwellLoop(); }
}

/**
 * Inject the Keys toggle into the Trussal Studio toolbar group. Called from
 * studio.js ensureToolbar(), which passes the #trussal-studio-inputs host
 * beside the window buttons. The button carries .ts-dwell-btn so
 * facial-gesture.js's head-cursor dwell loop clicks it for free, exactly like
 * the Face and collapse buttons beside it.
 */
export function injectKeyboardToggle(headerEl) {
  if (!headerEl || document.getElementById(KBD_TOGGLE_ID)) return;
  const btn = document.createElement('button');
  btn.id    = KBD_TOGGLE_ID;
  btn.type  = 'button';
  btn.className = 'ts-dwell-btn';
  btn.title = 'Toggle the on-screen keyboard';
  btn.textContent = 'Keys';
  btn.addEventListener('mousedown', e => e.preventDefault());
  btn.addEventListener('click', () => {
    try { _ensureDOM(); } catch (e) { console.error('[on-screen-keyboard] panel init failed', e); return; }
    _showPanel(!_visible);
  });
  const closeBtn = headerEl.querySelector('.ts-close');
  if (closeBtn) headerEl.insertBefore(btn, closeBtn);
  else headerEl.appendChild(btn);
}

/**
 * Whether the keyboard is currently held open by Landmark and Gesture Mode
 * (as opposed to the toolbar's Keys button). gestureAndLandmarkConfig reports
 * this back as `virtualKeyboardEnabled`.
 */
export function isKeyboardStandalone() { return _standalone; }

/**
 * Landmark and Gesture Mode calls this to show/hide the keyboard independently
 * of any Studio window — so it is available on the welcome page and prejoin
 * screen, not just in a meeting with a Studio window open.
 */
export function setKeyboardStandalone(on) {
  _standalone = !!on;
  if (_standalone) {
    try { _ensureDOM(); } catch (e) { console.error('[on-screen-keyboard] panel init failed', e); return; }
    _showPanel(true);
  } else {
    // Let the toolbar's Keys button own visibility again; tickKbdUi() keeps
    // the panel up in a meeting but still retracts it when the room ends.
    tickKbdUi();
  }
}

/**
 * Housekeeping tick from studio.js's tickUi(). The toggle lives in the Studio
 * toolbar and comes and goes with it; this only has to retract the body-level
 * panel when the meeting ends — unless Landmark and Gesture Mode is holding it
 * open (standalone).
 */
export function tickKbdUi() {
  if (_standalone) {
    if (!_visible) {
      try { _ensureDOM(); } catch (e) { console.error('[on-screen-keyboard] panel init failed', e); return; }
      _showPanel(true);
    }
    _updatePredictions();
    return;
  }
  if (!_visible) return;
  if (!_inMeeting()) { _showPanel(false); return; }
  // Reflect a head-cursor toggle on the autopredict row without waiting for
  // the next editor keystroke to call _updatePredictions().
  _updatePredictions();
}

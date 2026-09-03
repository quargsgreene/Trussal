// landmark-gesture-mode.js
// "Landmark and Gesture Mode" — the one switch that turns on the on-screen
// keyboard, the MediaPipe head cursor, and face-gesture control together, and
// the three ways to reach it from ANY Trussal screen (welcome page, prejoin,
// lobby knock, meeting):
//
//   • press → (Right Arrow)
//   • tick "Landmark and Gesture Mode" in the ☰ menu, top-left
//   • hold one eye shut for two seconds
//
// The third is why MediaPipe starts the moment the bundle loads: facial-gesture
// runs a camera-backed watcher with every gesture action OFF except
// `enable-landmark-gesture-mode`, so before you opt in the only thing it can do
// is notice the one-eye-held-shut gesture and flip this switch. The gesture is a
// normal entry in the map and can be re-pointed from code.
//
// gestureAndLandmarkConfig({ gestureMappings, virtualKeyboardEnabled,
// headCursorEnabled, gestureDetectionEnabled }) is the code-side control:
// facial-gesture.js owns the gesture map + detection, on-screen-keyboard.js
// owns the keyboard, and this module wires a config object onto both and keeps
// the instruction / ☰ menu in step. landmark-gesture-core.js holds the pure
// validation.

import {
  startFacialWatch,
  setHeadCursorEnabled,
  setGestureDetectionEnabled,
  isHeadCursorEnabled,
  isGestureDetectionEnabled,
  isCameraBlocked,
  setGestureMappings,
  getGestureConfig,
} from './facial-gesture.js';
import { setKeyboardStandalone, isKeyboardStandalone } from './on-screen-keyboard.js';
import { normalizeGestureAndLandmarkConfig, DEFAULT_GESTURE_MAPPINGS } from './landmark-gesture-core.js';

const CORNER_ID      = 'trussal-lg-corner';
const GEAR_ID        = 'trussal-lg-gear';
const MENU_ID        = 'trussal-lg-menu';
const INSTRUCTION_ID = 'trussal-lg-instruction';
const STYLE_ID       = 'trussal-lg-style';

let _modeOn    = false;
let _dismissed = false; // the user closed the instruction with its ✕
let _booted    = false;

// Trussal's welcome overlay enters a room with a full page reload
// (welcome-page.js). Without this the performer would have to re-enable the
// whole mode — by hand, the one thing it exists to avoid — every time they
// cross from the welcome page into prejoin/the meeting. Persist the on/off
// state per tab and restore it in init(); the facial-gesture watchdog brings
// the camera back on the far side.
const PERSIST_KEY = 'trussal-landmark-gesture-mode';
function _persistMode(on) {
  try {
    if (on) sessionStorage.setItem(PERSIST_KEY, '1');
    else sessionStorage.removeItem(PERSIST_KEY);
  } catch (e) { /* private mode / storage disabled — non-fatal */ }
}
function _wasModeOn() {
  try { return sessionStorage.getItem(PERSIST_KEY) === '1'; } catch (e) { return false; }
}

// ---------------------------------------------------------------------------
// Mode on/off.
// ---------------------------------------------------------------------------
function enableMode() {
  if (_modeOn) return;
  _modeOn = true;
  _persistMode(true);
  setGestureDetectionEnabled(true);
  setHeadCursorEnabled(true);
  setKeyboardStandalone(true);
  _renderInstruction();
  _syncGear();
  _announce();
}

function disableMode() {
  if (!_modeOn) return;
  _modeOn = false;
  _persistMode(false);
  setGestureDetectionEnabled(false);
  setHeadCursorEnabled(false);
  setKeyboardStandalone(false);
  _renderInstruction();
  _syncGear();
  _announce();
}

function toggleMode() {
  _modeOn ? disableMode() : enableMode();
}

function _announce() {
  document.dispatchEvent(new CustomEvent('trussal-landmark-gesture-mode-changed', {
    detail: { on: _modeOn },
  }));
}

// ---------------------------------------------------------------------------
// gestureAndLandmarkConfig — the code-side control surface.
// ---------------------------------------------------------------------------
export function gestureAndLandmarkConfig(config) {
  const norm = normalizeGestureAndLandmarkConfig(config);

  if ('gestureMappings' in norm) setGestureMappings(norm.gestureMappings);
  if ('virtualKeyboardEnabled' in norm) setKeyboardStandalone(norm.virtualKeyboardEnabled);
  if ('headCursorEnabled' in norm) setHeadCursorEnabled(norm.headCursorEnabled);
  if ('gestureDetectionEnabled' in norm) setGestureDetectionEnabled(norm.gestureDetectionEnabled);

  // The mode is "on" if any of its three limbs is on. Keep the instruction / ☰
  // menu / Face button in step with whatever the config just did.
  const on = isKeyboardStandalone() || isHeadCursorEnabled() || isGestureDetectionEnabled();
  if (on !== _modeOn) {
    _modeOn = on;
    _persistMode(on);
    _renderInstruction();
    _syncGear();
    _announce();
  }

  return { ...getGestureConfig(), virtualKeyboardEnabled: isKeyboardStandalone() };
}

// ---------------------------------------------------------------------------
// DOM — the top-left ☰ button, its one-item menu, and the instruction card.
// ---------------------------------------------------------------------------
function _injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    #${CORNER_ID} {
      position: fixed; top: 10px; left: 10px;
      z-index: 1000003;
      display: flex; flex-direction: column; align-items: flex-start; gap: 6px;
      font-family: Arial, Helvetica, sans-serif;
    }
    #${GEAR_ID} {
      width: 28px; height: 28px; line-height: 1;
      display: flex; align-items: center; justify-content: center;
      background: #eeeeee; color: #111111;
      border: 1px solid #111111; border-radius: 6px;
      font-size: 15px; cursor: pointer; padding: 0;
    }
    #${GEAR_ID}:hover { background: #111111; color: #eeeeee; }
    #${GEAR_ID}.on { background: #111111; color: #eeeeee; }
    #${MENU_ID} {
      display: none;
      background: #eeeeee; color: #111111;
      border: 1px solid #111111; border-radius: 6px;
      padding: 8px 10px; font-size: 12px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.2);
    }
    #${MENU_ID}.open { display: block; }
    #${MENU_ID} label {
      display: flex; align-items: center; gap: 6px; cursor: pointer;
      white-space: nowrap;
    }
    #${INSTRUCTION_ID} {
      background: #eeeeee; color: #111111;
      border: 1px solid #111111; border-radius: 8px;
      padding: 8px 10px; max-width: 300px;
      font-size: 12px; line-height: 1.5;
      box-shadow: 0 8px 24px rgba(0,0,0,0.2);
    }
    #${INSTRUCTION_ID} .lg-row { display: flex; justify-content: space-between; gap: 8px; }
    #${INSTRUCTION_ID} .lg-title { font-weight: 600; }
    #${INSTRUCTION_ID} .lg-x {
      background: #eeeeee; color: #111111;
      border: 1px solid #111111; border-radius: 4px;
      cursor: pointer; font-size: 10px; line-height: 1; padding: 1px 5px;
    }
    #${INSTRUCTION_ID} .lg-x:hover { background: #111111; color: #eeeeee; }
    #${INSTRUCTION_ID} ul { margin: 6px 0 0; padding-left: 18px; }
    #${INSTRUCTION_ID} kbd {
      border: 1px solid #111111; border-radius: 3px;
      padding: 0 4px; font-family: monospace; font-size: 11px;
    }
    #${INSTRUCTION_ID} .lg-blocked { opacity: 0.55; }
  `;
  document.head.appendChild(s);
}

function _ensureDOM() {
  if (document.getElementById(CORNER_ID)) return;
  if (!document.body) return;
  _injectStyles();

  const corner = document.createElement('div');
  corner.id = CORNER_ID;

  const gear = document.createElement('button');
  gear.id = GEAR_ID;
  gear.type = 'button';
  gear.title = 'Landmark and Gesture Mode';
  gear.textContent = '☰';

  const menu = document.createElement('div');
  menu.id = MENU_ID;
  menu.innerHTML = `
    <label>
      <input type="checkbox" id="trussal-lg-mode-toggle" />
      Landmark and Gesture Mode
    </label>
  `;

  const instruction = document.createElement('div');
  instruction.id = INSTRUCTION_ID;

  corner.appendChild(gear);
  corner.appendChild(menu);
  corner.appendChild(instruction);
  document.body.appendChild(corner);

  gear.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('open');
  });
  // Click anywhere else closes the menu.
  document.addEventListener('click', (e) => {
    if (!menu.classList.contains('open')) return;
    if (e.target === gear || menu.contains(e.target)) return;
    menu.classList.remove('open');
  });

  menu.querySelector('#trussal-lg-mode-toggle').addEventListener('change', (e) => {
    e.target.checked ? enableMode() : disableMode();
  });

  _renderInstruction();
  _syncGear();
}

function _renderInstruction() {
  const el = document.getElementById(INSTRUCTION_ID);
  if (!el) return;
  if (_modeOn || _dismissed) { el.style.display = 'none'; return; }
  el.style.display = 'block';
  const blocked = isCameraBlocked();
  el.innerHTML = `
    <div class="lg-row">
      <span class="lg-title">Landmark &amp; Gesture Mode</span>
      <button class="lg-x" type="button" title="Dismiss">✕</button>
    </div>
    <div>Turn on the on-screen keyboard, head cursor, and face-gesture control:</div>
    <ul>
      <li>press <kbd>→</kbd> (Right Arrow) — or <kbd>→</kbd> <kbd>→</kbd> <kbd>→</kbd> quickly if you're in a text field</li>
      <li>tick it in the <strong>☰</strong> menu (top-left)</li>
      <li class="${blocked ? 'lg-blocked' : ''}">close one eye for two seconds${blocked ? ' — needs camera access' : ''}</li>
    </ul>
  `;
  el.querySelector('.lg-x').addEventListener('click', (e) => {
    e.stopPropagation();
    _dismissed = true;
    _renderInstruction();
  });
}

function _syncGear() {
  const gear = document.getElementById(GEAR_ID);
  if (gear) gear.classList.toggle('on', _modeOn);
  const cb = document.getElementById('trussal-lg-mode-toggle');
  if (cb) cb.checked = _modeOn;
}

// ---------------------------------------------------------------------------
// Right Arrow — a global enable that stays out of the way of text entry.
// Pressed with nothing focused: one press enables. Pressed while a text field
// has focus (the prejoin screen autofocuses its name input, so this is the
// common case): a single press must still just move the caret, but THREE
// presses inside 800ms — a StickyKeys-style deliberate repeat — enables. That
// is the keyboard-only escape hatch for a performer whose sole input device is
// the on-screen keyboard, which can't otherwise reach this switch.
// ---------------------------------------------------------------------------
let _arrowTaps = [];
function _onKeydown(e) {
  if (_modeOn) return;
  if (e.key !== 'ArrowRight' || e.repeat || e.defaultPrevented) return;
  const t = e.target;
  const tag = t && t.tagName;
  const inField = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable);
  if (!inField) { enableMode(); return; }
  const now = Date.now();
  _arrowTaps = _arrowTaps.filter((ts) => now - ts < 800);
  _arrowTaps.push(now);
  if (_arrowTaps.length >= 3) { _arrowTaps = []; enableMode(); }
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------
function init() {
  if (_booted) return;
  if (window.__trussalIsBot || window.__trussalIsAggregator) return;
  _booted = true;

  window.gestureAndLandmarkConfig = gestureAndLandmarkConfig;
  window.gestureAndLandmarkConfig.defaults = DEFAULT_GESTURE_MAPPINGS.map((m) => ({ ...m }));

  _ensureDOM();
  window.addEventListener('keydown', _onKeydown, true);

  document.addEventListener('trussal-landmark-gesture-mode', (e) => {
    const d = e.detail || {};
    if (d.toggle) toggleMode();
    else if (d.on === false) disableMode();
    else enableMode();
  });

  // Kick MediaPipe into its watch-only state so the one-eye-held-shut enable
  // gesture works before the user has opted into anything. On failure the other
  // two enable paths still stand — just redraw the instruction to say so.
  startFacialWatch()
    .then((ok) => { if (!ok) _renderInstruction(); })
    .catch((err) => { console.error('[landmark-gesture] watch start failed', err); _renderInstruction(); });

  // Was the mode on before a screen change reloaded the page? Restore it, so
  // the performer stays hands-free straight through welcome → prejoin → meeting.
  if (_wasModeOn()) enableMode();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'complete' || document.readyState === 'interactive') init();
  else window.addEventListener('DOMContentLoaded', init);
}

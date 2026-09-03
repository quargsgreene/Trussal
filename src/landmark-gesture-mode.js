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
// headCursorEnabled, gestureDetectionEnabled, cursorSpeed, cursorGain,
// meetingLoadSensitivity }) is the code-side control: facial-gesture.js owns the
// gesture map + detection + the head-cursor motion tuning, on-screen-keyboard.js
// owns the keyboard, and this module wires a config object onto both and keeps
// the instruction / ☰ menu in step. landmark-gesture-core.js holds the pure
// validation (including the cursor-tuning ranges).
//
// The same on/off toggle and the three tuning sliders are also grafted into
// Jitsi's own "Keyboard shortcuts" dialog (⋮ menu → View shortcuts, or `?`),
// so a mouse user can reach them without the console. Styling is in
// landmark-gesture-mode.css (imported as text, like studio.css).

import {
  startFacialWatch,
  setHeadCursorEnabled,
  setGestureDetectionEnabled,
  isHeadCursorEnabled,
  isGestureDetectionEnabled,
  isCameraBlocked,
  setGestureMappings,
  setCursorSpeed,
  setCursorGain,
  setMeetingLoadSensitivity,
  getGestureConfig,
} from './facial-gesture.js';
import { setKeyboardStandalone, isKeyboardStandalone } from './on-screen-keyboard.js';
import { normalizeGestureAndLandmarkConfig, DEFAULT_GESTURE_MAPPINGS, CURSOR_TUNING } from './landmark-gesture-core.js';
import styles from './landmark-gesture-mode.css';

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
  // A bare `gestureAndLandmarkConfig()` (or an explicit null/undefined) reads
  // the current config back — the obvious way to inspect it, and what a config
  // getter is expected to do. Only a genuinely wrong type (string, number,
  // array, …) still throws, from normalizeGestureAndLandmarkConfig.
  const norm = normalizeGestureAndLandmarkConfig(config == null ? {} : config);

  if ('gestureMappings' in norm) setGestureMappings(norm.gestureMappings);
  if ('virtualKeyboardEnabled' in norm) setKeyboardStandalone(norm.virtualKeyboardEnabled);
  if ('headCursorEnabled' in norm) setHeadCursorEnabled(norm.headCursorEnabled);
  if ('gestureDetectionEnabled' in norm) setGestureDetectionEnabled(norm.gestureDetectionEnabled);
  if ('cursorSpeed' in norm) setCursorSpeed(norm.cursorSpeed);
  if ('cursorGain' in norm) setCursorGain(norm.cursorGain);
  if ('meetingLoadSensitivity' in norm) setMeetingLoadSensitivity(norm.meetingLoadSensitivity);

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

  const result = { ...getGestureConfig(), virtualKeyboardEnabled: isKeyboardStandalone() };
  // A write to the gesture map / cursor tuning has no on-screen effect of its
  // own, which reads as "the call did nothing" — so echo what landed both to
  // the console and as a brief on-screen toast by the ☰ corner.
  const applied = Object.keys(norm);
  if (applied.length) {
    console.log('[landmark-gesture] applied', applied, '→', result);
    _toast(_describeApplied(norm, result));
    const section = document.querySelector('.trussal-lg-shortcuts');
    if (section) _syncShortcutsControls(section);
  }
  return result;
}

// Human-readable one-liner for what a gestureAndLandmarkConfig() write changed.
function _describeApplied(norm, cfg) {
  const parts = [];
  if ('gestureMappings' in norm) {
    const n = norm.gestureMappings.length;
    parts.push(`gesture map · ${n} mapping${n === 1 ? '' : 's'}`);
  }
  if ('virtualKeyboardEnabled' in norm) parts.push(`keyboard ${norm.virtualKeyboardEnabled ? 'on' : 'off'}`);
  if ('headCursorEnabled' in norm) parts.push(`head cursor ${norm.headCursorEnabled ? 'on' : 'off'}`);
  if ('gestureDetectionEnabled' in norm) parts.push(`gesture actions ${norm.gestureDetectionEnabled ? 'on' : 'off'}`);
  if ('cursorSpeed' in norm) parts.push(`cursor speed ${cfg.cursorSpeed}`);
  if ('cursorGain' in norm) parts.push(`cursor gain ${cfg.cursorGain}`);
  if ('meetingLoadSensitivity' in norm) parts.push(`load sensitivity ${cfg.meetingLoadSensitivity}`);
  return `Landmark & Gesture · ${parts.join(' · ')}`;
}

// Brief inverted-colour toast beside the ☰ corner. Auto-dismisses; reachable on
// every screen (welcome / prejoin / meeting) since a config call can land on any.
let _toastTimer = null;
function _toast(msg) {
  try { _injectStyles(); } catch (e) { /* head not ready — skip the toast */ return; }
  let el = document.querySelector('.trussal-lg-toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'trussal-lg-toast';
    (document.body || document.documentElement).appendChild(el);
  }
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.classList.remove('show'); }, 3500);
}

// Expose the control surface the instant this module evaluates — not only from
// init() on DOMContentLoaded — so a bundle script or a console call that lands
// before the DOM is ready still finds `window.gestureAndLandmarkConfig`. Bots
// and the aggregator have no landmark UI, so they are left without it.
if (typeof window !== 'undefined' && !window.__trussalIsBot && !window.__trussalIsAggregator) {
  window.gestureAndLandmarkConfig = gestureAndLandmarkConfig;
  window.gestureAndLandmarkConfig.defaults = DEFAULT_GESTURE_MAPPINGS.map((m) => ({ ...m }));
}

// ---------------------------------------------------------------------------
// DOM — the top-left ☰ button, its one-item menu, and the instruction card.
// Styling lives in landmark-gesture-mode.css (imported as raw text, injected
// once here — same mechanism studio.js uses for studio.css).
// ---------------------------------------------------------------------------
function _injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = styles;
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
  const scToggle = document.querySelector('.trussal-lg-shortcuts .lg-sc-toggle');
  if (scToggle) scToggle.checked = _modeOn;
}

// ---------------------------------------------------------------------------
// Jitsi "Keyboard shortcuts" dialog integration.
//
// Jitsi's own shortcut list (⋮ menu → "View shortcuts", or the `?` key) gets a
// Landmark & Gesture Mode section grafted on: the enable shortcuts, an on/off
// toggle, and a slider for each of the three head-cursor motion tuning values.
// The dialog is React-owned, so a MutationObserver re-grafts the section
// whenever it (re)appears; each control just calls the same public entry points
// (enableMode/disableMode, gestureAndLandmarkConfig) a code call would.
// ---------------------------------------------------------------------------
const _SC_ROWS = [
  { key: 'cursorSpeed',            label: 'Head-cursor speed',       step: 0.01 },
  { key: 'cursorGain',             label: 'Head-cursor gain',        step: 0.05 },
  { key: 'meetingLoadSensitivity', label: 'Meeting-load sensitivity', step: 0.05 },
];

function _findShortcutsDialog() {
  // An element Jitsi named "…shortcut…" → its dialog ancestor.
  for (const el of document.querySelectorAll('[class*="shortcut" i]')) {
    if (el.closest('.trussal-lg-shortcuts')) continue;
    const dlg = el.closest('[role="dialog"], [class*="dialog" i], [class*="modal" i]');
    if (dlg) return dlg;
  }
  // Fallback: a dialog whose heading / aria-label mentions shortcuts.
  for (const d of document.querySelectorAll('[role="dialog"], [class*="dialog" i]')) {
    const h = d.querySelector('h1, h2, h3, [class*="title" i]');
    const t = ((h && h.textContent) || d.getAttribute('aria-label') || '').toLowerCase();
    if (t.includes('shortcut')) return d;
  }
  return null;
}

function _syncShortcutsControls(section) {
  const cfg = getGestureConfig();
  const toggle = section.querySelector('.lg-sc-toggle');
  if (toggle) toggle.checked = _modeOn;
  for (const { key } of _SC_ROWS) {
    const input = section.querySelector(`input[data-key="${key}"]`);
    const val = section.querySelector(`.lg-sc-val[data-key="${key}"]`);
    if (input && document.activeElement !== input) input.value = cfg[key];
    if (val) val.textContent = Number(cfg[key]).toFixed(2);
  }
}

function _buildShortcutsSection() {
  const cfg = getGestureConfig();
  const section = document.createElement('div');
  section.className = 'trussal-lg-shortcuts';
  const rows = _SC_ROWS.map(({ key, label, step }) => {
    const { min, max } = CURSOR_TUNING[key];
    return `<div class="lg-sc-row"><span>${label}</span><span class="lg-sc-ctl">`
      + `<input type="range" data-key="${key}" min="${min}" max="${max}" step="${step}" value="${cfg[key]}">`
      + `<span class="lg-sc-val" data-key="${key}">${Number(cfg[key]).toFixed(2)}</span></span></div>`;
  }).join('');
  section.innerHTML = `
    <div class="lg-sc-h">Landmark &amp; Gesture Mode</div>
    <div class="lg-sc-row"><span>Turn the mode on / off</span>
      <span class="lg-sc-ctl"><input type="checkbox" class="lg-sc-toggle"></span></div>
    <div class="lg-sc-row"><span class="lg-sc-keys">also: <kbd>&rarr;</kbd> &middot; hold one eye 2s &middot; top-left <kbd>&#9776;</kbd></span></div>
    ${rows}
  `;
  section.querySelector('.lg-sc-toggle').addEventListener('change', (e) => {
    e.target.checked ? enableMode() : disableMode();
  });
  for (const { key } of _SC_ROWS) {
    const input = section.querySelector(`input[data-key="${key}"]`);
    input.addEventListener('input', () => {
      gestureAndLandmarkConfig({ [key]: parseFloat(input.value) });
      _syncShortcutsControls(section);
    });
  }
  _syncShortcutsControls(section);
  return section;
}

function _maybeInjectShortcuts() {
  const dialog = _findShortcutsDialog();
  if (!dialog || dialog.querySelector('.trussal-lg-shortcuts')) return;
  _injectStyles();
  const body = dialog.querySelector('[class*="content" i], [class*="body" i]') || dialog;
  body.appendChild(_buildShortcutsSection());
}

let _scPending = false;
function _watchShortcutsDialog() {
  const obs = new MutationObserver(() => {
    if (_scPending) return;
    _scPending = true;
    requestAnimationFrame(() => { _scPending = false; _maybeInjectShortcuts(); });
  });
  obs.observe(document.body, { childList: true, subtree: true });
  _maybeInjectShortcuts(); // in case the dialog is already open
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

  // window.gestureAndLandmarkConfig is already set at module load (above); this
  // is the DOM + camera wiring.
  _ensureDOM();
  _watchShortcutsDialog();
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

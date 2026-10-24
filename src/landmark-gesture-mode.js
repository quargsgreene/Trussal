// landmark-gesture-mode.js
// "Landmark and Gesture Mode" — the one switch that turns on the on-screen
// keyboard, the MediaPipe head cursor, and face-gesture control together, and
// the ways to reach it from ANY Trussal screen (welcome page, prejoin,
// lobby knock, meeting):
//
//   • press → (Right Arrow)
//   • hold one eye shut for two seconds
//   • click the "Face" button in the Trussal Studio toolbar (meeting only)
//
// The eye gesture is why MediaPipe starts the moment the bundle loads:
// facial-gesture runs a camera-backed watcher with every gesture action OFF
// except `enable-landmark-gesture-mode`, so before you opt in the only thing it
// can do is notice the one-eye-held-shut gesture and flip this switch. The
// gesture is a normal entry in the map and can be re-pointed from code.
//
// gestureAndLandmarkConfig({ gestureMappings, virtualKeyboardEnabled,
// headCursorEnabled, gestureDetectionEnabled, cursorSpeed, cursorGain,
// meetingLoadSensitivity }) is the code-side control: facial-gesture.js owns the
// gesture map + detection + the head-cursor motion tuning, on-screen-keyboard.js
// owns the keyboard, and this module wires a config object onto both and keeps
// the Face button in step. landmark-gesture-core.js holds the pure validation
// (including the cursor-tuning ranges).
//
// Deliberately no instruction card, toast, or settings checkbox: the mode is
// already reachable from the keyboard, the eye gesture, the Face button, and
// code, so an extra notice only covers the UI it describes.

import {
  startFacialWatch,
  setHeadCursorEnabled,
  setGestureDetectionEnabled,
  isHeadCursorEnabled,
  isGestureDetectionEnabled,
  setGestureMappings,
  setCursorSpeed,
  setCursorGain,
  setMeetingLoadSensitivity,
  getGestureConfig,
} from './facial-gesture.js';
import { setKeyboardStandalone, isKeyboardStandalone } from './on-screen-keyboard.js';
import { normalizeGestureAndLandmarkConfig, DEFAULT_GESTURE_MAPPINGS } from './landmark-gesture-core.js';


let _modeOn = false;
let _booted = false;

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
  _announce();
}

function disableMode() {
  if (!_modeOn) return;
  _modeOn = false;
  _persistMode(false);
  setGestureDetectionEnabled(false);
  setHeadCursorEnabled(false);
  setKeyboardStandalone(false);
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

  // The mode is "on" if any of its three limbs is on. Keep the Face button in
  // step with whatever the config just did.
  const on = isKeyboardStandalone() || isHeadCursorEnabled() || isGestureDetectionEnabled();
  if (on !== _modeOn) {
    _modeOn = on;
    _persistMode(on);
    _announce();
  }

  const result = { ...getGestureConfig(), virtualKeyboardEnabled: isKeyboardStandalone() };
  // A write to the gesture map / cursor tuning has no on-screen effect of its
  // own, which reads as "the call did nothing" — echo what landed to the
  // console for whoever made the call.
  const applied = Object.keys(norm);
  if (applied.length) console.log('[landmark-gesture] applied', applied, '→', result);
  return result;
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
// Right Arrow — a global enable that stays out of the way of text entry.
// Pressed with nothing focused: one press enables. Pressed while a text field
// has focus (the prejoin screen autofocuses its name input, so this is the
// common case): a single press must still just move the caret, but THREE
// presses inside 800ms — a StickyKeys-style deliberate repeat — enables. That
// is the keyboard-only escape hatch for a performer whose sole input device is
// the on-screen keyboard, which can't otherwise reach this switch.
// ---------------------------------------------------------------------------

function _onKeydown(e) {
  if(_modeOn) return;
  if(e.key !== 'ArrowRight' || e.repeat || e.defaultPrevented) return;
  enableMode();
  return;
}

// ---------------------------------------------------------------------------
// Boot.
// ---------------------------------------------------------------------------
function init() {
  if (_booted) return;
  if (window.__trussalIsBot || window.__trussalIsAggregator) return;
  _booted = true;

  // window.gestureAndLandmarkConfig is already set at module load (above); this
  // is the camera + key wiring.
  window.addEventListener('keydown', _onKeydown, true);

  document.addEventListener('trussal-landmark-gesture-mode', (e) => {
    const d = e.detail || {};
    if (d.toggle) toggleMode();
    else if (d.on === false) disableMode();
    else enableMode();
  });

  // Kick MediaPipe into its watch-only state so the one-eye-held-shut enable
  // gesture works before the user has opted into anything. On failure the other
  // enable paths still stand.
  startFacialWatch()
    .catch((err) => { console.error('[landmark-gesture] watch start failed', err); });

  // Was the mode on before a screen change reloaded the page? Restore it, so
  // the performer stays hands-free straight through welcome → prejoin → meeting.
  if (_wasModeOn()) enableMode();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'complete' || document.readyState === 'interactive') init();
  else window.addEventListener('DOMContentLoaded', init);
}

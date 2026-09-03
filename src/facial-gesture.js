/*
facial-gesture.js — MediaPipe face-mesh, head-cursor and gestural
metaprogramming for Trussal.

Ports useFacialGestures.jsx, FacialGestureControl.jsx, and strudelButton.mjs from
the strudel-fork into Trussal's vanilla-JS context.  All strudel-fork behaviour is
preserved; the only adaptation is that the "editor" is Trussal's textarea (.ts-code)
and peer-state bus rather than a CodeMirror REPL.

Since gestureAndLandmarkConfig() (see landmark-gesture-mode.js) this module no
longer owns any of its own configuration UI.  The panel is just the live face
mesh plus a one-line readout of the gesture that last fired; the gesture map,
the on/off state of the head cursor, and the on/off state of gesture actions
are all set from code.

The camera runs in two states:
  • watch-only — started the moment the bundle loads.  The face landmarker
    runs, but the only gesture that does anything is whichever one maps to
    `enable-landmark-gesture-mode` (one eye held shut for 2s by default).  No
    mesh is drawn, no head cursor is shown.
  • full — the head cursor and/or gesture actions are switched on.  The mesh
    is drawn (grayscale, thicker eye/mouth outlines) and gestures fire.

window.faceCtx   — EMA-smoothed face metrics, readable inside any Strudel pattern
                   callback without touching the audio clock thread.
window.StrudelButton — custom element registered so the transpiler's *name: code
                   shorthand doesn't throw during eval.
*/

import { getLocalPeer, sendLocalPattern, sendLocalPlaying, sendLocalEffects } from './peer-state.js';
import { bootStrudelOnUserGesture, stopStrudel } from './strudel.js';
import { setVideoStream } from './hydra-video.js';
import { openCamera } from './published-video.js';
import {
  trackEditorFocus,
  readActiveEditor,
  writeActiveEditor,
  applyIfJPattern,
  applyMetaprogramNow,
  toggleJPatternButtonCode,
} from './editor-router.js';
import { attachPanelControls, isHeadDragActive } from './panel-drag-resize.js';
import { DEFAULT_GESTURE_MAPPINGS } from './landmark-gesture-core.js';

// Keep in sync with @mediapipe/tasks-vision version in strudel-fork/website/package.json.
const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const GESTURE_MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/gesture_recognizer/gesture_recognizer/float16/1/gesture_recognizer.task';
const MP_ESM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/+esm';

// Detection thresholds — identical to strudel-fork's useFacialGestures.jsx.
const WINK_THRESHOLD       = 0.6;  // single-eye blink threshold; both eyes must differ to qualify
const SMILE_THRESHOLD      = 0.7;  // bilateral smile → play
const SMILE_ASYMMETRY_MAX  = 0.2;  // max difference between left/right smile scores; perspective artifacts are asymmetric
const HEAD_YAW_THRESHOLD   = 0.25; // suppress smile when head is turned sideways beyond this fraction of eye width
const THUMBS_UP_THRESHOLD  = 0.6;  // GestureRecognizer confidence for Thumb_Up → stop
const BROW_INNER_THRESHOLD = 0.6;
const BROW_OUTER_THRESHOLD = 0.45;
const HEAD_TILT_THRESHOLD  = 0.3;
const MOUTH_OPEN_THRESHOLD = 0.5;  // jawOpen blendshape → `mouthOpen` trigger
const EMA_ALPHA            = 0.15;
const LATCH_RESET          = 0.4;
const DWELL_MS             = 1000;
const LEFT_EYE_HOLD_MS     = 2000; // sustained one-eyed hold → `leftEyeClosed2s`
const HEAD_TILT_SEMITONES  = 2;    // transpose step for a head tilt

const RING_R = 16;
const RING_C = 2 * Math.PI * RING_R;

// ---------------------------------------------------------------------------
// window.faceCtx — initialised at module load so patterns are safe to read
// before the camera starts.
// ---------------------------------------------------------------------------
if (typeof window !== 'undefined') {
  window.faceCtx = window.faceCtx || {
    jawOpen: 0, browInnerUp: 0, headTilt: 0, headYaw: 0,
    mouthSmileLeft: 0, mouthSmileRight: 0,
    eyeBlinkLeft: 0, eyeBlinkRight: 0,
    eyeOpenLeft: null, eyeOpenRight: null,
    cursorX: window.innerWidth  / 2,
    cursorY: window.innerHeight / 2,
  };
}

// ---------------------------------------------------------------------------
// window.StrudelButton — custom element so *name: code transpiler output
// doesn't throw when evaluated outside a CodeMirror REPL.
// ---------------------------------------------------------------------------
let _strudelButtonRegistered = false;
function initStrudelButton() {
  if (_strudelButtonRegistered || typeof window === 'undefined') return;
  _strudelButtonRegistered = true;
  class StrudelButton extends HTMLButtonElement {
    constructor(code) { super(); this._strudelCode = code; }
  }
  try { customElements.define('strudel-button', StrudelButton, { extends: 'button' }); } catch {}
  globalThis.StrudelButton = StrudelButton;

  class JPatternButton extends HTMLButtonElement {
    constructor(code) { super(); this._jPatternCode = code; }
  }
  try { customElements.define('j-pattern-button', JPatternButton, { extends: 'button' }); } catch {}
  globalThis.JPatternButton = JPatternButton;
}

// ---------------------------------------------------------------------------
// Editor shim — resolves to whichever editor is focused: the personal
// Strudel textarea (pattern → sendLocalPattern) or the global JPattern
// editor (CRDT doc). editor-router.js owns the resolution.
// ---------------------------------------------------------------------------
trackEditorFocus();

// Any focused code editor becomes the one the head cursor holds focus on when
// the cursor later moves off to the on-screen keyboard — regardless of whether
// it was the head cursor, a click, or Tab that focused it.
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => {
    if (e.target?.classList?.contains('ts-code')) _stickyEditor = e.target;
  });
  // liveCapture('gesture') replay: a recorded raw gesture is re-dispatched by
  // name here, running whatever action it is currently mapped to. Registered at
  // module load so a replay works regardless of the panel / opt-in state.
  document.addEventListener('trussal-gesture-refire', (e) => {
    refireGesture(e && e.detail && e.detail.name);
  });
}

// Announce a fired raw gesture so liveCapture('gesture') can log it. detail.name
// is a trigger name: smile, thumbsUp, thumbsDown, leftBlink, browRaise,
// mouthOpen, headTiltLeft, headTiltRight.
function _fireGestureEvent(name) {
  try {
    document.dispatchEvent(new CustomEvent('trussal-gesture-fired', { detail: { name } }));
  } catch (e) { /* ignore */ }
}

// Replay half of liveCapture('gesture'): re-run the gesture's currently-mapped
// action through the same dispatch path a live gesture takes.
export function refireGesture(name) {
  if (name) _dispatchTrigger(name);
}

function getCode() {
  return readActiveEditor();
}

function setCode(code) {
  writeActiveEditor(code, { modality: 'head-cursor' });
}

async function evaluate() {
  // Focus in the JPattern card → "evaluate" means applying the shared
  // metaprogram, not booting Strudel.
  if (applyIfJPattern()) return;
  try {
    // Sync the current textarea code into localPeer.pattern so rebuildAndEvaluate
    // picks up changes made since the last explicit eval (typing is no longer
    // auto-synced).
    sendLocalPattern(getCode());
    await bootStrudelOnUserGesture();
    sendLocalPlaying(true);
    document.dispatchEvent(new CustomEvent('trussal-eval'));
  } catch (e) {
    console.warn('[facial-gesture] evaluate failed', e);
  }
}

async function mutateAndEvaluate(mutatorFn) {
  const cur = getCode();
  const next = mutatorFn(cur);
  if (next !== cur) { setCode(next); await evaluate(); }
}

// ---------------------------------------------------------------------------
// Mutation helpers — identical logic to FacialGestureControl.jsx.
// ---------------------------------------------------------------------------
const HH_CYCLE = ['', '*2', '*4', '*8'];
function cycleHiHat(code) {
  const re = /\bhh(\*\d+)?/;
  const m = code.match(re);
  if (!m) return code;
  const idx = HH_CYCLE.indexOf(m[1] ?? '');
  return code.replace(re, `hh${HH_CYCLE[(idx + 1) % HH_CYCLE.length]}`);
}

function shiftTranspose(code, delta) {
  if (/\.transpose\((-?\d+)\)/.test(code))
    return code.replace(/\.transpose\((-?\d+)\)/, (_, n) => `.transpose(${+n + delta})`);
  if (/\.add\((-?\d+)\)/.test(code))
    return code.replace(/\.add\((-?\d+)\)/, (_, n) => `.add(${+n + delta})`);
  // No existing transpose — append one after the last non-whitespace character.
  return code.replace(/(\S)\s*$/, `$1.transpose(${delta})`);
}

// In-code `/* @mediapipe {"trigger":…,"action":…} */` annotations are still
// honoured: for a given trigger they OVERRIDE the configured mapping, exactly
// as they did before gestureAndLandmarkConfig() existed.
function parseMediapipeConfigs(code) {
  const configs = [];
  const re = /\/\*\s*@mediapipe\s+(\{[\s\S]*?\})\s*\*\//g;
  let m;
  while ((m = re.exec(code)) !== null) {
    try { configs.push(JSON.parse(m[1])); } catch {}
  }
  return configs;
}

function applyRegexMutation(code, pattern, replacement) {
  try { return code.replace(new RegExp(pattern, 'g'), replacement ?? ''); } catch { return code; }
}

// ---------------------------------------------------------------------------
// MediaPipe detection state.
// ---------------------------------------------------------------------------
let _landmarker        = null;
let _gestureRecognizer = null;
let _mpClasses         = null;
let _drawingUtils  = null;
let _stream        = null;
let _rafId         = null;

let _cameraOn        = false; // camera + detection loop running (watch or full)
let _cameraStarting  = false;
let _cameraBlocked   = false; // getUserMedia / model load failed — enable paths degrade
let _explicitlyStopped = false; // stopFacial() was called — the watchdog stands down
let _camRetryAt      = 0;     // performance.now() of the watchdog's last re-acquire
let _headCursor      = false; // head cursor + dwell active (isHeadCursorEnabled)
let _gestures        = false; // gesture ACTIONS active (beyond enable-landmark-gesture-mode)
let _sharedWithHydra = false;
let _leftEyeClosedSince   = 0;
let _leftEyeOpenGraceUntil = 0; // tolerate a brief eyes-open flicker mid-hold
let _lastSynthMove   = 0;    // throttle the toolbar-keep-alive mousemove

// The live gesture map. Replaced wholesale by setGestureMappings(); starts as
// the defaults so behaviour with no config call is exactly what it always was.
let _gestureMappings = DEFAULT_GESTURE_MAPPINGS.map((m) => ({ ...m }));

let _videoEl       = null;
let _canvasEl      = null;
let _cursorEl      = null;
let _progressRing  = null;
let _statusEl      = null;
let _flashEl       = null;
let _flashTimeout  = null;

const _ema = {
  jawOpen: 0, browInnerUp: 0, headTilt: 0, headYaw: 0,
  mouthSmileLeft: 0, mouthSmileRight: 0,
  eyeBlinkLeft: 0, eyeBlinkRight: 0,
  cursorX: typeof window !== 'undefined' ? window.innerWidth  / 2 : 0,
  cursorY: typeof window !== 'undefined' ? window.innerHeight / 2 : 0,
};
const _latch = {
  headLeft: false, headRight: false, leftBlink: false, browRaise: false,
  smile: false, thumbsUp: false, thumbsDown: false,
  mouthOpen: false, leftEyeClosed2s: false,
};
// _dwell.type: 'fx' | 'action' | null.  key is the fx name or the button id.
const _dwell = { key: null, type: null, el: null, startMs: 0, fired: false };

// Head-cursor editor targeting (see _followEditorCaret):
//  • _stickyEditor stays focused after the head cursor leaves it, so the
//    performer can move off to the on-screen keyboard and keep typing there.
//  • _caretLocked is a thumbs-down freeze — while set, the head cursor no
//    longer moves the editor's blinking caret (another thumbs-down clears it).
//  • _caretEl / _caretAppliedAt back the anti-jitter travel threshold.
let _stickyEditor   = null;
let _caretLocked    = false;
let _caretEl        = null;
let _caretAppliedAt = { x: -Infinity, y: -Infinity };
// The field the head cursor most recently focused — kept outlined (see
// .trussal-hc-focus) while it stays the on-screen keyboard's typing target,
// so a hands-free performer can see where their keystrokes are going.
let _hcFocusEl      = null;

// Dwell-hoverable elements, refreshed on a throttle rather than re-querying the
// whole document every animation frame (60fps). The JPattern editor card's
// voice buttons (.jp-head-btn) are dwellable directly — the facial-control
// panel no longer mirrors them.
const DWELL_TARGETS_REFRESH_MS = 300;
let _dwellCandidates = [];
let _dwellCandidatesAt = -Infinity;
function _dwellCandidateEls(now) {
  if (now - _dwellCandidatesAt >= DWELL_TARGETS_REFRESH_MS) {
    _dwellCandidatesAt = now;
    _dwellCandidates = Array.from(document.querySelectorAll(
      '.ts-fx-dwell-btn, .ts-dwell-btn, .jp-head-btn, button[is="j-pattern-button"]'
    ));
  }
  return _dwellCandidates;
}

// Every actionable control anywhere on the page — Trussal's own screens AND
// Jitsi's (toolbar, participants pane, chat, settings dialog, overflow menus),
// on the welcome page, prejoin, lobby and in a meeting alike. A hands-free
// performer drives the WHOLE app by dwell, so nothing is out of scope. The only
// exclusions are the two panels that run their own dwell loop (the on-screen
// keyboard and the facial panel) and the head-cursor overlay itself.
//
// Returns { el, r } pairs with the bounding rect captured HERE, on the throttle
// — the per-frame loop then hit-tests against the cached rect instead of
// calling getBoundingClientRect on a few hundred nodes every frame. A rect up
// to GENERIC_DWELL_REFRESH_MS stale is close enough for a target that needs a
// full second of hover to fire.
const GENERIC_DWELL_REFRESH_MS = 500;
const _GENERIC_DWELL_SEL =
  'button, [role="button"], [role="menuitem"], [role="menuitemcheckbox"], ' +
  '[role="menuitemradio"], [role="tab"], [role="switch"], [role="option"], ' +
  'a[href], summary, select, input:not([type="hidden"]):not([type="range"])';
let _genericDwell   = [];
let _genericDwellAt = -Infinity;
function _genericDwellEls(now) {
  if (now - _genericDwellAt >= GENERIC_DWELL_REFRESH_MS) {
    _genericDwellAt = now;
    const vw = window.innerWidth, vh = window.innerHeight;
    _genericDwell = [];
    for (const el of document.querySelectorAll(_GENERIC_DWELL_SEL)) {
      if (el.disabled || el.getAttribute('aria-disabled') === 'true') continue;
      // The keyboard, the facial panel and the cursor ring handle themselves.
      if (el.closest(`#trussal-kbd-panel, #${FG_PANEL_ID}, #${FG_CURSOR_ID}`)) continue;
      const r = el.getBoundingClientRect();
      if (r.width <= 4 || r.height <= 4) continue;
      if (r.bottom <= 0 || r.right <= 0 || r.top >= vh || r.left >= vw) continue;
      // Hidden by CSS, or parked off-DOM-flow by an auto-retracted toolbar.
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
      if (!el.offsetParent && cs.position !== 'fixed') continue;
      _genericDwell.push({ el, r });
    }
  }
  return _genericDwell;
}

// ---------------------------------------------------------------------------
// Gesture → action dispatch.
// ---------------------------------------------------------------------------
function _flash(trigger, action) {
  if (!_flashEl) return;
  _flashEl.textContent = action ? `${trigger} → ${action}` : trigger;
  _flashEl.style.opacity = '1';
  clearTimeout(_flashTimeout);
  _flashTimeout = setTimeout(() => { if (_flashEl) _flashEl.style.opacity = '0'; }, 900);
}

function _setStatus(s) {
  if (!_statusEl) return;
  // Flat theme: the status word itself carries the meaning, so every state is
  // the same #111111 rather than a colour.
  _statusEl.textContent = s;
  _statusEl.style.color = '#111111';
}

// For `trigger`, an in-code @mediapipe annotation wins over the configured
// mapping; otherwise the configured mapping(s) apply.
function _effectiveMappingsFor(trigger) {
  let codeMaps = [];
  try {
    codeMaps = parseMediapipeConfigs(getCode()).filter((m) => m && m.trigger === trigger);
  } catch {}
  if (codeMaps.length) return codeMaps;
  return _gestureMappings.filter((m) => m.trigger === trigger);
}

function _dispatchTrigger(trigger) {
  // Capture tap for liveCapture('gesture') — every raw gesture, whether or not
  // it is currently mapped or opted in. The replay path re-enters here, so
  // live-capture.js guards its own logger against the refire it just issued.
  _fireGestureEvent(trigger);
  for (const m of _effectiveMappingsFor(trigger)) {
    // Before opt-in, the ONLY thing a gesture may do is turn the mode on.
    if (!_gestures && m.action !== 'enable-landmark-gesture-mode') continue;
    _runAction(m, trigger);
  }
}

function _runAction(m, trigger) {
  switch (m.action) {
    case 'play':
      _flash(trigger, m.action);
      bootStrudelOnUserGesture().then(() => sendLocalPlaying(true)).catch(() => {});
      break;
    case 'stop':
      _flash(trigger, m.action);
      stopStrudel().then(() => sendLocalPlaying(false)).catch(() => {});
      break;
    case 'update-code':
    case 'eval': // legacy spelling
      _flash(trigger, 'update-code');
      evaluate();
      break;
    case 'toggle-caret-lock':
      _caretLocked = !_caretLocked;
      _flash(trigger, _caretLocked ? 'caret-lock' : 'caret-unlock');
      break;
    case 'drum-density':
      _flash(trigger, m.action);
      mutateAndEvaluate(cycleHiHat);
      break;
    case 'transpose-down':
      _flash(trigger, m.action);
      mutateAndEvaluate((c) => shiftTranspose(c, -HEAD_TILT_SEMITONES));
      break;
    case 'transpose-up':
      _flash(trigger, m.action);
      mutateAndEvaluate((c) => shiftTranspose(c, HEAD_TILT_SEMITONES));
      break;
    case 'regex-swap':
      if (m.regex) {
        _flash(trigger, m.action);
        mutateAndEvaluate((c) => applyRegexMutation(c, m.regex, m.replacement));
      }
      break;
    case 'apply-metaprogram':
      _flash(trigger, m.action);
      applyMetaprogramNow();
      break;
    case 'enable-landmark-gesture-mode':
      _flash(trigger, m.action);
      document.dispatchEvent(new CustomEvent('trussal-landmark-gesture-mode', {
        detail: { on: true, source: 'gesture' },
      }));
      break;
    default:
      console.warn('[facial-gesture] no handler for action', m.action);
  }
}

// ---------------------------------------------------------------------------
// Detection.
// ---------------------------------------------------------------------------
// Per-eye eyelid aperture from the face mesh: vertical lid gap ÷ eye width, so
// it is invariant to distance and head size. A relaxed open eye lands around
// 0.28-0.40, a shut one below ~0.12. Unlike the eyeBlink blendshape this does
// NOT sag while an eye is held shut, and it resolves the two eyes independently
// — the blendshape (verified live) reports both eyes together on a one-eyed
// wink, which is why the enable gesture never fired. Points: right eye upper/
// lower lid 159/145, corners 33/133; left eye 386/374, corners 362/263.
function _eyeOpenness(landmarks) {
  if (!landmarks || landmarks.length <= 386) return null;
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const rOpen = d(landmarks[159], landmarks[145]) / (d(landmarks[33],  landmarks[133]) || 1e-6);
  const lOpen = d(landmarks[386], landmarks[374]) / (d(landmarks[362], landmarks[263]) || 1e-6);
  return { lOpen, rOpen };
}

function _processResult(result, gestureResult) {
  const blendshapes = result.faceBlendshapes?.[0]?.categories;
  const landmarks   = result.faceLandmarks?.[0];
  if (!blendshapes) return;

  const score = (name) => blendshapes.find((c) => c.categoryName === name)?.score ?? 0;
  const lerp  = (a, b) => a + EMA_ALPHA * (b - a);

  _ema.jawOpen        = lerp(_ema.jawOpen,        score('jawOpen'));
  _ema.browInnerUp    = lerp(_ema.browInnerUp,    score('browInnerUp'));
  _ema.mouthSmileLeft = lerp(_ema.mouthSmileLeft, score('mouthSmileLeft'));
  _ema.mouthSmileRight= lerp(_ema.mouthSmileRight,score('mouthSmileRight'));
  _ema.eyeBlinkLeft   = lerp(_ema.eyeBlinkLeft,   score('eyeBlinkLeft'));
  _ema.eyeBlinkRight  = lerp(_ema.eyeBlinkRight,  score('eyeBlinkRight'));

  if (landmarks && landmarks.length > 263) {
    const eyeDistX   = Math.abs(landmarks[263].x - landmarks[33].x) || 0.1;
    const eyeCenterX = (landmarks[33].x + landmarks[263].x) / 2;
    const tiltRaw    = (landmarks[33].y - landmarks[263].y) / eyeDistX;
    const yawRaw     = (landmarks[4].x - eyeCenterX) / eyeDistX;
    _ema.headTilt    = lerp(_ema.headTilt, Math.max(-1, Math.min(1, tiltRaw)));
    _ema.headYaw     = lerp(_ema.headYaw,  Math.max(-1, Math.min(1, yawRaw)));
  }
  if (landmarks && landmarks.length > 10) {
    const lm = landmarks[10];
    _ema.cursorX = lerp(_ema.cursorX, (1 - lm.x) * window.innerWidth);
    _ema.cursorY = lerp(_ema.cursorY,       lm.y  * window.innerHeight);
  }

  Object.assign(window.faceCtx, _ema);

  // Raw eyelid aperture (not EMA'd — a "held shut" test wants the real
  // per-frame gap; the 250ms grace below rides out a dropped frame). Also
  // published on faceCtx so the thresholds can be retuned from live values
  // without another deploy.
  const eyes = _eyeOpenness(landmarks);
  window.faceCtx.eyeOpenLeft  = eyes ? eyes.lOpen : null;
  window.faceCtx.eyeOpenRight = eyes ? eyes.rOpen : null;

  _processGestures(blendshapes, gestureResult, eyes);
}

function _processGestures(blendshapes, gestureResult, eyes) {
  const score        = (name) => blendshapes.find((c) => c.categoryName === name)?.score ?? 0;
  const eyeBlinkL    = score('eyeBlinkLeft');
  const eyeBlinkR    = score('eyeBlinkRight');
  const mouthSmileL  = score('mouthSmileLeft');
  const mouthSmileR  = score('mouthSmileRight');
  const browInnerUp  = score('browInnerUp');
  const browOuterL   = score('browOuterUpLeft');
  const browOuterR   = score('browOuterUpRight');

  // Left blink: left eye clearly closed, right clearly open. The < 0.3 guard
  // ensures a double-blink never qualifies. Right blink is unmapped.
  const isLeftBlink = eyeBlinkL > WINK_THRESHOLD && eyeBlinkR < 0.3;

  // enable gesture: one eye held clearly shut while the other stays open, for
  // LEFT_EYE_HOLD_MS. This is the ONLY way a performer with no physical keyboard
  // or mouse can switch Landmark and Gesture Mode on before a meeting, so it has
  // to actually fire for a real face.
  //  • Driven by eyelid APERTURE (`eyes`, mesh geometry), not the eyeBlink
  //    blendshape: the blendshape fires on the blink motion, sags within ~1s of
  //    a held close, and on this camera/model reports BOTH eyes rising together
  //    on a one-eyed wink (measured live: L and R within ~0.05 the whole time).
  //    Geometry has none of those problems.
  //  • Eye-agnostic: whichever eye is the more-shut one counts, so it does not
  //    matter which physical eye the mesh calls left. `open - shut` gap tolerates
  //    the open eye squinting sympathetically.
  //  • A real blink closes both lids together (tiny gap) and still won't qualify.
  //  • Blendshape asymmetry stays as a fallback for a frame with no usable
  //    landmarks; the 250ms grace rides out a single dropped frame.
  // _dispatchTrigger lets it through even while gesture actions are off.
  const nowP = performance.now();
  let winkHeld;
  if (eyes) {
    const shut = Math.min(eyes.lOpen, eyes.rOpen);
    const open = Math.max(eyes.lOpen, eyes.rOpen);
    winkHeld = shut < 0.15 && (open - shut) > 0.13;
  } else {
    winkHeld = Math.max(eyeBlinkL, eyeBlinkR) > 0.5 && Math.abs(eyeBlinkL - eyeBlinkR) > 0.25;
  }
  if (winkHeld) {
    if (_leftEyeClosedSince === 0) _leftEyeClosedSince = nowP;
    _leftEyeOpenGraceUntil = nowP + 250;
    if (!_latch.leftEyeClosed2s && nowP - _leftEyeClosedSince >= LEFT_EYE_HOLD_MS) {
      _latch.leftEyeClosed2s = true;
      _dispatchTrigger('leftEyeClosed2s');
    }
  } else if (nowP > _leftEyeOpenGraceUntil) {
    _leftEyeClosedSince = 0;
    _latch.leftEyeClosed2s = false;
  }

  // play — bilateral smile, guarded against head-turn false positives:
  // • both sides must exceed threshold (real smile)
  // • left/right scores must agree within SMILE_ASYMMETRY_MAX
  // • head yaw must be small (turning to move the cursor lifts mouth corners)
  const isSmile = mouthSmileL > SMILE_THRESHOLD &&
                  mouthSmileR > SMILE_THRESHOLD &&
                  Math.abs(mouthSmileL - mouthSmileR) < SMILE_ASYMMETRY_MAX &&
                  Math.abs(_ema.headYaw) < HEAD_YAW_THRESHOLD;
  if (isSmile && !_latch.smile) { _latch.smile = true; _dispatchTrigger('smile'); }
  if (_latch.smile && mouthSmileL < SMILE_THRESHOLD * LATCH_RESET && mouthSmileR < SMILE_THRESHOLD * LATCH_RESET) {
    _latch.smile = false;
  }

  // stop — thumbs up hand gesture (GestureRecognizer)
  const topGesture = gestureResult?.gestures?.[0]?.[0];
  const isThumbsUp = topGesture?.categoryName === 'Thumb_Up' && topGesture.score > THUMBS_UP_THRESHOLD;
  if (isThumbsUp && !_latch.thumbsUp) { _latch.thumbsUp = true; _dispatchTrigger('thumbsUp'); }
  if (_latch.thumbsUp && !isThumbsUp) { _latch.thumbsUp = false; }

  // thumbs down — the mapped action decides what it does (caret lock by default)
  const isThumbsDown = topGesture?.categoryName === 'Thumb_Down' && topGesture.score > THUMBS_UP_THRESHOLD;
  if (isThumbsDown && !_latch.thumbsDown) { _latch.thumbsDown = true; _dispatchTrigger('thumbsDown'); }
  if (_latch.thumbsDown && !isThumbsDown) { _latch.thumbsDown = false; }

  // update/eval — left blink only (right blink and double-blink are unmapped)
  if (isLeftBlink && !_latch.leftBlink) { _latch.leftBlink = true; _dispatchTrigger('leftBlink'); }
  if (_latch.leftBlink && eyeBlinkL < WINK_THRESHOLD * LATCH_RESET) { _latch.leftBlink = false; }

  // drum density — brow raise: inner brow up + at least one outer brow, eyes open
  const isBrowRaise =
    browInnerUp > BROW_INNER_THRESHOLD &&
    (browOuterL > BROW_OUTER_THRESHOLD || browOuterR > BROW_OUTER_THRESHOLD) &&
    eyeBlinkL < 0.3 && eyeBlinkR < 0.3;
  if (isBrowRaise && !_latch.browRaise) { _latch.browRaise = true; _dispatchTrigger('browRaise'); }
  if (_latch.browRaise && !(browInnerUp > BROW_INNER_THRESHOLD * LATCH_RESET)) { _latch.browRaise = false; }

  // mouth open — jawOpen blendshape (drives `mouthOpen` @mediapipe swaps and
  // any mouthOpen mapping). Had no built-in effect before, so the default map
  // leaves it unbound.
  const jaw = _ema.jawOpen;
  if (jaw > MOUTH_OPEN_THRESHOLD && !_latch.mouthOpen) { _latch.mouthOpen = true; _dispatchTrigger('mouthOpen'); }
  if (_latch.mouthOpen && jaw < MOUTH_OPEN_THRESHOLD * LATCH_RESET) { _latch.mouthOpen = false; }

  // head tilt — transpose ±
  const headTilt = _ema.headTilt;
  if (!_latch.headLeft && headTilt < -HEAD_TILT_THRESHOLD) {
    _latch.headLeft = true; _dispatchTrigger('headTiltLeft');
  } else if (_latch.headLeft && headTilt > -HEAD_TILT_THRESHOLD * LATCH_RESET) {
    _latch.headLeft = false;
  }
  if (!_latch.headRight && headTilt > HEAD_TILT_THRESHOLD) {
    _latch.headRight = true; _dispatchTrigger('headTiltRight');
  } else if (_latch.headRight && headTilt < HEAD_TILT_THRESHOLD * LATCH_RESET) {
    _latch.headRight = false;
  }
}

function _drawLandmarks(result) {
  if (!_canvasEl || !_mpClasses || !_videoEl) return;
  // The mesh is a Landmark-and-Gesture-Mode affordance — nothing draws it while
  // the camera is only watching for the enable gesture.
  if (!_headCursor && !_gestures) {
    const c = _canvasEl.getContext('2d');
    if (c) c.clearRect(0, 0, _canvasEl.width, _canvasEl.height);
    return;
  }
  if (_canvasEl.width  !== _videoEl.videoWidth)  _canvasEl.width  = _videoEl.videoWidth  || 320;
  if (_canvasEl.height !== _videoEl.videoHeight) _canvasEl.height = _videoEl.videoHeight || 240;
  const ctx = _canvasEl.getContext('2d');
  if (!_drawingUtils) _drawingUtils = new _mpClasses.DrawingUtils(ctx);
  ctx.clearRect(0, 0, _canvasEl.width, _canvasEl.height);
  if (!result.faceLandmarks?.length) return;
  const du = _drawingUtils;
  const FL = _mpClasses.FaceLandmarker;
  // Exclusively grayscale; eye and lip outlines a touch thicker than the mesh.
  for (const lm of result.faceLandmarks) {
    du.drawConnectors(lm, FL.FACE_LANDMARKS_TESSELATION,   { color: '#8a8a8a30', lineWidth: 0.5 });
    du.drawConnectors(lm, FL.FACE_LANDMARKS_RIGHT_EYE,     { color: '#f2f2f2',   lineWidth: 2.5 });
    du.drawConnectors(lm, FL.FACE_LANDMARKS_RIGHT_EYEBROW, { color: '#c8c8c8',   lineWidth: 2 });
    du.drawConnectors(lm, FL.FACE_LANDMARKS_LEFT_EYE,      { color: '#f2f2f2',   lineWidth: 2.5 });
    du.drawConnectors(lm, FL.FACE_LANDMARKS_LEFT_EYEBROW,  { color: '#c8c8c8',   lineWidth: 2 });
    du.drawConnectors(lm, FL.FACE_LANDMARKS_FACE_OVAL,     { color: '#9a9a9a',   lineWidth: 1 });
    du.drawConnectors(lm, FL.FACE_LANDMARKS_LIPS,          { color: '#f2f2f2',   lineWidth: 2.5 });
  }
}

let _densitySkip = 0;

function _detectionLoop() {
  if (!_videoEl || !_landmarker || _videoEl.readyState < 2) {
    _rafId = requestAnimationFrame(_detectionLoop);
    return;
  }

  // Room-health landmark-density scale-down: under load (RoomHealthService sets
  // window._jpLandmarkScale to 0.5 / 0.25) run detection on every 2nd / 4th
  // frame — the cursor EMA smooths over the gaps.
  const densityScale = (typeof window !== 'undefined' && window._jpLandmarkScale) || 1;
  if (densityScale < 1) {
    _densitySkip = (_densitySkip + 1) % Math.round(1 / densityScale);
    if (_densitySkip !== 0) {
      _rafId = requestAnimationFrame(_detectionLoop);
      return;
    }
  }

  const ts            = performance.now();
  const result        = _landmarker.detectForVideo(_videoEl, ts);
  const gestureResult = _gestureRecognizer?.recognizeForVideo(_videoEl, ts);
  _processResult(result, gestureResult);
  _drawLandmarks(result);

  // liveCapture('cursor') retrace: while a replay is driving, its point wins so
  // the real head cursor (and every dwell target it hovers) follows the path.
  const _lcOv = typeof window !== 'undefined' ? window._lcCursorOverride : null;
  if (_lcOv && Date.now() < _lcOv.until) {
    _ema.cursorX = _lcOv.x;
    _ema.cursorY = _lcOv.y;
    window.faceCtx.cursorX = _lcOv.x;
    window.faceCtx.cursorY = _lcOv.y;
  }

  // Everything below is head-cursor work — skipped entirely in the watch-only
  // state (camera up purely to catch the enable gesture).
  if (!_headCursor) {
    if (_cursorEl && _cursorEl.style.display !== 'none') _cursorEl.style.display = 'none';
    _rafId = requestAnimationFrame(_detectionLoop);
    return;
  }

  // Move head cursor.
  if (_cursorEl) {
    _cursorEl.style.left    = `${_ema.cursorX}px`;
    _cursorEl.style.top     = `${_ema.cursorY}px`;
    _cursorEl.style.display = 'block';
  }

  // A panel is being flown around by the head cursor (panel-drag-resize.js).
  // Suppress our own dwell firing until it's dropped.
  if (isHeadDragActive()) {
    if (_dwell.el) {
      _dwell.el.classList.remove('strudel-dwell-hover', 'trussal-hc-dwell');
      if (_dwell.type === 'action') _dwell.el.style.removeProperty('--dwell-prog');
    }
    _dwell.key = null; _dwell.type = null; _dwell.el = null;
    _dwell.startMs = 0; _dwell.fired = false;
    if (_progressRing) _progressRing.style.strokeDashoffset = RING_C.toFixed(2);
    _rafId = requestAnimationFrame(_detectionLoop);
    return;
  }

  const cx = _ema.cursorX;
  const cy = _ema.cursorY;

  // A head-cursor-only performer produces no real pointer events, so Jitsi's
  // toolbar (and every other hover-revealed control) auto-hides after a few
  // seconds and can never be dwelled. Replay a synthetic mousemove at the
  // cursor a couple of times a second so the app's inactivity timers keep
  // those controls on screen.
  if (ts - _lastSynthMove > 450) {
    _lastSynthMove = ts;
    const under = document.elementFromPoint(cx, cy) || document.body;
    try {
      under?.dispatchEvent(new MouseEvent('mousemove', {
        clientX: cx, clientY: cy, bubbles: true, cancelable: true, view: window,
      }));
    } catch (e) { /* SecurityError from a cross-origin frame under the point */ }
  }

  // Head cursor over a Studio code editor → focus that textarea and (unless the
  // caret is thumbs-down locked) walk its blinking caret to the character under
  // the cursor.
  _followEditorCaret(cx, cy);

  let hoveredKey  = null;
  let hoveredType = null;
  let hoveredEl   = null;
  for (const btn of _dwellCandidateEls(ts)) {
    const r = btn.getBoundingClientRect();
    if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
      if (btn.classList.contains('ts-fx-dwell-btn')) {
        hoveredKey  = btn.dataset.fx;
        hoveredType = 'fx';
      } else if (btn.classList.contains('jp-head-btn') || btn._jPatternCode !== undefined) {
        // JPatternButton: dwell toggles its snippet in the shared metaprogram.
        hoveredKey  = btn.dataset.jpatternCode ?? btn._jPatternCode;
        hoveredType = 'jpattern';
      } else if (btn.classList.contains('ts-dwell-btn')) {
        hoveredKey  = btn.id || btn.dataset.dwellId || btn.textContent.trim().slice(0, 20);
        hoveredType = 'action';
      } else {
        continue;
      }
      hoveredEl = btn;
      break;
    }
  }

  // Nothing Trussal-owned under the cursor → fall back to any plain control on
  // the page (Jitsi's toolbar/menus/panes included). Keep the LAST match under
  // the point so an inner control wins over its wrapper. Rects are the ones
  // cached by _genericDwellEls on its throttle, not fresh per-frame reads.
  if (!hoveredEl) {
    for (const { el, r } of _genericDwellEls(ts)) {
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
        hoveredKey  = el;   // element identity is the dwell key
        hoveredType = 'native';
        hoveredEl   = el;
      }
    }
  }

  const now = performance.now();
  if (hoveredKey !== _dwell.key || hoveredType !== _dwell.type) {
    if (_dwell.el) {
      _dwell.el.classList.remove('strudel-dwell-hover', 'trussal-hc-dwell');
      if (_dwell.type === 'action') _dwell.el.style.removeProperty('--dwell-prog');
    }
    _dwell.key     = hoveredKey;
    _dwell.type    = hoveredType;
    _dwell.el      = hoveredEl;
    _dwell.startMs = hoveredKey ? now : 0;
    _dwell.fired   = false;
    if (_progressRing) _progressRing.style.strokeDashoffset = RING_C.toFixed(2);
  }

  if (hoveredKey && !_dwell.fired) {
    const progress = Math.min((now - _dwell.startMs) / DWELL_MS, 1);
    if (_dwell.el) {
      _dwell.el.classList.add(_dwell.type === 'native' ? 'trussal-hc-dwell' : 'strudel-dwell-hover');
      if (_dwell.type === 'action') _dwell.el.style.setProperty('--dwell-prog', progress.toFixed(3));
    }
    if (_progressRing) _progressRing.style.strokeDashoffset = (RING_C * (1 - progress)).toFixed(2);
    if (progress >= 1) {
      _dwell.fired = true;
      if (_dwell.el) {
        _dwell.el.classList.remove('strudel-dwell-hover', 'trussal-hc-dwell');
        _dwell.el.classList.add('strudel-btn-active');
        if (_dwell.type === 'action') _dwell.el.style.removeProperty('--dwell-prog');
        setTimeout(() => _dwell.el?.classList.remove('strudel-btn-active'), 600);
      }
      if (_progressRing) _progressRing.style.strokeDashoffset = RING_C.toFixed(2);
      if (_dwell.type === 'fx') {
        _toggleFxEffect(_dwell.key);
      } else if (_dwell.type === 'jpattern') {
        toggleJPatternButtonCode(_dwell.key);
      } else if (_dwell.type === 'action') {
        if (_dwell.el) _dwell.el.click();
      } else if (_dwell.type === 'native') {
        if (_dwell.el && _dwell.el.isConnected) {
          try { _dwell.el.focus({ preventScroll: true }); } catch {}
          _dwell.el.click();
        }
      }
    }
  }

  _rafId = requestAnimationFrame(_detectionLoop);
}

// ---------------------------------------------------------------------------
// Head-cursor caret follow — hovering a .ts-code editor focuses it and moves
// the insertion point to the character under the cursor. Focus is then held on
// that editor even after the cursor moves off (so the performer can type on the
// on-screen keyboard); a thumbs-down freezes the caret until the next
// thumbs-down (_caretLocked, set in _runAction).
//
// The same follow targets the two Jitsi-native name fields that live OUTSIDE
// a meeting: the prejoin screen's display-name input (#premeeting-name-input)
// and the lobby knock screen's name field (#lobby-name-field) — otherwise a
// performer using only the head cursor + on-screen keyboard (no physical
// mouse/keyboard) can never get into a room at all. Never both at once with
// the .ts-code editors: Studio only mounts in a meeting, which is exactly
// when neither of those screens exists.
// ---------------------------------------------------------------------------
function _isEditable(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || el.isContentEditable === true;
}

// The Studio code editors (in a meeting) plus the three single-line fields a
// hands-free performer meets before one: the welcome overlay's room-name box
// (#trussal-room-input — Trussal's own, not Jitsi's), the prejoin display-name
// input (#premeeting-name-input) and the lobby knock name field
// (#lobby-name-field). Only one screen is ever mounted at a time.
function _caretFollowCandidates() {
  const targets = Array.from(document.querySelectorAll('#trussal-studio-overlay textarea.ts-code'));
  for (const id of ['trussal-room-input', 'premeeting-name-input', 'lobby-name-field']) {
    const el = document.getElementById(id);
    if (el) targets.push(el);
  }
  return targets;
}

// Outline whichever field the head cursor is holding focus on, and only that
// one. Jitsi's inputs suppress the native focus ring, so without this a
// hands-free performer gets no feedback that a field is armed for the keyboard.
function _setHcFocus(el) {
  if (_hcFocusEl && _hcFocusEl !== el) _hcFocusEl.classList.remove('trussal-hc-focus');
  _hcFocusEl = el || null;
  // Re-assert every call, not just on change: React may strip an
  // externally-added class on a re-render of a field it controls.
  if (_hcFocusEl && !_hcFocusEl.classList.contains('trussal-hc-focus')) {
    _hcFocusEl.classList.add('trussal-hc-focus');
  }
}

function _followEditorCaret(cx, cy) {
  if (_stickyEditor && !_stickyEditor.isConnected) _stickyEditor = null;
  if (!_stickyEditor) _setHcFocus(null);
  if (_stickyEditor && document.activeElement !== _stickyEditor &&
      !_isEditable(document.activeElement)) {
    _stickyEditor.focus({ preventScroll: true });
  }

  let over = null;
  for (const ta of _caretFollowCandidates()) {
    const r = ta.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 &&
        cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
      over = ta;
      break;
    }
  }
  if (!over) { _caretEl = null; return; }

  if (document.activeElement !== over) over.focus({ preventScroll: true });
  _stickyEditor = over;
  // Outline only the plain single-line fields (welcome / prejoin / lobby):
  // the Studio .ts-code editors carry their own focus styling in a meeting,
  // so leave that path visually untouched.
  _setHcFocus(over.classList.contains('ts-code') ? null : over);

  if (_caretLocked) return;

  if (over === _caretEl &&
      Math.abs(cx - _caretAppliedAt.x) < 6 &&
      Math.abs(cy - _caretAppliedAt.y) < 6) return;

  const pos = typeof document.caretPositionFromPoint === 'function'
    ? document.caretPositionFromPoint(cx, cy)
    : null;
  if (pos && pos.offsetNode === over && Number.isFinite(pos.offset)) {
    const i = Math.max(0, Math.min(over.value.length, pos.offset));
    try { over.setSelectionRange(i, i); } catch {}
  }
  _caretEl        = over;
  _caretAppliedAt = { x: cx, y: cy };
}

function _toggleFxEffect(fxName) {
  const peer = getLocalPeer();
  if (!peer) return;
  const e = peer.effects || {};
  sendLocalEffects({ distortion: !!e.distortion, noise: !!e.noise, reverb: !!e.reverb, [fxName]: !e[fxName] });
}

// ---------------------------------------------------------------------------
// Camera lifecycle.
// ---------------------------------------------------------------------------
function _syncHydraShare() {
  // Only lend the camera to Hydra's `s0` inside a meeting — setVideoStream()
  // builds the Hydra split panel, which has no place on the welcome/prejoin
  // screens the watcher also runs on.
  const want = !!(_stream && (_headCursor || _gestures) && document.getElementById('largeVideoContainer'));
  if (want && !_sharedWithHydra) { setVideoStream(_stream); _sharedWithHydra = true; }
  else if (!want && _sharedWithHydra) { setVideoStream(null); _sharedWithHydra = false; }
}

async function _startCamera() {
  if (_cameraOn || _cameraStarting) return _cameraOn;
  _cameraStarting = true;
  _explicitlyStopped = false;
  _setStatus('loading');
  try {
    // Re-use the graphs across a re-acquire (device handed to the meeting, then
    // handed back): re-creating them leaks the old pair and re-downloads the
    // WASM. Only build them the first time / after an explicit stopFacial().
    if (!_landmarker || !_gestureRecognizer) {
      const { FaceLandmarker, GestureRecognizer, FilesetResolver, DrawingUtils } = await import(MP_ESM);
      _mpClasses = { FaceLandmarker, DrawingUtils };

      const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
      [_landmarker, _gestureRecognizer] = await Promise.all([
        FaceLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
          outputFaceBlendshapes: true,
          runningMode: 'VIDEO',
          numFaces: 1,
        }),
        GestureRecognizer.createFromOptions(vision, {
          baseOptions: { modelAssetPath: GESTURE_MODEL_URL, delegate: 'GPU' },
          runningMode: 'VIDEO',
          numHands: 1,
        }),
      ]);
    }

    // The REAL camera: face tracking needs the performer's face. A plain
    // getUserMedia would be intercepted by the published-video override and
    // return the canvas the ROOM sees.
    _stream = await openCamera({ video: { width: 320, height: 240 } });
    if (_videoEl) {
      _videoEl.srcObject = _stream;
      await _videoEl.play();
    }
    // If the OS ends this track (a meeting grabs the device), the watchdog
    // re-acquires within ~1.5s — flip _cameraOn so it knows to.
    for (const t of _stream.getTracks()) {
      t.addEventListener('ended', () => { _cameraOn = false; }, { once: true });
    }

    _cameraOn = true;
    _cameraBlocked = false;
    _syncHydraShare();
    _setStatus('ready');
    if (_rafId) cancelAnimationFrame(_rafId); // collapse any idling prior loop
    _rafId = requestAnimationFrame(_detectionLoop);
    return true;
  } catch (e) {
    console.error('[facial-gesture]', e);
    _cameraBlocked = true;
    _setStatus('error');
    return false;
  } finally {
    _cameraStarting = false;
  }
}

function _stopCamera() {
  _explicitlyStopped = true; // the keep-alive watchdog stands down until _startCamera()
  cancelAnimationFrame(_rafId);  _rafId = null;
  if (_sharedWithHydra) { setVideoStream(null); _sharedWithHydra = false; }
  _stream?.getTracks().forEach((t) => t.stop());  _stream = null;
  _landmarker?.close();        _landmarker        = null;
  _gestureRecognizer?.close(); _gestureRecognizer = null;
  _mpClasses    = null;
  _drawingUtils = null;
  _cameraOn = false;
  _headCursor = false;
  _gestures = false;
  _leftEyeClosedSince = 0;
  _leftEyeOpenGraceUntil = 0;
  Object.assign(_ema, {
    jawOpen: 0, browInnerUp: 0, headTilt: 0, headYaw: 0,
    mouthSmileLeft: 0, mouthSmileRight: 0,
    eyeBlinkLeft: 0, eyeBlinkRight: 0,
    cursorX: window.innerWidth / 2, cursorY: window.innerHeight / 2,
  });
  Object.assign(_latch, {
    headLeft: false, headRight: false, leftBlink: false, browRaise: false,
    smile: false, thumbsUp: false, thumbsDown: false,
    mouthOpen: false, leftEyeClosed2s: false,
  });
  _stickyEditor = null;
  _caretLocked  = false;
  _caretEl      = null;
  _setHcFocus(null);
  if (_cursorEl) _cursorEl.style.display = 'none';
  _syncPanelVisibility();
  _setStatus('idle');
}

// Height stashed while the panel is collapsed to its drag handle, restored on
// expand — so a head/mouse-resized panel doesn't leave a tall empty shell.
let _savedFgHeight = '';

// ---------------------------------------------------------------------------
// DOM — styles, cursor overlay, and the face-mesh panel.
// ---------------------------------------------------------------------------
const FG_STYLE_ID  = 'trussal-fg-style';
const FG_PANEL_ID  = 'trussal-fg-panel';
const FG_CURSOR_ID = 'trussal-fg-cursor';

function _injectStyles() {
  if (document.getElementById(FG_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = FG_STYLE_ID;
  s.textContent = `
    #${FG_CURSOR_ID} {
      position:fixed; pointer-events:none; z-index:9999999;
      transform:translate(-50%,-50%); display:none;
    }
    #${FG_PANEL_ID} {
      position:fixed; top:64px; left:16px;
      z-index:1000000;
      background:#eeeeee; color:#111111;
      border:1px solid #111111; border-radius:10px;
      font-family:Arial, Helvetica, sans-serif; font-size:12px;
      padding:10px 12px; width:220px;
      min-width:200px; min-height:200px;
      max-width: calc(100vw - 20px); max-height: calc(100vh - 20px);
      overflow: hidden;
      display:none; flex-direction:column; gap:8px;
      box-shadow:0 8px 24px rgba(0,0,0,0.2); user-select:none;
    }
    #${FG_PANEL_ID}.fg-collapsed { min-height:0; height:auto; }
    #${FG_PANEL_ID} #trussal-fg-body { flex:1 1 auto; min-height:0; overflow-y:auto; }
    #${FG_PANEL_ID} .fg-drag-handle {
      cursor:grab; margin:-10px -12px 0; padding:8px 12px 6px;
      border-radius:10px 10px 0 0; flex:0 0 auto;
    }
    #${FG_PANEL_ID} .fg-drag-handle:active { cursor:grabbing; }
    #${FG_PANEL_ID} .fg-drag-handle button { position:relative; z-index:21; }
    #${FG_PANEL_ID} .fg-row { display:flex; align-items:center; justify-content:space-between; }
    #${FG_PANEL_ID} .fg-title { font-weight:600; color:#111111; }
    #${FG_PANEL_ID} .fg-video-wrap { position:relative; width:100%; }
    #${FG_PANEL_ID} video { width:100%; border-radius:4px; display:block; transform:scaleX(-1); }
    #${FG_PANEL_ID} canvas {
      position:absolute; inset:0; width:100%; height:100%;
      border-radius:4px; pointer-events:none; transform:scaleX(-1);
    }
    #${FG_PANEL_ID} .fg-flash {
      font-size:11px; font-weight:600; text-align:center;
      color:#111111; opacity:0; transition:opacity 0.15s; min-height:1.2em;
      font-family:monospace;
    }

    #trussal-fg-toggle {
      background:#eeeeee; border:1px solid #111111;
      cursor:pointer; padding:3px 8px; border-radius:4px; color:#111111;
      transition:color 0.15s, background 0.15s, border-color 0.15s;
      line-height:1; display:flex; align-items:center; gap:4px;
      font-size:11px; font-family:Arial, Helvetica, sans-serif; white-space:nowrap;
    }
    #trussal-fg-toggle:hover { color:#eeeeee; background:#111111; }
    #trussal-fg-toggle.on    { color:#eeeeee; background:#111111; border-color:#111111; }

    /* Head-cursor feedback on plain (non-Trussal) controls: the field it is
       holding focus on, and the button/link it is currently dwelling. Jitsi's
       own inputs and buttons suppress the focus ring, so state this loudly.
       !important — these sit over Emotion class styles on the prejoin. */
    .trussal-hc-focus {
      outline: 2px solid #111111 !important;
      outline-offset: 1px !important;
      border-radius: 2px;
    }
    .trussal-hc-dwell {
      outline: 2px solid #111111 !important;
      outline-offset: 2px !important;
      background: rgba(17,17,17,0.06) !important;
    }

    .ts-dwell-btn {
      background: #eeeeee;
      border: 1px solid #111111;
      color: #111111;
      cursor: pointer;
      border-radius: 4px;
      padding: 2px 7px;
      font-size: 10px;
      line-height: 1.5;
      font-family: Arial, Helvetica, sans-serif;
      position: relative;
      overflow: hidden;
      transition: background 0.1s, color 0.1s, border-color 0.1s;
    }
    .ts-dwell-btn:hover { background: #111111; color: #eeeeee; }
    .ts-dwell-btn.strudel-dwell-hover { border-color: #111111; }
    .ts-dwell-btn.strudel-btn-active  { border-color: #111111; background: #111111; color: #eeeeee; }
    .ts-dwell-btn::after {
      content: '';
      position: absolute;
      bottom: 0; left: 0;
      width: 100%;
      height: calc(var(--dwell-prog, 0) * 100%);
      background: rgba(17,17,17,0.28);
      pointer-events: none;
    }
  `;
  document.head.appendChild(s);
}

function _ensureDOM() {
  if (document.getElementById(FG_PANEL_ID)) return;
  _injectStyles();
  initStrudelButton();

  // Head cursor overlay.
  const cursor = document.createElement('div');
  cursor.id = FG_CURSOR_ID;
  cursor.innerHTML = `
    <svg width="${RING_R*2+8}" height="${RING_R*2+8}"
         viewBox="0 0 ${RING_R*2+8} ${RING_R*2+8}">
      <circle cx="${RING_R+4}" cy="${RING_R+4}" r="4"
              fill="#111111"/>
      <circle id="trussal-fg-ring"
        cx="${RING_R+4}" cy="${RING_R+4}" r="${RING_R}"
        fill="none" stroke="#111111" stroke-width="2.5" stroke-linecap="round"
        stroke-dasharray="${RING_C.toFixed(2)} ${RING_C.toFixed(2)}"
        stroke-dashoffset="${RING_C.toFixed(2)}"
        transform="rotate(-90 ${RING_R+4} ${RING_R+4})"/>
    </svg>`;
  document.body.appendChild(cursor);
  _cursorEl    = cursor;
  _progressRing = cursor.querySelector('#trussal-fg-ring');

  // Face-mesh panel — the live landmark stream and a one-line readout of the
  // gesture that last fired. Everything that used to configure the gesture map
  // is set from code now (gestureAndLandmarkConfig).
  const panel = document.createElement('div');
  panel.id = FG_PANEL_ID;
  panel.innerHTML = `
    <div class="fg-row fg-drag-handle">
      <span class="fg-title">facial control</span>
      <button class="ts-dwell-btn" id="trussal-fg-collapse" title="Collapse / expand panel">▼</button>
      <span id="trussal-fg-status" style="font-size:11px;">idle</span>
    </div>
    <div id="trussal-fg-body">
      <div class="fg-video-wrap">
        <video id="trussal-fg-video" muted playsinline></video>
        <canvas id="trussal-fg-canvas"></canvas>
      </div>
      <div class="fg-flash" id="trussal-fg-flash"></div>
    </div>
  `;
  document.body.appendChild(panel);
  _videoEl   = panel.querySelector('#trussal-fg-video');
  _canvasEl  = panel.querySelector('#trussal-fg-canvas');
  _statusEl  = panel.querySelector('#trussal-fg-status');
  _flashEl   = panel.querySelector('#trussal-fg-flash');

  const fgCollapseBtn = panel.querySelector('#trussal-fg-collapse');
  if (fgCollapseBtn) {
    fgCollapseBtn.addEventListener('click', () => {
      const body = panel.querySelector('#trussal-fg-body');
      if (!body) return;
      const collapsed = body.style.display === 'none';
      body.style.display    = collapsed ? '' : 'none';
      fgCollapseBtn.textContent = collapsed ? '▼' : '▲';
      panel.classList.toggle('fg-collapsed', !collapsed);
      if (!collapsed) { _savedFgHeight = panel.style.height; panel.style.height = ''; }
      else { panel.style.height = _savedFgHeight; }
    });
  }

  // Move it by the handle (mouse) or the ✥ / ⇲ handle buttons (head cursor),
  // and resize it from any corner — same window behaviour as the keyboard.
  attachPanelControls(panel, {
    handle: panel.querySelector('.fg-drag-handle'),
    minW: 200,
    minH: 200,
  });
}

function _syncPanelVisibility() {
  const panel = document.getElementById(FG_PANEL_ID);
  if (panel) panel.style.display = (_headCursor || _gestures) ? 'flex' : 'none';
}

function _ensureCameraRunning() {
  if (_cameraOn || _cameraStarting) return;
  try { _ensureDOM(); } catch (e) { console.error('[facial-gesture] panel init failed', e); }
  _startCamera();
}

// ---------------------------------------------------------------------------
// Keep-alive watchdog.
//
// The watch has to outlive every screen change with no visible restart:
//  • Trussal's welcome overlay enters a room with a full `window.location.href`
//    navigation (welcome-page.js) — a hard reload. sessionStorage in
//    landmark-gesture-mode.js carries the *enabled* state across it; this
//    brings the camera back up on the far side without a re-wink.
//  • Jitsi re-mounts large DOM subtrees on the prejoin→meeting transition, and
//    the OS can end the getUserMedia track when the meeting claims the device.
//
// So every 1.5s: rebuild the panel if it was dropped, re-bind the stream if the
// panel was rebuilt under a live one, and re-acquire the camera if its track
// ended. All of it no-ops in the common case. Stands down after stopFacial().
let _watchdogTimer = null;
function _startWatchdog() {
  if (_watchdogTimer || typeof window === 'undefined') return;
  if (window.__trussalIsBot || window.__trussalIsAggregator) return;
  _watchdogTimer = setInterval(_healWatch, 1500);
}
function _healWatch() {
  if (_explicitlyStopped) return;
  if (!document.getElementById(FG_PANEL_ID) || !document.getElementById(FG_CURSOR_ID)) {
    try { _ensureDOM(); } catch (e) { console.error('[facial-gesture] panel re-init failed', e); }
  }
  const track = _stream && _stream.getVideoTracks()[0];
  const dead  = !_stream || !track || track.readyState === 'ended';
  const now   = (typeof performance !== 'undefined' ? performance : Date).now();
  if (dead && !_cameraStarting && now - _camRetryAt > (_cameraBlocked ? 8000 : 1200)) {
    _camRetryAt = now;
    _cameraOn = false;          // _startCamera() bails unless this is false
    _startCamera();
  } else if (!dead && _videoEl && _videoEl.srcObject !== _stream) {
    _videoEl.srcObject = _stream;   // panel was rebuilt around a live stream
    _videoEl.play().catch(() => {});
  }
  _syncPanelVisibility();
  _syncHydraShare();
}

// ---------------------------------------------------------------------------
// Public API.
// ---------------------------------------------------------------------------

/**
 * Start MediaPipe in its watch-only state: the face landmarker runs, but the
 * only gesture that does anything is whichever one maps to
 * `enable-landmark-gesture-mode`. Idempotent. Resolves to true once the camera
 * is live, false if getUserMedia / the model download failed. Also arms the
 * keep-alive watchdog so the watch survives every later screen change.
 */
export function startFacialWatch() {
  try { _ensureDOM(); } catch (e) { console.error('[facial-gesture] panel init failed', e); }
  _startWatchdog();
  return _startCamera();
}

/** Hard stop — release the camera and tear the detector down. */
export function stopFacial() {
  _stopCamera();
}

/** Turn the head cursor + dwell on/off. Starts the camera if it needs to. */
export function setHeadCursorEnabled(on) {
  _headCursor = !!on;
  if (_headCursor) {
    _ensureCameraRunning();
  } else {
    if (_cursorEl) _cursorEl.style.display = 'none';
    // The detection loop stops running its head-cursor block the moment
    // _headCursor is false, so it never gets to tidy these up itself.
    _setHcFocus(null);
    if (_dwell.el) _dwell.el.classList.remove('strudel-dwell-hover', 'trussal-hc-dwell');
    _dwell.key = null; _dwell.type = null; _dwell.el = null; _dwell.fired = false;
  }
  _syncPanelVisibility();
  _syncHydraShare();
}

/**
 * Turn gesture ACTIONS on/off. With this off, a detected gesture can still only
 * run `enable-landmark-gesture-mode` (see _dispatchTrigger). Starts the camera
 * if it needs to.
 */
export function setGestureDetectionEnabled(on) {
  _gestures = !!on;
  if (_gestures) _ensureCameraRunning();
  _syncPanelVisibility();
  _syncHydraShare();
}

export function isGestureDetectionEnabled() { return _gestures; }

/** Replace the whole gesture map. A non-array resets to the defaults. */
export function setGestureMappings(list) {
  _gestureMappings = Array.isArray(list)
    ? list.map((m) => ({ ...m }))
    : DEFAULT_GESTURE_MAPPINGS.map((m) => ({ ...m }));
}

/** Snapshot of the live gesture config, for gestureAndLandmarkConfig's return. */
export function getGestureConfig() {
  return {
    gestureMappings: _gestureMappings.map((m) => ({ ...m })),
    headCursorEnabled: _headCursor,
    gestureDetectionEnabled: _gestures,
  };
}

/** True once getUserMedia / the model download has failed — the enable paths
 *  that don't need a camera (Right Arrow, the ☰ menu) still work. */
export function isCameraBlocked() { return _cameraBlocked; }

/**
 * Whether the MediaPipe head cursor is currently switched on. The on-screen
 * keyboard gates its autopredict row on this — picking a suggestion is a
 * head-cursor dwell, so with no head cursor the row is unpickable noise.
 */
export function isHeadCursorEnabled() {
  return _headCursor;
}

/**
 * Inject the "Face" toggle into the studio header. It now just flips Landmark
 * and Gesture Mode (keyboard + head cursor + gesture actions) via the shared
 * event, and mirrors the mode's on/off state.
 * Called once from ensureOverlay() in studio.js.
 */
export function injectFacialGestureToggle(headerEl) {
  const btn = document.createElement('button');
  btn.id    = 'trussal-fg-toggle';
  btn.title = 'Toggle Landmark and Gesture Mode (keyboard + head cursor + face gestures)';
  btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="currentColor" width="13" height="13" aria-hidden="true">
    <path d="M12 9a3.75 3.75 0 1 0 0 7.5A3.75 3.75 0 0 0 12 9Z"/>
    <path fill-rule="evenodd" d="M9.344 3.071a49.52 49.52 0 0 1 5.312 0c.967.052
      1.83.585 2.332 1.39l.821 1.317c.24.383.645.643 1.11.71.386.054.77.113
      1.152.177 1.432.239 2.429 1.493 2.429 2.909V18a3 3 0 0 1-3 3h-15a3 3 0
      0 1-3-3V9.574c0-1.416.997-2.67 2.429-2.909.382-.064.766-.123
      1.151-.178a1.56 1.56 0 0 0 1.11-.71l.822-1.315a2.942 2.942 0 0 1
      2.332-1.39ZM6.75 12.75a5.25 5.25 0 1 1 10.5 0 5.25 5.25 0 0 1-10.5
      0Zm12-1.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z" clip-rule="evenodd"/>
  </svg>Face`;

  btn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('trussal-landmark-gesture-mode', {
      detail: { toggle: true, source: 'studio-face-button' },
    }));
  });
  document.addEventListener('trussal-landmark-gesture-mode-changed', (e) => {
    btn.classList.toggle('on', !!(e.detail && e.detail.on));
  });

  // Insert before the close button.
  const closeBtn = headerEl.querySelector('.ts-close');
  headerEl.insertBefore(btn, closeBtn);
}

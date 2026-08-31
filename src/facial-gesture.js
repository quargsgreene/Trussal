/*
facial-gesture.js — MediaPipe head-cursor and gestural metaprogramming for Trussal.

Ports useFacialGestures.jsx, FacialGestureControl.jsx, and strudelButton.mjs from
the strudel-fork into Trussal's vanilla-JS context.  All strudel-fork behaviour is
preserved; the only adaptation is that the "editor" is Trussal's textarea (.ts-code)
and peer-state bus rather than a CodeMirror REPL.

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
  activeEditorKind
} from './editor-router.js';
import { parseJPatternButtons } from './editor-router-core.js';
import { attachPanelControls, isHeadDragActive } from './panel-drag-resize.js';

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
const EMA_ALPHA            = 0.15;
const LATCH_RESET          = 0.4;
const DWELL_MS             = 1000;

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

  // JPatternButton — same shape, but its code targets the shared
  // metaprogram doc: dwell toggles the snippet in the JPattern editor and
  // re-applies the program (see toggleJPatternButtonCode).
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

// The dwell bar shows the FOCUSED editor's buttons, and a dwell writes to
// whichever editor is focused — so a bar left holding the other editor's
// buttons is not a stale label, it is a Strudel voice written into the shared
// metaprogram. Rebuild it the moment focus moves; the rebuild is a no-op when
// the buttons come out the same.
if (typeof document !== 'undefined') {
  document.addEventListener('focusin', (e) => {
    refreshFacialGestureButtons();
    // Any focused code editor becomes the one the head cursor holds focus on
    // when the cursor later moves off to the on-screen keyboard — regardless
    // of whether it was the head cursor, a click, or Tab that focused it.
    if (e.target?.classList?.contains('ts-code')) _stickyEditor = e.target;
  });
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
const BTN_MARKER = ' // strudel-btn';

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

export function toggleButtonCode(code) {
  const cur = getCode();
  const active    = `\n${code}${BTN_MARKER}`;
  const commented = `\n// ${code}${BTN_MARKER}`;
  let next;
  if      (cur.includes(commented)) next = cur.replace(commented, active);
  else if (cur.includes(active))    next = cur.replace(active, commented);
  else                              next = cur + active;
  setCode(next);
  evaluate();
}

function makeGestureHandler(triggerName, defaultMutator) {
  return async () => {
    const code = getCode();
    const configs = parseMediapipeConfigs(code);
    let ran = false;
    for (const cfg of configs) {
      if (cfg.trigger === triggerName && cfg.action === 'regex-swap' && cfg.regex) {
        await mutateAndEvaluate((c) => applyRegexMutation(c, cfg.regex, cfg.replacement));
        ran = true;
      }
      // Personal metapattern control by gesture: stop/start/apply the shared
      // metaprogram via the same latch/cooldown machinery.
      if (cfg.trigger === triggerName && cfg.action === 'apply-metaprogram') {
        applyMetaprogramNow();
        ran = true;
      }
    }
    // Also check the live regex mutator UI state (mirrors FacialGestureControl.jsx).
    if (_regexTrigger === triggerName && _regexPattern) {
      await mutateAndEvaluate((c) => applyRegexMutation(c, _regexPattern, _regexReplacement));
      ran = true;
    }
    if (!ran) await mutateAndEvaluate(defaultMutator);
  };
}

let _headTiltDelta = 2; // semitones per tilt; user-adjustable from the panel

const handleBrowRaise    = makeGestureHandler('browRaise',    cycleHiHat);
const handleHeadTiltLeft = makeGestureHandler('headTiltLeft',  (c) => shiftTranspose(c, -_headTiltDelta));
const handleHeadTiltRight= makeGestureHandler('headTiltRight', (c) => shiftTranspose(c,  _headTiltDelta));

// ---------------------------------------------------------------------------
// MediaPipe detection state.
// ---------------------------------------------------------------------------
let _enabled           = false;
let _landmarker        = null;
let _gestureRecognizer = null;
let _mpClasses         = null;
let _drawingUtils  = null;
let _stream        = null;
let _rafId         = null;

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
const _latch      = { headLeft: false, headRight: false, leftBlink: false, browRaise: false, smile: false, thumbsUp: false, thumbsDown: false };
// _dwell.type: 'strudel' | 'fx' | null.  key is strudelCode or fx name.
const _dwell      = { key: null, type: null, el: null, startMs: 0, fired: false };
// What the dwell bar currently shows, so an unchanged rebuild is skipped.
let _barKey = null;

// Head-cursor editor targeting (see _followEditorCaret):
//  • _stickyEditor stays focused after the head cursor leaves it, so the
//    performer can move off to the on-screen keyboard and keep typing there.
//  • _caretLocked is a thumbs-down freeze — while set, the head cursor no
//    longer moves the editor's blinking caret (another thumbs-down clears it).
//    Local to this browser; nothing about it is broadcast.
//  • _caretEl / _caretAppliedAt back the anti-jitter travel threshold.
let _stickyEditor   = null;
let _caretLocked    = false;
let _caretEl        = null;
let _caretAppliedAt = { x: -Infinity, y: -Infinity };

// Dwell-hoverable elements, refreshed on a throttle rather than re-querying the
// whole document every animation frame (60fps) — the query itself (a five-part
// compound selector walking the full tree) is the expensive part, not the
// getBoundingClientRect() check against a handful of cached candidates.
const DWELL_TARGETS_REFRESH_MS = 300;
let _dwellCandidates = [];
let _dwellCandidatesAt = -Infinity;
function _dwellCandidateEls(now) {
  if (now - _dwellCandidatesAt >= DWELL_TARGETS_REFRESH_MS) {
    _dwellCandidatesAt = now;
    _dwellCandidates = Array.from(document.querySelectorAll(
      '.strudel-head-btn, .ts-fx-dwell-btn, .ts-dwell-btn, .jp-head-btn, button[is="j-pattern-button"]'
    ));
  }
  return _dwellCandidates;
}

// Regex mutator UI state — mirrors FacialGestureControl.jsx's useState for
// triggerGesture / regex / replacement.
let _regexTrigger      = 'mouthOpen';
let _regexPattern      = '';
let _regexReplacement  = '';

function _flash(gesture) {
  if (!_flashEl) return;
  const labels = {
    play:          '▶ play (smile)',
    stop:          '■ stop (thumbs up)',
    eval:          '↺ update (left blink)',
    drumDensity:   '◎ drum density (brow raise)',
    headTiltLeft:  `← tilt left → −${_headTiltDelta}st`,
    headTiltRight: `→ tilt right → +${_headTiltDelta}st`,
    caretLock:     '🔒 caret locked (thumbs down)',
    caretUnlock:   '🔓 caret unlocked (thumbs down)',
  };
  _flashEl.textContent = labels[gesture] ?? gesture;
  _flashEl.style.opacity = '1';
  clearTimeout(_flashTimeout);
  _flashTimeout = setTimeout(() => { if (_flashEl) _flashEl.style.opacity = '0'; }, 800);
}

function _setStatus(s) {
  if (!_statusEl) return;
  // Flat theme: the status word itself ("ready" / "error" / …) carries the
  // meaning, so every state is the same #111111 rather than a colour.
  _statusEl.textContent = s;
  _statusEl.style.color = '#111111';
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
    // tilt: vertical difference between eye corners (head roll)
    const tiltRaw    = (landmarks[33].y - landmarks[263].y) / eyeDistX;
    // yaw: nose tip (landmark 4) offset from eye midpoint, normalized by eye width
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
  _processGestures(blendshapes, gestureResult);
}

function _processGestures(blendshapes, gestureResult) {
  const score        = (name) => blendshapes.find((c) => c.categoryName === name)?.score ?? 0;
  const eyeBlinkL    = score('eyeBlinkLeft');
  const eyeBlinkR    = score('eyeBlinkRight');
  const mouthSmileL  = score('mouthSmileLeft');
  const mouthSmileR  = score('mouthSmileRight');
  const browInnerUp  = score('browInnerUp');
  const browOuterL   = score('browOuterUpLeft');
  const browOuterR   = score('browOuterUpRight');

  // Left blink: left eye clearly closed, right clearly open.
  // The < 0.3 guard ensures double-blink never fires this. Right blink is unmapped.
  const isLeftBlink = eyeBlinkL > WINK_THRESHOLD && eyeBlinkR < 0.3;

  // play — bilateral smile, guarded against head-turn false positives:
  // • both sides must exceed threshold (real smile)
  // • left/right scores must agree within SMILE_ASYMMETRY_MAX (perspective artifacts are lopsided)
  // • head yaw must be small (turning to move the cursor lifts mouth corners via foreshortening)
  const isSmile = mouthSmileL > SMILE_THRESHOLD &&
                  mouthSmileR > SMILE_THRESHOLD &&
                  Math.abs(mouthSmileL - mouthSmileR) < SMILE_ASYMMETRY_MAX &&
                  Math.abs(_ema.headYaw) < HEAD_YAW_THRESHOLD;
  if (isSmile && !_latch.smile) {
    _latch.smile = true;
    _flash('play');
    bootStrudelOnUserGesture().then(() => sendLocalPlaying(true)).catch(() => {});
  }
  if (_latch.smile && mouthSmileL < SMILE_THRESHOLD * LATCH_RESET && mouthSmileR < SMILE_THRESHOLD * LATCH_RESET) {
    _latch.smile = false;
  }

  // stop — thumbs up hand gesture (GestureRecognizer)
  const topGesture   = gestureResult?.gestures?.[0]?.[0];
  const isThumbsUp   = topGesture?.categoryName === 'Thumb_Up' && topGesture.score > THUMBS_UP_THRESHOLD;
  if (isThumbsUp && !_latch.thumbsUp) {
    _latch.thumbsUp = true;
    _flash('stop');
    stopStrudel().then(() => sendLocalPlaying(false)).catch(() => {});
  }
  if (_latch.thumbsUp && !isThumbsUp) {
    _latch.thumbsUp = false;
  }

  // caret lock — thumbs down toggles whether the head cursor may move the
  // focused editor's blinking caret (see _followEditorCaret). Local to this
  // browser; nothing about it is broadcast to other participants.
  const isThumbsDown = topGesture?.categoryName === 'Thumb_Down' && topGesture.score > THUMBS_UP_THRESHOLD;
  if (isThumbsDown && !_latch.thumbsDown) {
    _latch.thumbsDown = true;
    _caretLocked = !_caretLocked;
    _flash(_caretLocked ? 'caretLock' : 'caretUnlock');
  }
  if (_latch.thumbsDown && !isThumbsDown) {
    _latch.thumbsDown = false;
  }

  // update/eval — left blink only (right blink and double-blink are unmapped)
  if (isLeftBlink && !_latch.leftBlink) {
    _latch.leftBlink = true;
    _flash('eval');
    evaluate();
  }
  if (_latch.leftBlink && eyeBlinkL < WINK_THRESHOLD * LATCH_RESET) {
    _latch.leftBlink = false;
  }

  // drum density — brow raise: inner brow up + at least one outer brow, eyes open
  const isBrowRaise =
    browInnerUp > BROW_INNER_THRESHOLD &&
    (browOuterL > BROW_OUTER_THRESHOLD || browOuterR > BROW_OUTER_THRESHOLD) &&
    eyeBlinkL < 0.3 && eyeBlinkR < 0.3;
  if (isBrowRaise && !_latch.browRaise) {
    _latch.browRaise = true;
    _flash('drumDensity');
    handleBrowRaise();
  }
  if (_latch.browRaise && !(browInnerUp > BROW_INNER_THRESHOLD * LATCH_RESET)) {
    _latch.browRaise = false;
  }

  const headTilt = _ema.headTilt;
  if (!_latch.headLeft && headTilt < -HEAD_TILT_THRESHOLD) {
    _latch.headLeft = true; _flash('headTiltLeft'); handleHeadTiltLeft();
  } else if (_latch.headLeft && headTilt > -HEAD_TILT_THRESHOLD * LATCH_RESET) {
    _latch.headLeft = false;
  }
  if (!_latch.headRight && headTilt > HEAD_TILT_THRESHOLD) {
    _latch.headRight = true; _flash('headTiltRight'); handleHeadTiltRight();
  } else if (_latch.headRight && headTilt < HEAD_TILT_THRESHOLD * LATCH_RESET) {
    _latch.headRight = false;
  }
}

function _drawLandmarks(result) {
  if (!_canvasEl || !_mpClasses || !_videoEl) return;
  if (_canvasEl.width  !== _videoEl.videoWidth)  _canvasEl.width  = _videoEl.videoWidth  || 320;
  if (_canvasEl.height !== _videoEl.videoHeight) _canvasEl.height = _videoEl.videoHeight || 240;
  const ctx = _canvasEl.getContext('2d');
  if (!_drawingUtils) _drawingUtils = new _mpClasses.DrawingUtils(ctx);
  ctx.clearRect(0, 0, _canvasEl.width, _canvasEl.height);
  if (!result.faceLandmarks?.length) return;
  const du = _drawingUtils;
  const FL = _mpClasses.FaceLandmarker;
  for (const lm of result.faceLandmarks) {
    du.drawConnectors(lm, FL.FACE_LANDMARKS_TESSELATION,   { color: '#C0C0C040', lineWidth: 0.5 });
    du.drawConnectors(lm, FL.FACE_LANDMARKS_RIGHT_EYE,     { color: '#FF3030',   lineWidth: 1 });
    du.drawConnectors(lm, FL.FACE_LANDMARKS_RIGHT_EYEBROW, { color: '#FF3030',   lineWidth: 1 });
    du.drawConnectors(lm, FL.FACE_LANDMARKS_LEFT_EYE,      { color: '#30FF30',   lineWidth: 1 });
    du.drawConnectors(lm, FL.FACE_LANDMARKS_LEFT_EYEBROW,  { color: '#30FF30',   lineWidth: 1 });
    du.drawConnectors(lm, FL.FACE_LANDMARKS_FACE_OVAL,     { color: '#E0E0E0',   lineWidth: 1 });
    du.drawConnectors(lm, FL.FACE_LANDMARKS_LIPS,          { color: '#E0E060',   lineWidth: 1 });
  }
}

let _densitySkip = 0;

function _detectionLoop() {
  if (!_videoEl || !_landmarker || _videoEl.readyState < 2) {
    _rafId = requestAnimationFrame(_detectionLoop);
    return;
  }

  // Room-health landmark-density scale-down: under load (RoomHealthService
  // sets window._jpLandmarkScale to 0.5 / 0.25) run detection on every 2nd /
  // 4th frame — the cursor EMA smooths over the gaps.
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

  // Move head cursor.
  if (_cursorEl) {
    _cursorEl.style.left    = `${_ema.cursorX}px`;
    _cursorEl.style.top     = `${_ema.cursorY}px`;
    _cursorEl.style.display = 'block';
  }

  // A panel is being flown around by the head cursor (panel-drag-resize.js).
  // Suppress our own dwell firing until it's dropped — otherwise the same hold
  // that steers the panel also toggles whatever button ends up under it. The
  // cursor above still tracks, and panel-drag-resize reads window.faceCtx.
  if (isHeadDragActive()) {
    if (_dwell.el) {
      _dwell.el.classList.remove('strudel-dwell-hover');
      if (_dwell.type === 'action') _dwell.el.style.removeProperty('--dwell-prog');
    }
    _dwell.key = null; _dwell.type = null; _dwell.el = null;
    _dwell.startMs = 0; _dwell.fired = false;
    if (_progressRing) _progressRing.style.strokeDashoffset = RING_C.toFixed(2);
    _rafId = requestAnimationFrame(_detectionLoop);
    return;
  }

  // Dwell detection over .strudel-head-btn, .ts-fx-dwell-btn, and .ts-dwell-btn elements.
  const cx = _ema.cursorX;
  const cy = _ema.cursorY;

  // Head cursor over a Studio code editor → make that textarea the focused
  // target and (unless the caret is thumbs-down locked) walk its blinking
  // caret to the character under the cursor. The editor then stays focused
  // even after the cursor leaves it, so the performer can move to the
  // on-screen keyboard and keep typing there.
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
        hoveredKey  = btn.dataset.strudelCode;
        hoveredType = 'strudel';
      }
      hoveredEl = btn;
      break;
    }
  }

  const now = performance.now();
  if (hoveredKey !== _dwell.key || hoveredType !== _dwell.type) {
    if (_dwell.el) {
      _dwell.el.classList.remove('strudel-dwell-hover');
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
      _dwell.el.classList.add('strudel-dwell-hover');
      if (_dwell.type === 'action') _dwell.el.style.setProperty('--dwell-prog', progress.toFixed(3));
    }
    if (_progressRing) _progressRing.style.strokeDashoffset = (RING_C * (1 - progress)).toFixed(2);
    if (progress >= 1) {
      _dwell.fired = true;
      if (_dwell.el) {
        _dwell.el.classList.remove('strudel-dwell-hover');
        _dwell.el.classList.add('strudel-btn-active');
        if (_dwell.type === 'action') _dwell.el.style.removeProperty('--dwell-prog');
        setTimeout(() => _dwell.el?.classList.remove('strudel-btn-active'), 600);
      }
      if (_progressRing) _progressRing.style.strokeDashoffset = RING_C.toFixed(2);
      if (_dwell.type === 'fx') {
        _toggleFxEffect(_dwell.key);
      } else if (_dwell.type === 'action') {
        if (_dwell.el) _dwell.el.click();
      } else if (_dwell.type === 'jpattern') {
        toggleJPatternButtonCode(_dwell.key);
      } else {
        toggleButtonCode(_dwell.key);
      }
    }
  }

  _rafId = requestAnimationFrame(_detectionLoop);
}

// ---------------------------------------------------------------------------
// Head-cursor caret follow — hovering a .ts-code editor (personal Strudel or
// the shared JPattern one, both carry the class) focuses it and moves the
// insertion point to the character under the cursor. Focus is then held on
// that editor even after the cursor moves off (so the performer can type on
// the on-screen keyboard); a thumbs-down freezes the caret until the next
// thumbs-down (_caretLocked, set in _processGestures).
// ---------------------------------------------------------------------------
function _isEditable(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'TEXTAREA' || tag === 'INPUT' || tag === 'SELECT' || el.isContentEditable === true;
}

function _followEditorCaret(cx, cy) {
  // Keep a head-cursor-focused editor focused after the cursor leaves it —
  // but only reclaim focus that was lost to nothing (a re-render, a click on
  // the empty page). Never yank it out of another field the user is in.
  if (_stickyEditor && !_stickyEditor.isConnected) _stickyEditor = null;
  if (_stickyEditor && document.activeElement !== _stickyEditor &&
      !_isEditable(document.activeElement)) {
    _stickyEditor.focus({ preventScroll: true });
  }

  let over = null;
  for (const ta of document.querySelectorAll('#trussal-studio-overlay textarea.ts-code')) {
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

  // Thumbs-down freeze: the head cursor still focuses the editor, but it no
  // longer moves the blinking caret — that stays wherever it was when the
  // gesture fired (and where the keyboard advances it as the performer types).
  if (_caretLocked) return;

  // Re-seat the caret only once the cursor has actually travelled: EMA jitter
  // of a "still" head must not keep yanking the insertion point away from
  // someone typing on the physical keyboard with the head cursor parked here.
  if (over === _caretEl &&
      Math.abs(cx - _caretAppliedAt.x) < 6 &&
      Math.abs(cy - _caretAppliedAt.y) < 6) return;

  // Blink hands back the textarea itself as offsetNode, with offset an index
  // into .value (verified Chrome 150, the deploy target). Without the API the
  // caret just stays put — focus still moved, so input still lands here.
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

async function _startCamera() {
  _setStatus('loading');
  try {
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

    // The REAL camera: face tracking needs the performer's face, and the
    // landmarks UI is one of the two places their camera is legitimately
    // visible. A plain getUserMedia would be intercepted by the
    // published-video override and return the canvas the ROOM sees.
    _stream = await openCamera({ video: { width: 320, height: 240 } });
    _videoEl.srcObject = _stream;
    await _videoEl.play();

    setVideoStream(_stream); // share with hydra-video
    _setStatus('ready');
    _rafId = requestAnimationFrame(_detectionLoop);
  } catch (e) {
    console.error('[facial-gesture]', e);
    _setStatus('error');
  }
}

function _stopCamera() {
  cancelAnimationFrame(_rafId);  _rafId = null;
  setVideoStream(null); // detach from hydra-video before stopping tracks
  _stream?.getTracks().forEach((t) => t.stop());  _stream = null;
  _landmarker?.close();        _landmarker        = null;
  _gestureRecognizer?.close(); _gestureRecognizer = null;
  _mpClasses    = null;
  _drawingUtils = null;
  Object.assign(_ema, {
    jawOpen: 0, browInnerUp: 0, headTilt: 0, headYaw: 0,
    mouthSmileLeft: 0, mouthSmileRight: 0,
    eyeBlinkLeft: 0, eyeBlinkRight: 0,
    cursorX: window.innerWidth / 2, cursorY: window.innerHeight / 2,
  });
  Object.assign(_latch, { headLeft: false, headRight: false, leftBlink: false, browRaise: false, smile: false, thumbsUp: false, thumbsDown: false });
  _stickyEditor = null;
  _caretLocked  = false;
  _caretEl      = null;
  if (_cursorEl) _cursorEl.style.display = 'none';
  _setStatus('idle');
}

// Height stashed while the panel is collapsed to its drag handle, restored on
// expand — so a head/mouse-resized panel doesn't leave a tall empty shell.
let _savedFgHeight = '';

// ---------------------------------------------------------------------------
// DOM — styles, cursor overlay, and info panel.
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
      background:#ffffff; color:#111111;
      border:1px solid #111111; border-radius:10px;
      font-family:Arial, Helvetica, sans-serif; font-size:12px;
      padding:10px 12px; width:220px;
      /* Drag/resize (src/panel-drag-resize.js) writes top/left/width/height
         inline; these are the clamp floors/ceilings. The panel itself no
         longer scrolls — #trussal-fg-body does — so a resize can't hide the
         drag handle. */
      min-width:200px; min-height:220px;
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
    /* Keep handle controls clickable where a top corner grip overlaps them. */
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
    }
    #${FG_PANEL_ID} .fg-hints { font-size:10px; color:#111111; opacity:0.6; line-height:1.7; }
    #${FG_PANEL_ID} .fg-btns { display:flex; flex-wrap:wrap; gap:4px; min-height:0; }

    .strudel-head-btn {
      display:inline-block; padding:2px 8px; border-radius:999px;
      border:1px solid #111111; background:#ffffff; color:#111111;
      font-size:11px; font-family:monospace; cursor:default; user-select:none;
      transition:border-color 0.15s, color 0.15s, background 0.15s;
    }
    .strudel-head-btn.strudel-dwell-hover { border-color:#111111; }
    .strudel-head-btn.strudel-btn-active  { border-color:#111111; background:#111111; color:#ffffff; }
    /* Already in the pattern / in the ring — the same "on" the editor cards show. */
    .strudel-head-btn.strudel-btn-on { border-color:#111111; color:#ffffff; background:#111111; }

    #${FG_PANEL_ID} .fg-section {
      border-top: 1px solid #111111;
      padding-top: 8px;
      display: flex; flex-direction: column; gap: 4px;
    }
    #${FG_PANEL_ID} .fg-section-title { font-weight:600; color:#111111; font-size:11px; }
    #${FG_PANEL_ID} select, #${FG_PANEL_ID} input[type="text"], #${FG_PANEL_ID} input[type="number"] {
      background:#ffffff; color:#111111;
      border:1px solid #111111; border-radius:4px;
      padding:3px 6px; font-size:11px; box-sizing:border-box;
    }
    #${FG_PANEL_ID} select, #${FG_PANEL_ID} input[type="text"] { width: 100%; }
    #${FG_PANEL_ID} input[type="number"] { width:52px; font-family:monospace; text-align:center; }
    #${FG_PANEL_ID} input[type="text"] { font-family:monospace; }
    #${FG_PANEL_ID} input[type="text"]:focus, #${FG_PANEL_ID} select:focus,
    #${FG_PANEL_ID} input[type="number"]:focus {
      outline:1px solid #111111;
    }

    #trussal-fg-toggle {
      background:#ffffff; border:1px solid #111111;
      cursor:pointer; padding:3px 8px; border-radius:4px; color:#111111;
      transition:color 0.15s, background 0.15s, border-color 0.15s;
      line-height:1; display:flex; align-items:center; gap:4px;
      font-size:11px; font-family:Arial, Helvetica, sans-serif; white-space:nowrap;
    }
    #trussal-fg-toggle:hover { color:#ffffff; background:#111111; }
    #trussal-fg-toggle.on    { color:#ffffff; background:#111111; border-color:#111111; }

    .ts-dwell-btn {
      background: #ffffff;
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
    .ts-dwell-btn:hover { background: #111111; color: #ffffff; }
    .ts-dwell-btn.strudel-dwell-hover { border-color: #111111; }
    .ts-dwell-btn.strudel-btn-active  { border-color: #111111; background: #111111; color: #ffffff; }
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

  // Info panel.
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
      <div class="fg-hints">
        smile → play<br>
        thumbs up → stop<br>
        thumbs down → lock / unlock caret<br>
        left blink → update code<br>
        raise eyebrows → drum density<br>
        tilt head → transpose ±<span id="trussal-fg-tilt-label">2</span>st<br>
        head cursor dwell 1s → toggle voice
      </div>
      <div class="fg-btns" id="trussal-fg-btns"></div>

      <div class="fg-section">
        <div class="fg-section-title">head tilt amount</div>
        <div style="display:flex;align-items:center;gap:6px;">
          <input type="number" id="trussal-fg-tilt-delta" value="2" min="1" max="24" step="1"/>
          <span style="font-size:10px;color:#111111;">semitones per tilt</span>
        </div>
      </div>

      <div class="fg-section">
        <div class="fg-section-title">regex mutator</div>
        <select id="trussal-fg-trigger">
          <option value="mouthOpen">mouth open</option>
          <option value="headTiltLeft">head tilt left</option>
          <option value="headTiltRight">head tilt right</option>
        </select>
        <input type="text" id="trussal-fg-regex" placeholder="regex pattern" spellcheck="false"/>
        <input type="text" id="trussal-fg-replacement" placeholder="replacement" spellcheck="false"/>
        <div style="font-size:9px;color:#111111;line-height:1.5;">
          or annotate code:<br>
          <code>/* @mediapipe {"trigger":"mouthOpen","action":"regex-swap","regex":"bd","replacement":"sd"} */</code>
        </div>
      </div>

      <div class="fg-section">
        <div class="fg-section-title">StrudelButton</div>
        <div style="font-size:10px;color:#111111;line-height:1.5;">
          write in code:<br>
          <code style="font-size:9px">*bass: note("c2").s('bass')</code><br>
          dwell with head cursor (1 s) to append/toggle that voice.
        </div>
      </div>

      <div class="fg-section">
        <div class="fg-section-title">JPatternButton</div>
        <div style="font-size:10px;color:#111111;line-height:1.5;">
          write in the JPattern editor:<br>
          <code style="font-size:9px">*$ participants &lt;2a 2b&gt;</code><br>
          <code style="font-size:9px">*# crush wcl 2</code><br>
          dwell to put that voice in the ring (or that effect in the chain)
          and apply; dwell again to take it out. The bar above follows
          whichever editor has focus.
        </div>
      </div>

      <div class="fg-section">
        <div class="fg-section-title">window.faceCtx</div>
        <code style="font-size:9px;color:#111111">.gain(() =&gt; window.faceCtx.jawOpen)</code>
        <div style="font-size:10px;color:#111111;line-height:1.5;">
          jawOpen, browInnerUp, headTilt,<br>
          eyeBlinkL/R, mouthSmileL/R,<br>
          cursorX, cursorY
        </div>
      </div>
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
      // Drop a resized panel's explicit height while only the handle shows;
      // restore it on expand.
      panel.classList.toggle('fg-collapsed', !collapsed);
      if (!collapsed) { _savedFgHeight = panel.style.height; panel.style.height = ''; }
      else { panel.style.height = _savedFgHeight; }
    });
  }

  panel.querySelector('#trussal-fg-trigger').addEventListener('change', (e) => {
    _regexTrigger = e.target.value;
  });
  panel.querySelector('#trussal-fg-regex').addEventListener('input', (e) => {
    _regexPattern = e.target.value;
  });
  panel.querySelector('#trussal-fg-replacement').addEventListener('input', (e) => {
    _regexReplacement = e.target.value;
  });
  panel.querySelector('#trussal-fg-tilt-delta').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    if (!isNaN(v) && v >= 1) {
      _headTiltDelta = v;
      const lbl = document.getElementById('trussal-fg-tilt-label');
      if (lbl) lbl.textContent = v;
    }
  });

  // Move it by the handle (mouse) or the ✥ / ⇲ handle buttons (head cursor),
  // and resize it from any corner — same window behaviour as the keyboard.
  attachPanelControls(panel, {
    handle: panel.querySelector('.fg-drag-handle'),
    minW: 200,
    minH: 220,
  });
}

// ---------------------------------------------------------------------------
// Public API used by studio.js.
// ---------------------------------------------------------------------------

/**
 * Inject a camera-icon toggle button into the studio header element.
 * Called once from ensureOverlay() in studio.js.
 */
export function injectFacialGestureToggle(headerEl) {
  const btn = document.createElement('button');
  btn.id    = 'trussal-fg-toggle';
  btn.title = 'Toggle MediaPipe facial gesture control';
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

  btn.addEventListener('click', async () => {
    _enabled = !_enabled;
    btn.classList.toggle('on', _enabled);
    // Lazy-init the FG panel on first click so a panel setup error never
    // prevents the button from appearing in the header.
    try { _ensureDOM(); } catch (e) { console.error('[facial-gesture] panel init failed', e); }
    const panel = document.getElementById(FG_PANEL_ID);
    if (panel) panel.style.display = _enabled ? 'flex' : 'none';
    if (_enabled) {
      await _startCamera();
    } else {
      _stopCamera();
    }
  });

  // Insert before the close button.
  const closeBtn = headerEl.querySelector('.ts-close');
  headerEl.insertBefore(btn, closeBtn);
}

/**
 * Whether the MediaPipe head cursor is currently switched on (the Face
 * toggle). The on-screen keyboard gates its autopredict row on this — picking
 * a suggestion is a head-cursor dwell, so with no head cursor the row is
 * unpickable noise above the keys.
 */
export function isHeadCursorEnabled() {
  return _enabled;
}

/**
 * Rebuild the dwell-bar from the focused editor's button declarations —
 * StrudelButtons (`*name: code`) for the personal editor, JPatternButtons
 * (`*$ participants <2a>`, `*# crush wcl 2`) for the shared metaprogram.
 * Call this after renderDetail() whenever the pattern or overlay is refreshed.
 */
export function refreshFacialGestureButtons() {
  const bar = document.getElementById('trussal-fg-btns');
  if (!bar || !_enabled) { if (bar) { bar.innerHTML = ''; _barKey = null; } return; }

  const code = getCode();
  const esc   = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
  const escAt = (s) => String(s).replace(/"/g, '&quot;');
  // Rebuilding the bar detaches whatever node a dwell is currently filling
  // against — _dwell.el would go on styling an element that is no longer in
  // the document, and the user loses all feedback mid-hold. The shared editor
  // re-renders this on every remote keystroke, so only rebuild when the
  // buttons themselves actually changed.
  const render = (buttons, klass, attr) => {
    const key = `${klass} ${buttons.map(b => `${b.code}${b.label}${b.on ? 1 : 0}`).join('')}`;
    if (key === _barKey) return false;
    _barKey = key;
    bar.innerHTML = buttons.map((b) =>
      `<button class="strudel-head-btn${klass}${b.on ? ' strudel-btn-on' : ''}"` +
      ` ${attr}="${escAt(b.code)}" title="${escAt(b.code)}">▶ ${esc(b.label)}</button>`
    ).join('');
    return true;
  };
  const truncate = (s) => (s.length > 20 ? s.slice(0, 20) + '…' : s);

  // The bar follows the focused editor, because so does the dwell action.
  // `.jp-head-btn` is what routes a dwell to the metaprogram toggle instead of
  // the pattern one (see the dwell classification in _detectionLoop).
  if (activeEditorKind() === 'jpattern') {
    // Same label and same on/off state as the editor card's own row — one
    // button named two ways in two places is two buttons as far as the
    // performer can tell.
    const buttons = parseJPatternButtons(code)
      .map(b => ({ code: b.snippet, label: b.label, on: b.active }));
    if (render(buttons, ' jp-head-btn', 'data-jpattern-code')) {
      bar.querySelectorAll('[data-jpattern-code]').forEach((btn) => {
        btn.addEventListener('click', () => toggleJPatternButtonCode(btn.dataset.jpatternCode));
      });
    }
    return;
  }

  const snippets = [];
  const starred = /^\*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*(.+)$/mg;
  const explicit= /new\s+StrudelButton\((['"`])([\s\S]*?)\1\)/g;
  let m;
  starred.lastIndex  = 0;
  explicit.lastIndex = 0;
  while ((m = starred.exec(code))  !== null) snippets.push(`${m[1]}: ${m[2].trim()}`);
  while ((m = explicit.exec(code)) !== null) snippets.push(m[2]);

  const buttons = snippets.map(s => ({
    code: s,
    label: truncate(s),
    on: code.includes(`\n${s}${BTN_MARKER}`)
  }));
  if (render(buttons, '', 'data-strudel-code')) {
    bar.querySelectorAll('[data-strudel-code]').forEach((btn) => {
      btn.addEventListener('click', () => toggleButtonCode(btn.dataset.strudelCode));
    });
  }
}

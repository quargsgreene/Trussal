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

import { getLocalPeer, sendLocalPattern, sendLocalPlaying } from './peer-state.js';
import { bootStrudelOnUserGesture, stopStrudel } from './strudel.js';

// Keep in sync with @mediapipe/tasks-vision version in strudel-fork/website/package.json.
const WASM_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/wasm';
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const MP_ESM = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.35/+esm';

// Detection thresholds — identical to strudel-fork's useFacialGestures.jsx.
const BLINK_THRESHOLD      = 0.8;
const BROW_INNER_THRESHOLD = 0.6;
const BROW_OUTER_THRESHOLD = 0.45;
const JAW_OPEN_THRESHOLD   = 0.5;
const HEAD_TILT_THRESHOLD  = 0.3;
const COOLDOWN_MS          = 1500;
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
    jawOpen: 0, browInnerUp: 0, headTilt: 0,
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
}

// ---------------------------------------------------------------------------
// Editor shim — reads/writes the local peer's pattern through the textarea.
// ---------------------------------------------------------------------------
function getCode() {
  const ta = document.querySelector('#trussal-studio-overlay .ts-code');
  return ta ? ta.value : (getLocalPeer()?.pattern ?? '');
}

function setCode(code) {
  const ta = document.querySelector('#trussal-studio-overlay .ts-code');
  if (ta) ta.value = code;
  sendLocalPattern(code);
}

async function evaluate() {
  try {
    await bootStrudelOnUserGesture();
    sendLocalPlaying(true);
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
  return code;
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
    }
    // Also check the live regex mutator UI state (mirrors FacialGestureControl.jsx).
    if (_regexTrigger === triggerName && _regexPattern) {
      await mutateAndEvaluate((c) => applyRegexMutation(c, _regexPattern, _regexReplacement));
      ran = true;
    }
    if (!ran) await mutateAndEvaluate(defaultMutator);
  };
}

const handleMouthOpen    = makeGestureHandler('mouthOpen',    cycleHiHat);
const handleHeadTiltLeft = makeGestureHandler('headTiltLeft',  (c) => shiftTranspose(c, -2));
const handleHeadTiltRight= makeGestureHandler('headTiltRight', (c) => shiftTranspose(c,  2));

// ---------------------------------------------------------------------------
// MediaPipe detection state.
// ---------------------------------------------------------------------------
let _enabled       = false;
let _landmarker    = null;
let _mpClasses     = null;
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
  jawOpen: 0, browInnerUp: 0, headTilt: 0,
  mouthSmileLeft: 0, mouthSmileRight: 0,
  eyeBlinkLeft: 0, eyeBlinkRight: 0,
  cursorX: typeof window !== 'undefined' ? window.innerWidth  / 2 : 0,
  cursorY: typeof window !== 'undefined' ? window.innerHeight / 2 : 0,
};
const _latch      = { mouthOpen: false, headLeft: false, headRight: false };
const _lastFired  = { play: 0, stop: 0 };
const _dwell      = { code: null, el: null, startMs: 0, fired: false };

// Regex mutator UI state — mirrors FacialGestureControl.jsx's useState for
// triggerGesture / regex / replacement.
let _regexTrigger      = 'mouthOpen';
let _regexPattern      = '';
let _regexReplacement  = '';

function _flash(gesture) {
  if (!_flashEl) return;
  const labels = {
    play:          '▶ play',
    stop:          '■ stop',
    mouthOpen:     '◉ mouth → drum density',
    headTiltLeft:  '← tilt left → transpose −2',
    headTiltRight: '→ tilt right → transpose +2',
  };
  _flashEl.textContent = labels[gesture] ?? gesture;
  _flashEl.style.opacity = '1';
  clearTimeout(_flashTimeout);
  _flashTimeout = setTimeout(() => { if (_flashEl) _flashEl.style.opacity = '0'; }, 800);
}

function _setStatus(s) {
  if (!_statusEl) return;
  const cols = { ready: '#1ff466', loading: '#ffcc00', error: '#ff4444', idle: '#7aa68a' };
  _statusEl.textContent = s;
  _statusEl.style.color = cols[s] ?? '#7aa68a';
}

function _processResult(result) {
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
    const eyeDistX = Math.abs(landmarks[263].x - landmarks[33].x) || 0.1;
    const tiltRaw  = (landmarks[33].y - landmarks[263].y) / eyeDistX;
    _ema.headTilt  = lerp(_ema.headTilt, Math.max(-1, Math.min(1, tiltRaw)));
  }
  if (landmarks && landmarks.length > 10) {
    const lm = landmarks[10];
    _ema.cursorX = lerp(_ema.cursorX, (1 - lm.x) * window.innerWidth);
    _ema.cursorY = lerp(_ema.cursorY,       lm.y  * window.innerHeight);
  }

  Object.assign(window.faceCtx, _ema);
  _processGestures(blendshapes);
}

function _processGestures(blendshapes) {
  const score       = (name) => blendshapes.find((c) => c.categoryName === name)?.score ?? 0;
  const eyeBlinkL   = score('eyeBlinkLeft');
  const eyeBlinkR   = score('eyeBlinkRight');
  const browInnerUp = score('browInnerUp');
  const browOuterL  = score('browOuterUpLeft');
  const browOuterR  = score('browOuterUpRight');
  const jawOpen     = score('jawOpen');
  const now         = Date.now();

  const isBlink = eyeBlinkL > BLINK_THRESHOLD && eyeBlinkR > BLINK_THRESHOLD;
  const isBrowRaise =
    browInnerUp > BROW_INNER_THRESHOLD &&
    (browOuterL > BROW_OUTER_THRESHOLD || browOuterR > BROW_OUTER_THRESHOLD) &&
    eyeBlinkL < 0.3 && eyeBlinkR < 0.3;

  if (isBlink && now - _lastFired.play > COOLDOWN_MS) {
    _lastFired.play = now;
    _flash('play');
    bootStrudelOnUserGesture().then(() => sendLocalPlaying(true)).catch(() => {});
  } else if (isBrowRaise && now - _lastFired.stop > COOLDOWN_MS) {
    _lastFired.stop = now;
    _flash('stop');
    stopStrudel().then(() => sendLocalPlaying(false)).catch(() => {});
  }

  if (!_latch.mouthOpen && jawOpen > JAW_OPEN_THRESHOLD) {
    _latch.mouthOpen = true; _flash('mouthOpen'); handleMouthOpen();
  } else if (_latch.mouthOpen && jawOpen < JAW_OPEN_THRESHOLD * LATCH_RESET) {
    _latch.mouthOpen = false;
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

function _detectionLoop() {
  if (!_videoEl || !_landmarker || _videoEl.readyState < 2) {
    _rafId = requestAnimationFrame(_detectionLoop);
    return;
  }

  const result = _landmarker.detectForVideo(_videoEl, performance.now());
  _processResult(result);
  _drawLandmarks(result);

  // Move head cursor.
  if (_cursorEl) {
    _cursorEl.style.left    = `${_ema.cursorX}px`;
    _cursorEl.style.top     = `${_ema.cursorY}px`;
    _cursorEl.style.display = 'block';
  }

  // Dwell detection over .strudel-head-btn elements rendered by refreshFacialGestureButtons().
  const cx = _ema.cursorX;
  const cy = _ema.cursorY;
  let hoveredCode = null;
  let hoveredEl   = null;
  for (const btn of document.querySelectorAll('.strudel-head-btn')) {
    const r = btn.getBoundingClientRect();
    if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
      hoveredCode = btn.dataset.strudelCode;
      hoveredEl   = btn;
      break;
    }
  }

  const now = performance.now();
  if (hoveredCode !== _dwell.code) {
    if (_dwell.el) _dwell.el.classList.remove('strudel-dwell-hover');
    _dwell.code    = hoveredCode;
    _dwell.el      = hoveredEl;
    _dwell.startMs = hoveredCode ? now : 0;
    _dwell.fired   = false;
    if (_progressRing) _progressRing.style.strokeDashoffset = RING_C.toFixed(2);
  }

  if (hoveredCode && !_dwell.fired) {
    const progress = Math.min((now - _dwell.startMs) / DWELL_MS, 1);
    if (_dwell.el) _dwell.el.classList.add('strudel-dwell-hover');
    if (_progressRing) _progressRing.style.strokeDashoffset = (RING_C * (1 - progress)).toFixed(2);
    if (progress >= 1) {
      _dwell.fired = true;
      if (_dwell.el) {
        _dwell.el.classList.remove('strudel-dwell-hover');
        _dwell.el.classList.add('strudel-btn-active');
        setTimeout(() => _dwell.el?.classList.remove('strudel-btn-active'), 600);
      }
      if (_progressRing) _progressRing.style.strokeDashoffset = RING_C.toFixed(2);
      toggleButtonCode(hoveredCode);
    }
  }

  _rafId = requestAnimationFrame(_detectionLoop);
}

async function _startCamera() {
  _setStatus('loading');
  try {
    const { FaceLandmarker, FilesetResolver, DrawingUtils } = await import(MP_ESM);
    _mpClasses = { FaceLandmarker, DrawingUtils };

    const vision = await FilesetResolver.forVisionTasks(WASM_CDN);
    _landmarker  = await FaceLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      outputFaceBlendshapes: true,
      runningMode: 'VIDEO',
      numFaces: 1,
    });

    _stream = await navigator.mediaDevices.getUserMedia({ video: { width: 320, height: 240 } });
    _videoEl.srcObject = _stream;
    await _videoEl.play();

    _setStatus('ready');
    _rafId = requestAnimationFrame(_detectionLoop);
  } catch (e) {
    console.error('[facial-gesture]', e);
    _setStatus('error');
  }
}

function _stopCamera() {
  cancelAnimationFrame(_rafId);  _rafId = null;
  _stream?.getTracks().forEach((t) => t.stop());  _stream = null;
  _landmarker?.close();  _landmarker = null;
  _mpClasses    = null;
  _drawingUtils = null;
  Object.assign(_ema, {
    jawOpen: 0, browInnerUp: 0, headTilt: 0,
    mouthSmileLeft: 0, mouthSmileRight: 0,
    eyeBlinkLeft: 0, eyeBlinkRight: 0,
    cursorX: window.innerWidth / 2, cursorY: window.innerHeight / 2,
  });
  Object.assign(_latch, { mouthOpen: false, headLeft: false, headRight: false });
  if (_cursorEl) _cursorEl.style.display = 'none';
  _setStatus('idle');
}

// ---------------------------------------------------------------------------
// Panel drag state.
// ---------------------------------------------------------------------------
function _makePanelDraggable(panel) {
  const handle = panel.querySelector('.fg-drag-handle');
  if (!handle) return;
  handle.addEventListener('mousedown', (evt) => {
    if (evt.target.closest('button,select,input')) return;
    evt.preventDefault();
    const rect = panel.getBoundingClientRect();
    const startX = evt.clientX;
    const startY = evt.clientY;
    const origLeft = rect.left;
    const origTop  = rect.top;
    // Switch to top/left so the panel stays put when the viewport scrolls.
    panel.style.bottom = '';
    panel.style.right  = '';
    panel.style.left   = `${origLeft}px`;
    panel.style.top    = `${origTop}px`;
    function onMove(e) {
      panel.style.left = `${origLeft + e.clientX - startX}px`;
      panel.style.top  = `${origTop  + e.clientY - startY}px`;
    }
    function onUp() {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup',   onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup',   onUp);
  });
}

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
      background:rgba(8,14,12,0.96); color:#d6f5e2;
      border:1px solid rgba(255,255,255,0.15); border-radius:10px;
      font-family:sans-serif; font-size:12px;
      padding:10px 12px; width:220px;
      max-height: calc(100vh - 80px); overflow-y: auto;
      display:none; flex-direction:column; gap:8px;
      box-shadow:0 8px 24px rgba(0,0,0,0.5); user-select:none;
    }
    #${FG_PANEL_ID} .fg-drag-handle {
      cursor:grab; margin:-10px -12px 0; padding:8px 12px 6px;
      border-radius:10px 10px 0 0;
    }
    #${FG_PANEL_ID} .fg-drag-handle:active { cursor:grabbing; }
    #${FG_PANEL_ID} .fg-row { display:flex; align-items:center; justify-content:space-between; }
    #${FG_PANEL_ID} .fg-title { font-weight:600; color:#1ff466; }
    #${FG_PANEL_ID} .fg-video-wrap { position:relative; width:100%; }
    #${FG_PANEL_ID} video { width:100%; border-radius:4px; display:block; transform:scaleX(-1); }
    #${FG_PANEL_ID} canvas {
      position:absolute; inset:0; width:100%; height:100%;
      border-radius:4px; pointer-events:none; transform:scaleX(-1);
    }
    #${FG_PANEL_ID} .fg-flash {
      font-size:11px; font-weight:600; text-align:center;
      color:#ffcc00; opacity:0; transition:opacity 0.15s; min-height:1.2em;
    }
    #${FG_PANEL_ID} .fg-hints { font-size:10px; color:#5d7264; line-height:1.7; }
    #${FG_PANEL_ID} .fg-btns { display:flex; flex-wrap:wrap; gap:4px; min-height:0; }

    .strudel-head-btn {
      display:inline-block; padding:2px 8px; border-radius:999px;
      border:1px solid #4a5568; background:transparent; color:#7dcfff;
      font-size:11px; font-family:monospace; cursor:default; user-select:none;
      transition:border-color 0.15s, color 0.15s;
    }
    .strudel-head-btn.strudel-dwell-hover { border-color:#ffcc00; color:#ffcc00; }
    .strudel-head-btn.strudel-btn-active  { border-color:#68d391; color:#68d391; }

    #${FG_PANEL_ID} .fg-section {
      border-top: 1px solid rgba(255,255,255,0.08);
      padding-top: 8px;
      display: flex; flex-direction: column; gap: 4px;
    }
    #${FG_PANEL_ID} .fg-section-title { font-weight:600; color:#d6f5e2; font-size:11px; }
    #${FG_PANEL_ID} select, #${FG_PANEL_ID} input[type="text"] {
      width: 100%; background:#050f0a; color:#d6f5e2;
      border:1px solid rgba(255,255,255,0.15); border-radius:4px;
      padding:3px 6px; font-size:11px; box-sizing:border-box;
    }
    #${FG_PANEL_ID} input[type="text"] { font-family:monospace; }
    #${FG_PANEL_ID} input[type="text"]:focus, #${FG_PANEL_ID} select:focus {
      outline:1px solid rgba(31,244,102,0.4);
    }

    #trussal-fg-toggle {
      background:rgba(255,255,255,0.06); border:1px solid rgba(255,255,255,0.12);
      cursor:pointer; padding:3px 8px; border-radius:4px; color:#7aa68a;
      transition:color 0.15s, background 0.15s, border-color 0.15s;
      line-height:1; display:flex; align-items:center; gap:4px;
      font-size:11px; font-family:sans-serif; white-space:nowrap;
    }
    #trussal-fg-toggle:hover { color:#d6f5e2; background:rgba(255,255,255,0.1); }
    #trussal-fg-toggle.on    { color:#1ff466; background:rgba(31,244,102,0.12); border-color:rgba(31,244,102,0.3); }
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
              fill="rgba(255,255,255,0.85)"/>
      <circle id="trussal-fg-ring"
        cx="${RING_R+4}" cy="${RING_R+4}" r="${RING_R}"
        fill="none" stroke="#ffcc00" stroke-width="2.5" stroke-linecap="round"
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
      <span id="trussal-fg-status" style="font-size:11px;">idle</span>
    </div>
    <div class="fg-video-wrap">
      <video id="trussal-fg-video" muted playsinline></video>
      <canvas id="trussal-fg-canvas"></canvas>
    </div>
    <div class="fg-flash" id="trussal-fg-flash"></div>
    <div class="fg-hints">
      blink both eyes → play<br>
      raise eyebrows → stop<br>
      open mouth → drum density<br>
      tilt head → transpose ±2<br>
      head cursor dwell 1s → toggle voice
    </div>
    <div class="fg-btns" id="trussal-fg-btns"></div>

    <div class="fg-section">
      <div class="fg-section-title">regex mutator</div>
      <select id="trussal-fg-trigger">
        <option value="mouthOpen">mouth open</option>
        <option value="headTiltLeft">head tilt left</option>
        <option value="headTiltRight">head tilt right</option>
      </select>
      <input type="text" id="trussal-fg-regex" placeholder="regex pattern" spellcheck="false"/>
      <input type="text" id="trussal-fg-replacement" placeholder="replacement" spellcheck="false"/>
      <div style="font-size:9px;color:#5d7264;line-height:1.5;">
        or annotate code:<br>
        <code>/* @mediapipe {"trigger":"mouthOpen","action":"regex-swap","regex":"bd","replacement":"sd"} */</code>
      </div>
    </div>

    <div class="fg-section">
      <div class="fg-section-title">StrudelButton</div>
      <div style="font-size:10px;color:#5d7264;line-height:1.5;">
        write in code:<br>
        <code style="font-size:9px">*bass: note("c2").s('bass')</code><br>
        dwell with head cursor (1 s) to append/toggle that voice.
      </div>
    </div>

    <div class="fg-section">
      <div class="fg-section-title">window.faceCtx</div>
      <code style="font-size:9px;color:#7dcfff">.gain(() =&gt; window.faceCtx.jawOpen)</code>
      <div style="font-size:10px;color:#5d7264;line-height:1.5;">
        jawOpen, browInnerUp, headTilt,<br>
        eyeBlinkL/R, mouthSmileL/R,<br>
        cursorX, cursorY
      </div>
    </div>
  `;
  document.body.appendChild(panel);
  _videoEl   = panel.querySelector('#trussal-fg-video');
  _canvasEl  = panel.querySelector('#trussal-fg-canvas');
  _statusEl  = panel.querySelector('#trussal-fg-status');
  _flashEl   = panel.querySelector('#trussal-fg-flash');

  panel.querySelector('#trussal-fg-trigger').addEventListener('change', (e) => {
    _regexTrigger = e.target.value;
  });
  panel.querySelector('#trussal-fg-regex').addEventListener('input', (e) => {
    _regexPattern = e.target.value;
  });
  panel.querySelector('#trussal-fg-replacement').addEventListener('input', (e) => {
    _regexReplacement = e.target.value;
  });

  _makePanelDraggable(panel);
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
 * Rebuild the StrudelButton dwell-bar from the current pattern text.
 * Call this after renderDetail() whenever the pattern or overlay is refreshed.
 */
export function refreshFacialGestureButtons() {
  const bar = document.getElementById('trussal-fg-btns');
  if (!bar || !_enabled) { if (bar) bar.innerHTML = ''; return; }

  const code    = getCode();
  const buttons = [];
  const starred = /^\*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*(.+)$/mg;
  const explicit= /new\s+StrudelButton\((['"`])([\s\S]*?)\1\)/g;
  let m;
  starred.lastIndex  = 0;
  explicit.lastIndex = 0;
  while ((m = starred.exec(code))  !== null) buttons.push(`${m[1]}: ${m[2].trim()}`);
  while ((m = explicit.exec(code)) !== null) buttons.push(m[2]);

  const esc   = (s) => String(s).replace(/[&<>"']/g, (c) =>
    ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[c]);
  const escAt = (s) => String(s).replace(/"/g, '&quot;');

  bar.innerHTML = buttons.map((code) => {
    const label = code.length > 20 ? code.slice(0, 20) + '…' : code;
    return `<button class="strudel-head-btn" data-strudel-code="${escAt(code)}">▶ ${esc(label)}</button>`;
  }).join('');

  bar.querySelectorAll('.strudel-head-btn').forEach((btn) => {
    btn.addEventListener('click', () => toggleButtonCode(btn.dataset.strudelCode));
  });
}

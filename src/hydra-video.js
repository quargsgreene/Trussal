// hydra-video.js — Hydra video source mode + visual effects for Trussal.
//
// Mode "split": camera shown in the HV panel; Hydra renders independently.
// Mode "direct": camera fed to globalThis.s0 so Hydra code can say src(s0).out().
//
// Visual effects are applied to #hydra-canvas (always) and to the video element
// (split mode only) via CSS filters + canvas noise overlays, driven by the local
// peer's rtt/jitter when the corresponding effect toggle is on.
//
// Also exports ensureCameraBypass(), which patches Hydra's own External
// Sources API (s0-s3 .initCam()) so a performer's own code can pull in a real
// camera. Hydra's initCam() calls navigator.mediaDevices.getUserMedia
// directly, which published-video.js's publish override intercepts and hands
// back the (black, self-referential) published canvas instead. strudel.js
// calls this synchronously from its own wrapped initHydra(), right after the
// real one resolves and before any user code runs — patching it lazily from
// this module's own RAF loop loses the race: a preamble's very next line is
// often `s0.initCam()`, called before the next animation frame ever fires.
// initImage/initVideo/initScreen/init don't touch getUserMedia and need no
// such bypass.

import { subscribePeerState } from './peer-state.js';
// The REAL camera. A plain getUserMedia here would be intercepted by the
// published-video override and hand back the canvas the room sees, leaving
// `s0` (and this panel) showing their own output instead of the camera.
import { openCamera } from './published-video.js';

export const MODE_SPLIT  = 'split';
export const MODE_DIRECT = 'direct';

let _mode      = MODE_SPLIT;
let _videoEl   = null;   // <video> element inside the HV panel (owned here)
let _running   = false;
let _rafId     = null;

// Tracks the last video element successfully given to s0.init().  Comparing
// against this avoids calling s0.init() or s0.clear() every RAF frame, which
// was causing the Hydra canvas to freeze when clicking "split".
let _lastSyncedVideoEl = undefined; // undefined = "needs sync"; null = "synced to cleared state"

// Whether s0's current content is something THIS module put there (the direct
// mode camera-blend feed). Only true when we last called s0.init() ourselves —
// gates s0.clear() so leaving direct mode never wipes out a performer's own
// s0.initCam()/initImage()/initVideo()/init() from their own Hydra code.
let _ownsS0 = false;

// Sources (s0-s3) whose .initCam has already been patched to bypass the
// publish-video getUserMedia override — see ensureCameraBypass.
const _camPatched = new WeakSet();

// Globals read by Hydra's dynamic-parameter callbacks for the s0 blend.
// Initialized here so the blend line in the evaluated program never sees undefined.
window._hvBlendAmt = 0.5;
window._hvR = 1;
window._hvG = 1;
window._hvB = 1;

// Visual effect scalars recomputed from peer state.
let _hpCutoff   = 0;   // distortion → high-pass edge intensity
let _noiseAmt   = 0;   // noise → color noise density
let _stretchAmt = 0;   // reverb → stretch/contract amplitude

// Fixed-position noise overlay canvases appended to <body>.
const _noiseOverlays = new Map(); // key → canvas

const PANEL_ID  = 'trussal-hv-panel';
const TOGGLE_ID = 'trussal-hv-toggle';
const VIDEO_ID  = 'trussal-hv-video';
const STYLE_ID  = 'trussal-hv-style';

// ---------------------------------------------------------------------------
// Video stream sharing (called by facial-gesture.js)
// ---------------------------------------------------------------------------

export function setVideoStream(stream) {
  if (!stream) {
    if (_videoEl) _videoEl.srcObject = null;
    _videoEl = null;   // reset so the Video button can open a new camera next time
    return;
  }
  _ensurePanel();
  const vid = document.getElementById(VIDEO_ID);
  if (vid) {
    vid.srcObject = stream;
    vid.play().catch(() => {});
    _videoEl = vid;
    _syncHydraSource();
  }
}

// ---------------------------------------------------------------------------
// Hydra source sync — uses globalThis.s0 set by Hydra after initHydra()
// ---------------------------------------------------------------------------

function _syncHydraSource() {
  if (typeof globalThis.s0 === 'undefined') {
    _lastSyncedVideoEl = undefined;
    _ownsS0 = false;
    return;
  }
  // Only call s0.init/clear when the target actually changes — calling every
  // RAF frame caused Hydra to freeze when clicking "split".
  const target = (_mode === MODE_DIRECT && _videoEl?.srcObject) ? _videoEl : null;
  if (target === _lastSyncedVideoEl) return;
  try {
    if (target) {
      globalThis.s0.init({ src: target });
      _ownsS0 = true;
    } else if (_ownsS0) {
      // Only release what THIS module put into s0 — never clear a source a
      // performer populated themselves via s0.initCam()/initImage()/init().
      globalThis.s0.clear?.();
      _ownsS0 = false;
    }
    _lastSyncedVideoEl = target;
  } catch (e) {
    console.warn('[hydra-video] s0 sync failed', e);
    _lastSyncedVideoEl = undefined;
  }
}

// ---------------------------------------------------------------------------
// External Sources: real-camera bypass for s0-s3 .initCam()
// ---------------------------------------------------------------------------

// Mirrors hydra-synth's own webcam.js device-selection behaviour (an index
// picks the Nth enumerated video input; omitted/unmatched falls back to the
// default camera) so the patched initCam behaves like the documented one.
async function _camConstraintsForIndex(index) {
  const constraints = { audio: false, video: true };
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput');
    if (cams[index]) constraints.video = { deviceId: { exact: cams[index].deviceId } };
  } catch (e) {
    console.warn('[hydra-video] camera enumeration failed, using default camera', e);
  }
  return constraints;
}

function _videoFromStream(stream) {
  const video = document.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  return new Promise((resolve) => {
    video.addEventListener('loadedmetadata', () => {
      video.play().then(() => resolve(video)).catch(() => resolve(video));
    });
  });
}

// Hydra's own s*.initCam() calls navigator.mediaDevices.getUserMedia
// directly, which published-video.js intercepts for every video request so a
// performer's raw camera never reaches the wire — s*.initCam() would get back
// the published canvas (their own Hydra output, or black) instead of a real
// camera. Route it through openCamera(), the same real-camera escape hatch
// the split/direct panel uses, then hand the resulting video to Hydra's own
// (untouched) init() so the rest of the External Sources contract is unchanged.
//
// Must run SYNCHRONOUSLY (from strudel.js's wrapped initHydra) right after
// initHydra() creates s0-s3 and before any user code runs — a preamble's next
// line is routinely `s0.initCam()` itself, called before this module's own
// RAF loop ever gets a turn.
export function ensureCameraBypass() {
  for (let i = 0; i < 4; i++) {
    const source = globalThis['s' + i];
    if (!source || typeof source.initCam !== 'function' || _camPatched.has(source)) continue;
    source.initCam = async (index, params) => {
      try {
        const constraints = await _camConstraintsForIndex(index);
        const stream = await openCamera(constraints);
        const video = await _videoFromStream(stream);
        source.init({ src: video, dynamic: true }, params);
      } catch (e) {
        console.warn('[hydra-video] initCam failed', e);
      }
    };
    _camPatched.add(source);
  }
}

// Called by strudel.js after evaluate() so the next frame re-syncs s0 to the
// freshly re-created Hydra instance (initHydra creates a new synth each time).
export function resetHydraSync() {
  _lastSyncedVideoEl = undefined;
}

// strudel.js reads this to decide whether to inject the initHydra() preamble.
export function getMode() { return _mode; }

// ---------------------------------------------------------------------------
// Effect parameter computation (mirrors latency-instrument.js thresholds)
// ---------------------------------------------------------------------------

function _updateParams(effects, rtt, jitter) {
  const r = rtt    || 0;
  const j = jitter || 0;

  // Base 0.1 (visible contrast bump) when on; network conditions push toward 1.
  _hpCutoff = 0;
  if (effects?.distortion) {
    const base  = 0.1;
    const extra = Math.max(0, Math.min(1 - base, (r - 5) / 55 + j / 6));
    _hpCutoff = base + extra;
  }

  // Base 0.15 (clearly visible grain) when on; jitter and RTT scale it up.
  _noiseAmt = 0;
  if (effects?.noise) {
    _noiseAmt = Math.max(0.15, Math.min(1, 0.15 + j / 4 + r / 150));
  }

  // Base 0.04 (subtle warp) when on; network conditions make it more extreme.
  _stretchAmt = 0;
  if (effects?.reverb) {
    _stretchAmt = Math.max(0.04, Math.min(0.35, 0.04 + j / 8 + r / 300));
  }

  // Color tint for the s0 Hydra blend.  ratio = jitter/rtt shifts the hue:
  //   low ratio (smooth but slow) → cool blue cast
  //   high ratio (jittery relative to RTT) → warm orange-red cast
  const ratio = (j > 0 && r > 0) ? Math.min(1, j / r) : 0;
  window._hvR = 0.9 + ratio * 0.6;    // 0.9 (cool) → 1.5 (warm-red)
  window._hvG = 1.0 - ratio * 0.15;   // 1.0 → 0.85
  window._hvB = 1.2 - ratio * 0.7;    // 1.2 (bluish) → 0.5 (warm)
  window._hvBlendAmt = 0.5;            // fixed 50/50 blend; tint carries the variation
}

// ---------------------------------------------------------------------------
// RAF effects loop
// ---------------------------------------------------------------------------

function _scheduleFrame() {
  if (!_running) return;
  _rafId = requestAnimationFrame(_frame);
}

function _frame() {
  _applyEffects();
  if (_running) _rafId = requestAnimationFrame(_frame);
}

function _effectTargets() {
  const out = [];
  const hydraCanvas = document.getElementById('hydra-canvas');
  if (hydraCanvas) out.push({ el: hydraCanvas, key: 'hydra' });
  if (_videoEl && _mode === MODE_SPLIT && _videoEl.srcObject) {
    out.push({ el: _videoEl, key: 'video' });
  }
  return out;
}

function _applyEffects() {
  const t = performance.now() / 1000;
  const targets = _effectTargets();

  for (const { el } of targets) {
    // High-pass approximation: extreme contrast lifts edges, dims midtones.
    let filter = '';
    if (_hpCutoff > 0) {
      const contrast   = (1 + _hpCutoff * 5).toFixed(2);
      const brightness = (1 - _hpCutoff * 0.3).toFixed(2);
      const saturate   = (1 - _hpCutoff * 0.5).toFixed(2);
      filter = `contrast(${contrast}) brightness(${brightness}) saturate(${saturate})`;
    }
    el.style.filter = filter;

    // Reverb stretch: oscillating scaleY / scaleX at incommensurate frequencies.
    if (_stretchAmt > 0) {
      const sy = (1 + _stretchAmt * Math.sin(t * Math.PI)).toFixed(4);
      const sx = (1 + _stretchAmt * 0.5 * Math.sin(t * Math.PI * 1.41)).toFixed(4);
      el.style.transform       = `scaleY(${sy}) scaleX(${sx})`;
      el.style.transformOrigin = 'center center';
    } else {
      el.style.transform = '';
    }
  }

  // Noise overlays.
  for (const { el, key } of targets) {
    _updateNoiseOverlay(key, el);
  }
  // Remove overlays for any target no longer active.
  const activeKeys = new Set(targets.map(t => t.key));
  for (const [k] of _noiseOverlays) {
    if (!activeKeys.has(k)) _removeNoiseOverlay(k);
  }

  // Re-sync source every frame (catches late initHydra() calls).
  _syncHydraSource();
}

function _updateNoiseOverlay(key, targetEl) {
  if (!targetEl || _noiseAmt <= 0) {
    _removeNoiseOverlay(key);
    return;
  }

  let ov = _noiseOverlays.get(key);
  if (!ov) {
    ov = document.createElement('canvas');
    ov.style.cssText = 'position:fixed;pointer-events:none;z-index:9999998;mix-blend-mode:screen;';
    document.body.appendChild(ov);
    _noiseOverlays.set(key, ov);
  }

  const rect = targetEl.getBoundingClientRect();
  if (!rect.width || !rect.height) return;

  // Draw at 1/4 resolution for performance; CSS stretches it to target size.
  const scale = 0.25;
  const w = Math.max(1, Math.round(rect.width  * scale));
  const h = Math.max(1, Math.round(rect.height * scale));
  if (ov.width !== w || ov.height !== h) { ov.width = w; ov.height = h; }
  ov.style.left   = rect.left   + 'px';
  ov.style.top    = rect.top    + 'px';
  ov.style.width  = rect.width  + 'px';
  ov.style.height = rect.height + 'px';

  const ctx  = ov.getContext('2d');
  const data = ctx.createImageData(w, h);
  const buf  = data.data;
  const amt  = _noiseAmt;

  for (let i = 0; i < buf.length; i += 4) {
    if (Math.random() < amt) {
      buf[i    ] = (Math.random() * 255) | 0;
      buf[i + 1] = (Math.random() * 255) | 0;
      buf[i + 2] = (Math.random() * 255) | 0;
      buf[i + 3] = (amt * 180)           | 0;
    }
  }
  ctx.putImageData(data, 0, 0);
}

function _removeNoiseOverlay(key) {
  const ov = _noiseOverlays.get(key);
  if (ov) { ov.remove(); _noiseOverlays.delete(key); }
}

// ---------------------------------------------------------------------------
// Panel DOM
// ---------------------------------------------------------------------------

function _injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  // Authored against the per-user Personal Theme vars (src/theme-context.js):
  // --trussal-primary / --trussal-secondary / --trussal-font / --trussal-font-scale
  // on :root, each keeping its previous literal as the var() fallback, so this
  // panel retints with the Strudel overlay and the rest of the app.
  s.textContent = `
    #${PANEL_ID} {
      position:fixed; top:64px; right:16px; z-index:1000000;
      background:var(--trussal-primary, #eeeeee); color:var(--trussal-secondary, #111111);
      border:1px solid var(--trussal-secondary, #111111); border-radius:10px;
      font-family:var(--trussal-font, Arial, Helvetica, sans-serif); font-size:calc(12px * var(--trussal-font-scale, 1));
      padding:10px 12px; width:300px;
      display:none; flex-direction:column; gap:8px;
      box-shadow:0 8px 24px rgba(0,0,0,0.2); user-select:none;
    }
    #${PANEL_ID} video {
      width:100%; border-radius:4px; display:block; transform:scaleX(-1);
      background:var(--trussal-secondary, #111111);
    }
    #${PANEL_ID} .hv-mode-row { display:flex; gap:6px; }
    #${PANEL_ID} .hv-mode-btn {
      flex:1; padding:3px 0; border-radius:4px;
      border:1px solid var(--trussal-secondary, #111111);
      background:var(--trussal-primary, #eeeeee); color:var(--trussal-secondary, #111111);
      font-size:calc(11px * var(--trussal-font-scale, 1)); cursor:pointer; text-align:center;
      transition:background 0.15s, color 0.15s;
    }
    #${PANEL_ID} .hv-mode-btn.on {
      background:var(--trussal-secondary, #111111); color:var(--trussal-primary, #eeeeee);
      border-color:var(--trussal-secondary, #111111);
    }
    #${PANEL_ID} .hv-header { display:flex; align-items:center; justify-content:space-between; }
    #${PANEL_ID} .hv-title { font-weight:600; color:var(--trussal-secondary, #111111); }
    #${PANEL_ID} .hv-collapse-btn {
      background:none; border:none; color:var(--trussal-secondary, #111111); cursor:pointer;
      font-size:calc(13px * var(--trussal-font-scale, 1)); line-height:1; padding:0 2px; transition:color 0.15s;
    }
    #${PANEL_ID} .hv-collapse-btn:hover { color:var(--trussal-secondary, #111111); }
    #${PANEL_ID} .hv-body { display:flex; flex-direction:column; gap:8px; overflow:hidden; }
    #${PANEL_ID} .hv-body.collapsed { display:none; }
    #${PANEL_ID} .hv-status { font-size:calc(10px * var(--trussal-font-scale, 1)); color:var(--trussal-secondary, #111111); line-height:1.5; }

    #${TOGGLE_ID} {
      background:var(--trussal-primary, #eeeeee); border:1px solid var(--trussal-secondary, #111111);
      cursor:pointer; padding:3px 8px; border-radius:4px; color:var(--trussal-secondary, #111111);
      transition:color 0.15s, background 0.15s, border-color 0.15s;
      line-height:1; display:flex; align-items:center; gap:4px;
      font-size:calc(11px * var(--trussal-font-scale, 1)); font-family:var(--trussal-font, Arial, Helvetica, sans-serif); white-space:nowrap;
    }
    #${TOGGLE_ID}:hover { color:var(--trussal-primary, #eeeeee); background:var(--trussal-secondary, #111111); }
    #${TOGGLE_ID}.on { color:var(--trussal-primary, #eeeeee); background:var(--trussal-secondary, #111111); border-color:var(--trussal-secondary, #111111); }
  `;
  document.head.appendChild(s);
}

function _ensurePanel() {
  if (document.getElementById(PANEL_ID)) return;
  _injectStyles();

  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="hv-header">
      <div class="hv-title">hydra video</div>
      <button class="hv-collapse-btn ts-dwell-btn" title="Collapse panel" aria-label="Collapse">▲</button>
    </div>
    <div class="hv-body">
      <video id="${VIDEO_ID}" muted playsinline></video>
      <div class="hv-status" id="trussal-hv-status"></div>
    </div>
  `;
  document.body.appendChild(panel);

  panel.querySelector('.hv-collapse-btn').addEventListener('click', () => {
    const body = panel.querySelector('.hv-body');
    const btn  = panel.querySelector('.hv-collapse-btn');
    const collapsed = body.classList.toggle('collapsed');
    btn.textContent = collapsed ? '▼' : '▲';
    btn.title = collapsed ? 'Expand panel' : 'Collapse panel';
  });

  _updatePanelStatus();
}

function _updatePanelStatus() {
  const el = document.getElementById('trussal-hv-status');
  if (!el) return;
  el.textContent = _mode === MODE_DIRECT
    ? 'video → hydra s0\nuse src(s0).out() in code'
    : 'split: camera shown above';
}

// ---------------------------------------------------------------------------
// Subscribe to local peer state → recompute visual params
// ---------------------------------------------------------------------------

subscribePeerState((event, payload) => {
  if (event !== 'peer-upsert') return;
  if (!payload?.isLocal) return;
  _updateParams(payload.effects, payload.rtt, payload.jitter);
});

// Start the RAF loop once at module load; it's a no-op until params go non-zero.
_running = true;
_scheduleFrame();

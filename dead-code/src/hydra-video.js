// ARCHIVED 2026-08-28 — moved out of src/hydra-video.js as dead code.
//
// The Hydra-video PANEL UI. `injectHydraVideoToggle` (the studio-header toggle
// button) was imported by src/studio.js but its call site there was commented
// out, so the button was never added. `setMode` (the split/direct switch) had
// no caller — the mode is set internally. `_autoStartVideo` was `setMode`'s
// helper; `_clearAllEffects` an orphan reset (effect targets are cleared per
// frame by the RAF loop). The module vars `_stream` and `_panelOpen` went with
// them (no other reader).
//
// STILL LIVE in src/hydra-video.js (do NOT assume dead):
//   - `getMode` — strudel.js imports it as getHydraVideoMode
//   - `setVideoStream` — facial-gesture.js calls it to share the FG camera;
//     that path still lazily builds the panel via `_ensurePanel` /
//     `_injectStyles` / `_updatePanelStatus`, so those stayed.
//   - `MODE_SPLIT` / `MODE_DIRECT` / `_mode`, the RAF loop, `_effectTargets`,
//     `_noiseOverlays`, `_removeNoiseOverlay`.
//
// If revived, needs (from src/hydra-video.js unless noted):
//   let _mode = MODE_SPLIT, _panelOpen = false, _videoEl = null, _stream = null;
//   const PANEL_ID, TOGGLE_ID; openCamera (from './published-video.js');
//   _syncHydraSource(), _updatePanelStatus(), _ensurePanel(), setVideoStream(),
//   _effectTargets(), _removeNoiseOverlay().

let _panelOpen = false;
let _stream    = null;

export function injectHydraVideoToggle(headerEl) {
  if (document.getElementById(TOGGLE_ID)) return;
  _injectStyles();

  const btn = document.createElement('button');
  btn.id    = TOGGLE_ID;
  btn.title = 'Toggle Hydra video panel';
  btn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"
      fill="currentColor" width="13" height="13" aria-hidden="true">
    <path d="M4.5 4.5a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h8.25a3 3 0 0 0
      3-3v-9a3 3 0 0 0-3-3H4.5ZM19.94 18.75l-2.69-2.69V7.94l2.69-2.69c.944-.945
      2.56-.276 2.56 1.06v11.38c0 1.336-1.616 2.005-2.56 1.06Z"/>
  </svg>Video`;

  btn.addEventListener('click', async () => {
    _panelOpen = !_panelOpen;
    btn.classList.toggle('on', _panelOpen);
    _ensurePanel();
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.style.display = _panelOpen ? 'flex' : 'none';
    if (_panelOpen && !_videoEl?.srcObject) {
      // Open own camera if FG hasn't shared an active stream.
      try {
        const stream = await openCamera({ video: { width: 320, height: 240 } });
        _stream = stream;
        setVideoStream(stream);
      } catch (e) {
        console.warn('[hydra-video] camera open failed', e);
      }
    }
  });

  const closeBtn = headerEl.querySelector('.ts-close');
  headerEl.insertBefore(btn, closeBtn);
}

export function setMode(mode) {
  _mode = (mode === MODE_DIRECT) ? MODE_DIRECT : MODE_SPLIT;
  _syncHydraSource();
  _updatePanelStatus();
  // Notify strudel.js so it can inject/remove the initHydra() preamble.
  document.dispatchEvent(new CustomEvent('trussal-hydra-mode-change', { detail: { mode: _mode } }));
  // Auto-open the panel and start camera so the user sees something immediately.
  _autoStartVideo();
}

async function _autoStartVideo() {
  if (!_panelOpen) {
    _panelOpen = true;
    _ensurePanel();
    const panel = document.getElementById(PANEL_ID);
    if (panel) panel.style.display = 'flex';
    const toggleBtn = document.getElementById(TOGGLE_ID);
    if (toggleBtn) toggleBtn.classList.add('on');
  }
  if (!_videoEl?.srcObject) {
    try {
      const stream = await openCamera({ video: { width: 320, height: 240 } });
      _stream = stream;
      setVideoStream(stream);
    } catch (e) {
      console.warn('[hydra-video] auto-start camera failed', e);
    }
  }
}

function _clearAllEffects() {
  for (const { el } of _effectTargets()) {
    el.style.filter    = '';
    el.style.transform = '';
  }
  for (const [k] of _noiseOverlays) _removeNoiseOverlay(k);
}

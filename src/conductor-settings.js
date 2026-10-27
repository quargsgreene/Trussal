// In-meeting Conductor settings.
//
// The toggle lives in the Trussal Studio group on Jitsi's bottom toolbar, and
// opens the settings in their own browser window, not an overlay: the form is
// several screens tall, and the meeting stays visible and unobstructed while it
// is open. If a
// browser or an embedding iframe refuses the popup, the same panel opens as an
// in-app overlay instead of failing.
//
// The controls mirror the conductor admin page's config form
// (bots/src/config-api/admin.html), but the request/answer path is the
// peer-state sidecar's `fleet-request` / `fleet-status`, not the admin HTTP
// port. The app is served over HTTPS while that port is plain HTTP on the bots
// VM, and the browser has no conductor address to begin with; the same bus
// that already carries spawn/remove works from any deployment.
//
// The settings belong to THIS meeting only. The fleet stores them on the room
// the request arrived from (ROOM_TUNABLE keys only), layered over the admin
// defaults, so this panel shapes this meeting's bots and never another's — and
// it cannot repoint the fleet.
//
// Visibility is derived from the Studio toolbar rather than a fixed corner
// button: the two controls therefore cannot disagree about whether a room is
// live, and the group is hidden as one whenever Jitsi hides its native bar.

import { getRoomNameFromUrl } from './get-room-name-from-url.js';
import { sendFleetRequest } from './peer-state.js';
import { subscribeFleetStatus } from './audio-net/UserBotOrchestration.js';
import { attachPanelControls } from './panel-drag-resize.js';

const BUTTON_ID = 'trussal-conductor-toggle';
const OVERLAY_ID = 'trussal-conductor-overlay';
// A per-page name keeps two meetings open in two tabs from stealing each
// other's settings window. popupWin already handles reuse within one page.
const POPUP_NAME = `trussal-conductor-settings-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
const POPUP_FEATURES = 'popup=yes,width=560,height=760,resizable=yes,scrollbars=yes';
const LOAD_TIMEOUT_MS = 4000;
const APPLY_TIMEOUT_MS = 30000;
const ROLE_KEYS = ['frequencyBands', 'staggeredRound', 'unison', 'stereoTiles'];
const THEME_VARS = ['--trussal-primary', '--trussal-secondary', '--trussal-font', '--trussal-font-scale'];

// Exactly one of popupWin (a separate window) or fallbackRoot (an in-app
// overlay, used only when the popup is refused) is the live panel. panelRoot
// is whichever of them the form code should talk to right now.
let popupWin = null;
let fallbackRoot = null;
let panelRoot = null;
let dirty = false;
let loaded = false;
// { kind: 'load'|'apply', requestId, timer } — the request/answer correlation
// keeps another participant's concurrent Refresh from overwriting this form.
let pending = null;

function panelIsOpen() {
  return !!(panelRoot && panelRoot.isConnected && panelRoot.classList.contains('ts-open'));
}

function setStatus(text, state = '') {
  const el = panelRoot?.querySelector('.tc-status');
  if (!el) return;
  el.textContent = text;
  el.dataset.state = state;
}

function setBusy(on) {
  const root = panelRoot;
  if (!root) return;
  const apply = root.querySelector('.tc-apply');
  if (apply) apply.disabled = !!on || !loaded;
  const refresh = root.querySelector('.tc-refresh');
  if (refresh) refresh.disabled = !!on;
  for (const input of root.querySelectorAll('input')) input.disabled = !!on;
  root.setAttribute('aria-busy', on ? 'true' : 'false');
}

function clearPending() {
  if (pending?.timer) clearTimeout(pending.timer);
  pending = null;
}

function newRequestId() {
  return `cs-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function beginPending(kind, requestId, timeoutMs) {
  clearPending();
  pending = {
    kind,
    requestId,
    timer: setTimeout(() => {
      // A late answer is still accepted by onFleetStatus (and updates the
      // form), but the buttons must come back rather than stay disabled.
      if (!pending || pending.requestId !== requestId) return;
      pending = null;
      setBusy(false);
      setStatus(
        kind === 'apply'
          ? 'no answer from the conductor — the fleet may be offline'
          : 'no answer from the conductor — try Refresh',
        'error'
      );
    }, timeoutMs),
  };
}

function syncToggleState() {
  const btn = document.getElementById(BUTTON_ID);
  if (!btn) return;
  const on = panelIsOpen() || !!(popupWin && !popupWin.closed);
  btn.setAttribute('aria-expanded', String(on));
  btn.classList.toggle('on', on);
}

function closePanel() {
  const win = popupWin;
  popupWin = null;
  if (win && !win.closed) {
    try { win.close(); } catch (e) { /* already gone */ }
  }
  if (fallbackRoot) {
    fallbackRoot.classList.remove('ts-open');
    fallbackRoot.style.removeProperty('--tdr-h');
    fallbackRoot.style.removeProperty('--tdr-w');
    fallbackRoot.style.removeProperty('--tdr-top');
    fallbackRoot.style.removeProperty('--tdr-left');
    fallbackRoot.style.removeProperty('--tdr-right');
    fallbackRoot.style.removeProperty('--tdr-bottom');
    fallbackRoot.style.removeProperty('--tdr-max-h');
  }
  panelRoot = null;
  dirty = false;
  loaded = false;
  clearPending();
  syncToggleState();
}

function cleanupClosedPopup(win = popupWin) {
  if (!win || win !== popupWin) return;
  popupWin = null;
  panelRoot = null;
  dirty = false;
  loaded = false;
  clearPending();
  syncToggleState();
}

function markDirty() {
  if (pending) return;
  dirty = true;
  setStatus('unsaved changes');
}

function populateSettings(settings) {
  if (!panelRoot || !settings || typeof settings !== 'object') return;
  const form = panelRoot.querySelector('form');

  const rawMax = Number(settings.maxBots);
  const maxBots = Number.isFinite(rawMax) && rawMax > 0 ? Math.floor(rawMax) : 100;
  const slider = form.elements.maxBots;
  slider.max = String(Math.max(100, maxBots));
  slider.value = String(maxBots);
  panelRoot.querySelector('.tc-output').textContent = String(maxBots);

  const roles = settings.roles && typeof settings.roles === 'object' ? settings.roles : {};
  for (const key of ROLE_KEYS) {
    if (form.elements[key]) form.elements[key].checked = !!roles[key];
  }
  form.elements.varyHydra.checked = !!settings.varyHydra;

  const rawFps = Number(settings.fpsMin);
  form.elements.fpsMin.value = String(Number.isFinite(rawFps) ? rawFps : 15);
  const rawMem = Number(settings.memLimitMb);
  form.elements.memLimitMb.value = String(Number.isFinite(rawMem) ? rawMem : 900);

  dirty = false;
}

function readSettings() {
  const form = panelRoot?.querySelector('form');
  if (!form) return null;
  const clampInt = (value, min, max, fallback) => {
    const n = Math.floor(Number(value));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  const sliderMax = Number(form.elements.maxBots.max) || 100;
  return {
    maxBots: clampInt(form.elements.maxBots.value, 1, Math.max(1, sliderMax), 100),
    fpsMin: clampInt(form.elements.fpsMin.value, 1, 60, 15),
    memLimitMb: clampInt(form.elements.memLimitMb.value, 256, 8192, 900),
    varyHydra: !!form.elements.varyHydra.checked,
    roles: {
      frequencyBands: !!form.elements.frequencyBands.checked,
      staggeredRound: !!form.elements.staggeredRound.checked,
      unison: !!form.elements.unison.checked,
      stereoTiles: !!form.elements.stereoTiles.checked,
    },
  };
}

function loadSettings() {
  if (!panelIsOpen()) return;
  loaded = false;
  const requestId = newRequestId();
  beginPending('load', requestId, LOAD_TIMEOUT_MS);
  setBusy(true);
  setStatus('loading conductor settings…');
  sendFleetRequest('conductor-settings-get', { requestId });
}

function applySettings() {
  if (!panelIsOpen()) return;
  const settings = readSettings();
  if (!settings) return;
  const requestId = newRequestId();
  beginPending('apply', requestId, APPLY_TIMEOUT_MS);
  setBusy(true);
  setStatus('applying…');
  sendFleetRequest('conductor-settings-set', { settings, requestId });
}

function onFleetStatus(status) {
  if (!status || typeof status !== 'object') return;
  if (status.action !== 'conductor-settings' && status.action !== 'conductor-settings-error') return;
  if (!panelIsOpen()) return;

  const requestId = typeof status.requestId === 'string' ? status.requestId : null;
  if (pending && requestId && pending.requestId !== requestId) return;

  const answered = pending;
  if (answered) clearPending();

  if (status.action === 'conductor-settings-error') {
    if (answered) setBusy(false);
    setStatus(`error: ${status.reason || 'unknown error'}`, 'error');
    return;
  }
  if (!status.settings) {
    if (answered) setBusy(false);
    return;
  }
  // Someone else's panel refreshed/changed settings while this one has
  // unsaved edits. Do not stomp them; offer a refresh instead.
  if (!answered && dirty) {
    setStatus('conductor settings changed elsewhere — Refresh to load', 'warn');
    return;
  }
  loaded = true;
  populateSettings(status.settings);
  setBusy(false);
  if (answered?.kind === 'apply' || status.applied) setStatus('applied', 'ok');
  else setStatus('settings loaded', 'ok');
}

function buildPanel(doc, { popup }) {
  const root = doc.createElement('div');
  root.id = OVERLAY_ID;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-labelledby', 'trussal-conductor-title');
  root.innerHTML = `
    <div class="ts-header">
      <div class="ts-title" id="trussal-conductor-title">Conductor</div>
      <button class="ts-dwell-btn ts-collapse-btn" id="trussal-conductor-collapse" type="button" title="Collapse / expand panel" aria-label="Collapse or expand Conductor settings">▼</button>
      <button class="ts-close" type="button" title="Close Conductor settings" aria-label="Close Conductor settings">✕</button>
    </div>
    <form class="tc-form" novalidate>
      <div class="tc-scroll">
        <div class="ts-section">
          <div class="ts-section-head"><div class="ts-section-title">This meeting</div></div>
          <label class="tc-range-row">
            <span class="tc-label">Number of bots</span>
            <input class="tc-range" id="trussal-conductor-maxbots" type="range" name="maxBots" min="1" max="100" step="1" value="100">
            <output class="tc-output" for="trussal-conductor-maxbots">100</output>
          </label>
        </div>

        <div class="ts-section">
          <div class="ts-section-head"><div class="ts-section-title">Role stratification</div></div>
          <label class="tc-check"><input type="checkbox" name="frequencyBands"><span>Evenly spaced frequency bands (sound + visual)</span></label>
          <label class="tc-check"><input type="checkbox" name="staggeredRound" checked><span>Staggered round entry (worst-case-latency subdivisions)</span></label>
          <label class="tc-check"><input type="checkbox" name="unison"><span>Perfect unison</span></label>
          <label class="tc-check"><input type="checkbox" name="stereoTiles"><span>Evenly divided stereo image + Hydra tiles</span></label>
        </div>

        <div class="ts-section">
          <div class="ts-section-head"><div class="ts-section-title">Visuals</div></div>
          <label class="tc-check"><input type="checkbox" name="varyHydra"><span>Vary Hydra code per bot (each bot gets its own visual)</span></label>
        </div>

        <div class="ts-section">
          <div class="ts-section-head"><div class="ts-section-title">Health thresholds</div></div>
          <label class="tc-field"><span>Minimum fps cutoff</span><input class="tc-number" type="number" name="fpsMin" min="1" max="60" step="1" value="15"></label>
          <label class="tc-field"><span>Memory threshold (MB)</span><input class="tc-number" type="number" name="memLimitMb" min="100" max="4000" step="100" value="900"></label>
        </div>
      </div>
      <div class="tc-footer">
        <button class="ts-btn tc-apply" type="submit" disabled>Apply</button>
        <button class="ts-btn tc-refresh" type="button">Refresh</button>
        <span class="ts-status tc-status" role="status" aria-live="polite"></span>
      </div>
    </form>
  `;

  // Jitsi's toolbar popovers close on any outside click. Stop interactions in
  // the fallback overlay from reaching document, exactly as Studio does. (A
  // separate window has no Jitsi document to disturb; the guard is harmless.)
  root.addEventListener('mousedown', (e) => e.stopPropagation());
  root.addEventListener('click', (e) => e.stopPropagation());

  root.querySelector('.ts-close').addEventListener('click', closePanel);

  const collapseBtn = root.querySelector('#trussal-conductor-collapse');
  collapseBtn.addEventListener('click', () => {
    const collapsed = root.classList.contains('ts-collapsed');
    root.classList.toggle('ts-collapsed', !collapsed);
    collapseBtn.textContent = collapsed ? '▼' : '▲';
  });

  if (!popup) {
    // Same window behaviour as Studio for the fallback overlay (mouse
    // drag/resize + head-cursor ✥/⇲). The real popup is already a window;
    // resizing it belongs to the browser, not to an inner floating panel.
    attachPanelControls(root, {
      handle: root.querySelector('.ts-header'),
      minW: 320,
      minH: 240,
    });
  }

  const form = root.querySelector('form');
  const slider = form.elements.maxBots;
  const output = root.querySelector('.tc-output');
  slider.addEventListener('input', () => { output.textContent = slider.value; });
  form.addEventListener('input', markDirty);
  form.addEventListener('change', markDirty);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    applySettings();
  });
  root.querySelector('.tc-refresh').addEventListener('click', loadSettings);

  return root;
}

function syncPopupTheme(win = popupWin) {
  if (!win || win.closed) return;
  try {
    const sourceRoot = document.documentElement;
    const source = getComputedStyle(sourceRoot);
    const targetRoot = win.document.documentElement;
    const target = targetRoot.style;
    // rem in the panel CSS must resolve against the app's root size, not the
    // popup's browser default, or the 1.5x Studio type scale drifts.
    target.fontSize = source.fontSize;
    for (const name of THEME_VARS) {
      const value = source.getPropertyValue(name).trim();
      if (value) target.setProperty(name, value);
      else target.removeProperty(name);
    }
    // Invert is a class on <html>, not an anchor swap (see theme-context.css);
    // carry it over so the window matches an inverted personal theme.
    targetRoot.classList.toggle('trussal-invert', sourceRoot.classList.contains('trussal-invert'));
  } catch (e) { /* the window is closing */ }
}

function installPopupStyles(win) {
  const doc = win.document;

  const copyStylesheet = (node) => {
    if (node.tagName === 'LINK') {
      const link = doc.createElement('link');
      link.rel = 'stylesheet';
      link.href = node.href;
      doc.head.appendChild(link);
      return;
    }
    const style = doc.createElement('style');
    style.textContent = node.textContent;
    doc.head.appendChild(style);
  };

  // Production loads the bundled stylesheet once via <link id="trussal-styles">.
  // In dev Vite injects each imported file as a <style data-vite-dev-id>; copy
  // those too so the popup looks the same without a separate CSS build.
  const bundle = document.getElementById('trussal-styles')
    || document.querySelector('link[rel="stylesheet"][href*="custom-config.css"]');
  if (bundle) copyStylesheet(bundle);

  for (const style of document.querySelectorAll('style[data-vite-dev-id]')) {
    const id = style.getAttribute('data-vite-dev-id') || '';
    if (id.includes('/src/') || id.includes('/components/')) copyStylesheet(style);
  }
}

function setupPopup(win) {
  const doc = win.document;
  doc.open();
  doc.write('<!doctype html><html lang="en"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>Trussal Conductor</title></head>'
    + '<body class="trussal-conductor-window"></body></html>');
  doc.close();
  doc.title = 'Trussal Conductor';
  installPopupStyles(win);
  syncPopupTheme(win);

  const root = buildPanel(doc, { popup: true });
  doc.body.appendChild(root);
  root.classList.add('ts-open');

  // The popup is controlled entirely from this window (no scripts of its
  // own). If the user closes it — or the meeting page is unloaded — drop the
  // live reference so the next click opens a fresh one.
  win.addEventListener('beforeunload', () => cleanupClosedPopup(win), { once: true });
  win.addEventListener('pagehide', () => cleanupClosedPopup(win), { once: true });
  win.focus();
  return root;
}

function openPopup() {
  let win = null;
  try {
    win = window.open('', POPUP_NAME, POPUP_FEATURES);
  } catch (e) {
    win = null;
  }
  if (!win) return null;
  try {
    popupWin = win;
    const root = setupPopup(win);
    panelRoot = root;
    syncToggleState();
    loadSettings();
    return root;
  } catch (e) {
    console.warn('[conductor] separate window failed; opening the in-app panel instead', e);
    try { win.close(); } catch (err) { /* already gone */ }
    if (popupWin === win) popupWin = null;
    panelRoot = null;
    return null;
  }
}

function ensureFallbackPanel() {
  if (fallbackRoot) return fallbackRoot;
  if (!document.body) return null;
  fallbackRoot = buildPanel(document, { popup: false });
  return fallbackRoot;
}

function openFallbackPanel() {
  const root = ensureFallbackPanel();
  if (!root) return null;
  if (!root.isConnected) document.body.appendChild(root);
  panelRoot = root;
  root.classList.add('ts-open');
  syncToggleState();
  loadSettings();
  return root;
}

function openPanel() {
  if (popupWin && !popupWin.closed) {
    try { popupWin.focus(); } catch (e) { /* ignore */ }
    return panelRoot;
  }
  if (popupWin && popupWin.closed) cleanupClosedPopup(popupWin);
  return openPopup() || openFallbackPanel();
}

function ensureToggle() {
  const host = document.getElementById('trussal-studio-buttons');
  if (!host) return null;
  let btn = document.getElementById(BUTTON_ID);
  if (!btn) {
    btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.type = 'button';
    btn.className = 'ts-dwell-btn';
    btn.textContent = 'Conductor';
    btn.title = 'Open Conductor settings in a separate window';
    btn.setAttribute('aria-expanded', 'false');
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (popupWin && !popupWin.closed) {
        try { popupWin.focus(); } catch (err) { /* ignore */ }
        return;
      }
      if (popupWin && popupWin.closed) cleanupClosedPopup(popupWin);
      // A fallback overlay toggles like a Studio window; a separate window is
      // focused rather than closed when its button is clicked again.
      if (panelRoot) { closePanel(); return; }
      openPanel();
    });
  }
  if (btn.parentElement !== host) host.appendChild(btn);
  syncToggleState();
  return btn;
}

function tick() {
  if (popupWin && popupWin.closed) cleanupClosedPopup(popupWin);

  // The Studio toolbar is the single source of "in a live meeting" in this
  // app. It already handles welcome/prejoin/lobby and Jitsi's auto-hide, so
  // the Conductor button appears and disappears with its sibling buttons.
  const toolbar = document.getElementById('trussal-studio-toolbar');
  const inMeeting = !!getRoomNameFromUrl() && !!toolbar && !toolbar.classList.contains('ts-hidden');
  const btn = document.getElementById(BUTTON_ID);
  if (!inMeeting) {
    if (btn) btn.classList.add('ts-hidden');
    closePanel();
    return;
  }
  const visible = ensureToggle();
  if (visible) visible.classList.remove('ts-hidden');
  if (popupWin) syncPopupTheme(popupWin);
}

// A meeting page unload must not leave an orphaned settings window behind;
// its controller (this bundle) would be gone, and it could no longer refresh
// or apply anything.
function onPageHide() {
  closePanel();
}
window.addEventListener('pagehide', onPageHide);

const unsubscribeFleet = subscribeFleetStatus(onFleetStatus);
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  tick();
} else {
  window.addEventListener('DOMContentLoaded', tick);
}
const tickTimer = setInterval(tick, 1000);

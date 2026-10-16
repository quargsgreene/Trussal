// Panel background patterns — RETIRED.
// 
// The original implementation dispatched a SET_VIRTUAL_BACKGROUND action to the
// Jitsi web app's Redux store. With Trussal serving its own standalone page and
// no longer injecting into the Jitsi web app shell, there is no Jitsi web app
// background effect pipeline to target. lib-jitsi-meet alone does not provide
// the same out-of-the-box virtual-background effect without vendoring the Jitsi
// web client's effect implementation. The `panel()` control is kept present so
// existing programs do not break, but it is a no-op under the standalone
// backend. If you need virtual backgrounds in the standalone build, they will
// need a Trussal-native track-effect pipeline.

import { getLocalPeer, isPeerJPatternTurn } from './peer-state.js';
import { imageUrlByFilename } from './user-samples.js';

let currentSource = null; // retained only so the renderer can detect repeats
let warnedRetired = false;

function dispatchVirtualBackground(virtualSource) {
  if (!warnedRetired) {
    warnedRetired = true;
    console.warn('[panel-bg] virtual background (panel()) is retired in the standalone build — no Jitsi web app backend available');
  }
  return true;
}

// Filename → image source. An upload by that exact name wins (the picture
// travels with the performer's own browser, exactly as img() does for
// Hydra); otherwise the name is passed straight through as Jitsi's own
// virtualSource, on the chance it names one of Jitsi's bundled defaults —
// this repo has no vendored copy of those filenames to validate against.
function resolvePanelSource(name) {
  const uploaded = imageUrlByFilename(name);
  return uploaded || name;
}

function handleTrigger(hap, currentTime, cps, targetTime) {
  const value = hap?.value;
  if (!value || value.panel == null) return;
  const name = String(value.panel);

  const lead = Number(targetTime) - Number(currentTime);
  const delayMs = Number.isFinite(lead) ? Math.max(0, lead * 1000) : 0;
  setTimeout(() => {
    if (!isPeerJPatternTurn(getLocalPeer()?.jitsiId)) return;
    if (name === currentSource) return;
    currentSource = name;
    dispatchVirtualBackground(resolvePanelSource(name));
  }, delayMs);
}

export function installPanelBg(mod) {
  const { registerControl, register } = mod;
  const scope = { ...registerControl('panel') };
  register('_pbRender', (pat) => pat.onTrigger(handleTrigger, true));
  return scope;
}

// Reverts to no virtual background, the same "stopping is always a way back
// to a usable UI" contract css-cycles.js's stopCssCycles() carries — a
// panel(), unlike a word() bubble, is not history worth leaving on screen.
export function stopPanelBg() {
  if (currentSource == null) return;
  currentSource = null;
  dispatchVirtualBackground(null);
}

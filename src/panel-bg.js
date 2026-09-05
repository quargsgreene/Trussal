// Panel background patterns — Strudel patterns that swap the performer's own
// Jitsi video-tile virtual background, timed by the usual fast/slow/sometimes/
// degrade family (free, since panel() returns an ordinary Strudel Pattern):
//
//   $: panel("<forest.jpg office.jpg>").slow(4)
//   $: panel('my background.png')   // a name with a space bypasses mini
//
// LOCAL ONLY BY CONSTRUCTION, for the same reason reactions.js is: a virtual
// background is an effect on the AUTHOR's own outgoing video track, so
// buildPeerBlock strips panel() out of every other peer's contribution
// before it reaches this renderer (silent-voice-core.js's stripCalls) — only
// the peer who wrote it ever has their own browser apply it. Once applied,
// the resulting video is what the rest of the room already sees, the same
// way it already sees the outcome of anyone else's local video effects.
//
// SILENT BY CONSTRUCTION, same mechanism as reaction()/word() — the renderer
// carries a dominant onTrigger so a panel() voice never also tries to reach
// superdough. No atom minting: a plain filename is already a grammar-legal
// mini-notation atom (a name with a space needs single quotes instead, which
// bypass mini entirely — see text-cycles.js's doc comment for the same rule).

import { getLocalPeer, isPeerJPatternTurn } from './peer-state.js';
import { imageUrlByFilename } from './user-samples.js';

let currentSource = null; // the last name actually applied, so a repeated
                           // fire under fast()/degrade() is a no-op rather
                           // than re-running Jitsi's effect pipeline.

// Best-effort dispatch into Jitsi's own virtual-background feature — the same
// "if the internal shape drifts this simply does nothing" contract as
// text-cycles.js's openChatPanel() and reactions.js's sendJitsiReaction().
// Unlike those, setting a REAL virtual background is not just a state flip —
// Jitsi's own Background dialog builds a JitsiStreamBackgroundEffect and
// calls track.setEffect() on the local video track — so this dispatch is the
// best that can be done from outside that pipeline without vendoring Jitsi's
// own web client; a build against a live deployment should confirm it lands.
function dispatchVirtualBackground(virtualSource) {
  try {
    const store = typeof window !== 'undefined' ? window.APP?.store : null;
    if (!store || typeof store.dispatch !== 'function') return false;
    store.dispatch({
      type: 'SET_VIRTUAL_BACKGROUND',
      virtualSource,
      backgroundType: virtualSource ? 'image' : 'none',
    });
    return true;
  } catch (e) {
    console.warn('[panel-bg] could not dispatch to Jitsi', e);
    return false;
  }
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

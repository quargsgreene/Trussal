// Editor routing — browser wiring.
//
// Tracks the last-focused code editor and routes reads/writes/evaluation:
//   - 'strudel'   → textarea + sendLocalPattern + Strudel eval (personal)
//   - 'netcycles' → CRDT doc + applyProgramText (global, shared)
// Used by facial-gesture.js (head-cursor mutators, gesture regex swaps) and
// the on-screen keyboard so every input modality works in both editors.

import { classifyEditor, applyRegexMutation, toggleNetCyclesSnippet } from './editor-router-core.js';
import {
  ensureMetaprogramSync,
  applyProgramText,
  getProgramText
} from './audio-net/Metaprogrammer.js';
import { getLocalPeer, sendLocalPattern } from './peer-state.js';

export { classifyEditor, applyRegexMutation } from './editor-router-core.js';

let lastKind = 'strudel';

// Call once; keeps lastKind fresh from focus events.
let tracking = false;
export function trackEditorFocus() {
  if (tracking || typeof document === 'undefined') return;
  tracking = true;
  document.addEventListener('focusin', (e) => {
    const kind = e.target && e.target.classList ? classifyEditor(e.target.classList) : null;
    if (kind) lastKind = kind;
  });
}

export function activeEditorKind() { return lastKind; }

function strudelTextarea() {
  // The personal editor is the detail-panel .ts-code that is NOT the shared
  // NetCycles one.
  return document.querySelector('#trussal-studio-overlay .ts-detail .ts-code:not(.nc-code)') ||
    document.querySelector('#trussal-studio-overlay .ts-code:not(.nc-code)');
}

function netcyclesTextarea() {
  return document.querySelector('#trussal-studio-overlay .nc-code');
}

export function readActiveEditor() {
  if (lastKind === 'netcycles') {
    const sync = ensureMetaprogramSync();
    return sync.getText() || getProgramText() || '';
  }
  const ta = strudelTextarea();
  return ta ? ta.value : (getLocalPeer()?.pattern ?? '');
}

export function writeActiveEditor(code, { modality = 'head-cursor' } = {}) {
  if (lastKind === 'netcycles') {
    const sync = ensureMetaprogramSync();
    sync.setText(code, 'local');
    const ta = netcyclesTextarea();
    if (ta && ta.value !== code) ta.value = code;
    document.dispatchEvent(new CustomEvent('trussal-netcycles-program', { detail: { text: code, modality } }));
    return;
  }
  const ta = strudelTextarea();
  if (ta) ta.value = code;
  sendLocalPattern(code);
}

// Evaluate whatever the active editor holds. Returns { kind, errors }.
// Strudel evaluation stays with the caller (facial-gesture / studio own the
// user-gesture boot path); this only owns the NetCycles apply.
export function applyIfNetCycles() {
  if (lastKind !== 'netcycles') return null;
  const errors = applyProgramText(readActiveEditor());
  return { kind: 'netcycles', errors };
}

// Gesture binding target: apply the shared metaprogram as it currently
// stands, regardless of which editor has focus.
export function applyMetaprogramNow() {
  return applyProgramText(readNetCyclesText());
}

// NetCyclesButton dwell target: toggle the snippet in the shared doc and
// apply. Mirrors toggleButtonCode for the personal editor.
export function toggleNetCyclesButtonCode(snippet) {
  const next = toggleNetCyclesSnippet(readNetCyclesText(), snippet);
  const sync = ensureMetaprogramSync();
  sync.setText(next, 'local');
  const ta = netcyclesTextarea();
  if (ta) ta.value = next;
  applyProgramText(next);
}

function readNetCyclesText() {
  const sync = ensureMetaprogramSync();
  return sync.getText() || getProgramText() || '';
}

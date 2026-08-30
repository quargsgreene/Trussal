// Editor routing — browser wiring.
//
// Tracks the last-focused code editor and routes reads/writes/evaluation:
//   - 'strudel'   → textarea (writes stay local; evaluation broadcasts —
//                   onEvalAndPlay / evaluate() send the pattern themselves)
//   - 'jpattern' → CRDT doc (writes sync the shared TEXT) + applyProgramText
//                   (the explicit RUN signal)
// Used by facial-gesture.js (head-cursor mutators, gesture regex swaps) and
// the on-screen keyboard so every input modality works in both editors.

import { classifyEditor, applyRegexMutation, toggleJPatternSnippet } from './editor-router-core.js';
import {
  ensureMetaprogramSync,
  applyProgramText,
  getProgramText
} from './audio-net/Metaprogrammer.js';
import { getLocalPeer } from './peer-state.js';

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

// Whether this peer may write the shared metaprogram at all. Bots whose owner
// withheld the permission may not; the sidecar drops their updates anyway, so
// this is what keeps the local UI from pretending otherwise.
export function metaprogramReadOnly() {
  const peer = getLocalPeer();
  return !!peer.isBot && peer.canEditMetaprogram === false;
}

function strudelTextarea() {
  // The personal editor is the detail-panel .ts-code that is NOT the shared
  // JPattern one.
  return document.querySelector('#trussal-studio-overlay .ts-detail .ts-code:not(.jp-code)') ||
    document.querySelector('#trussal-studio-overlay .ts-code:not(.jp-code)');
}

function jpatternTextarea() {
  return document.querySelector('#trussal-studio-overlay .jp-code');
}

export function readActiveEditor() {
  if (lastKind === 'jpattern') {
    const sync = ensureMetaprogramSync();
    return sync.getText() || getProgramText() || '';
  }
  const ta = strudelTextarea();
  return ta ? ta.value : (getLocalPeer()?.pattern ?? '');
}

export function writeActiveEditor(code, { modality = 'head-cursor' } = {}) {
  if (lastKind === 'jpattern') {
    const sync = ensureMetaprogramSync();
    sync.setText(code, 'local');
    const ta = jpatternTextarea();
    if (ta && ta.value !== code) ta.value = code;
    document.dispatchEvent(new CustomEvent('trussal-jpattern-program', { detail: { text: code, modality } }));
    return;
  }
  // Writing is typing, not running: the pattern reaches peers when an
  // explicit eval (onEvalAndPlay / facial-gesture evaluate) sends it.
  const ta = strudelTextarea();
  if (ta) ta.value = code;
}

// Evaluate whatever the active editor holds. Returns { kind, errors }.
// Strudel evaluation stays with the caller (facial-gesture / studio own the
// user-gesture boot path); this only owns the JPattern apply.
export function applyIfJPattern() {
  if (lastKind !== 'jpattern') return null;
  const errors = applyProgramText(readActiveEditor());
  return { kind: 'jpattern', errors };
}

// Gesture binding target: apply the shared metaprogram as it currently
// stands, regardless of which editor has focus.
export function applyMetaprogramNow() {
  return applyProgramText(readJPatternText());
}

// JPatternButton dwell/click target: toggle the declared statement in the
// shared doc and apply. Mirrors toggleButtonCode for the personal editor.
// Returns the parse errors of the resulting program — a button can produce an
// invalid one (removing the last participant empties the sequence), and the
// caller shows them rather than letting the press look like it did nothing.
export function toggleJPatternButtonCode(snippet) {
  // The editor card renders a read-only peer's buttons `disabled`, but a
  // head-cursor dwell never goes through click() — it calls this directly, and
  // a disabled button still has a bounding box to hover. The guard has to be
  // here, at the one place both paths meet.
  if (metaprogramReadOnly()) return [];
  const next = toggleJPatternSnippet(readJPatternText(), snippet);
  const sync = ensureMetaprogramSync();
  sync.setText(next, 'local');
  const ta = jpatternTextarea();
  if (ta) ta.value = next;
  // Announce the new text whether or not it applies: the press came from a
  // button (or a head-cursor dwell) that is nowhere near the textarea, and the
  // editor has to re-render its own button row either way. applyProgramText
  // fires this event again on success, which is an idempotent refresh.
  document.dispatchEvent(new CustomEvent('trussal-jpattern-program', {
    detail: { text: next, modality: 'button' }
  }));
  return applyProgramText(next);
}

function readJPatternText() {
  const sync = ensureMetaprogramSync();
  return sync.getText() || getProgramText() || '';
}

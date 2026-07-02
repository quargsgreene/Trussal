// Shared Net Cycles metaprogram editor (vanilla DOM, no framework).
//
// One global card: a textarea two-way-bound to the CRDT doc (per-keystroke
// diffs → Yjs; remote updates → textarea with cursor preservation),
// parse-on-idle with inline line/col errors, and an explicit Apply that
// evaluates the program room-wide. Bots get a read-only view (the sidecar
// drops their updates anyway — this is just honest UI).

import {
  ensureMetaprogramSync,
  applyProgramText,
  getProgramText,
  isNetCyclesActive
} from '../src/audio-net/Metaprogrammer.js';
import { parseMetaprogram } from '../src/audio-net/MetaprogrammerParser.js';
import { getLocalPeer } from '../src/peer-state.js';

const PARSE_IDLE_MS = 300;

export function mountMetaprogrammerEditor(container) {
  if (!container || container.querySelector('.nc-editor')) return null;

  const wrap = document.createElement('div');
  wrap.className = 'ts-section nc-editor';
  wrap.innerHTML = `
    <div class="ts-section-head">
      <div class="ts-section-title">Net Cycles — shared metaprogram</div>
      <div class="ts-section-controls">
        <button class="ts-btn eval ts-dwell-btn nc-apply" type="button">▶ Apply</button>
        <span class="ts-shortcuts">Ctrl+Enter to apply</span>
      </div>
    </div>
    <textarea class="ts-code nc-code" spellcheck="false" style="min-height:96px;"></textarea>
    <div class="ts-meta nc-errors" style="color:#ff8a8a;"></div>
    <div class="ts-meta nc-byline"></div>
  `;
  container.appendChild(wrap);

  const ta = wrap.querySelector('.nc-code');
  const errorsEl = wrap.querySelector('.nc-errors');
  const bylineEl = wrap.querySelector('.nc-byline');
  const applyBtn = wrap.querySelector('.nc-apply');

  const sync = ensureMetaprogramSync();
  const readOnly = !!getLocalPeer().isBot && getLocalPeer().canEditMetaprogram === false;
  if (readOnly) {
    ta.setAttribute('readonly', 'readonly');
    applyBtn.disabled = true;
  }

  ta.value = sync.getText() || getProgramText() || '';

  let parseTimer = null;
  function showErrors(text) {
    const { errors } = parseMetaprogram(text);
    errorsEl.textContent = errors.length
      ? errors.map(e => `${e.line}:${e.col} ${e.message}`).join('  ·  ')
      : '';
    applyBtn.disabled = readOnly || errors.length > 0;
    return errors;
  }
  function parseOnIdle() {
    clearTimeout(parseTimer);
    parseTimer = setTimeout(() => showErrors(ta.value), PARSE_IDLE_MS);
  }

  // Local typing → CRDT doc.
  ta.addEventListener('input', () => {
    if (readOnly) return;
    sync.setText(ta.value);
    parseOnIdle();
  });

  // Remote/roster changes → textarea, preserving the caret when possible.
  const refreshFromDoc = () => {
    const next = sync.getText();
    if (ta.value === next) return;
    const hadFocus = document.activeElement === ta;
    const selStart = ta.selectionStart, selEnd = ta.selectionEnd;
    ta.value = next;
    if (hadFocus) {
      const clamp = (n) => Math.min(n, next.length);
      try { ta.setSelectionRange(clamp(selStart), clamp(selEnd)); } catch (e) {}
    }
    parseOnIdle();
  };
  sync.onRemoteChange((_, payload) => {
    refreshFromDoc();
    if (payload && payload.authorIndex != null) {
      bylineEl.textContent = `last edit by ${payload.authorIndex} (${payload.modality || 'keyboard'})`;
    }
  });
  document.addEventListener('trussal-netcycles-program', refreshFromDoc);

  const apply = () => {
    if (readOnly) return;
    const errors = applyProgramText(ta.value);
    if (errors.length) showErrors(ta.value);
    else {
      errorsEl.textContent = '';
      bylineEl.textContent = isNetCyclesActive()
        ? 'applied — takes effect at the next cycle boundary'
        : 'applied — will run when Net Cycles is switched on';
    }
  };
  applyBtn.addEventListener('click', apply);
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); apply(); }
  });

  showErrors(ta.value);
  return wrap;
}

// Shared Net Cycles metaprogram editor (vanilla DOM, no framework).
//
// One global card: a textarea two-way-bound to the CRDT doc (per-keystroke
// diffs → Yjs; remote updates → textarea with cursor preservation),
// parse-on-idle with inline line/col errors, and an explicit Apply that
// evaluates the program room-wide. Typing syncs the shared TEXT only —
// nothing runs until ▶ Apply / Ctrl+Enter stamps an 'apply' update, which is
// the sole signal the aggregator's ring (and any armed scheduler) acts on.
// Bots get a read-only view (the sidecar drops their updates anyway — this
// is just honest UI).
//
// Button parity with the personal Strudel card: a `*`-prefixed statement
// (`*$ participants <2a 2b>`) declares a voice rather than running it, and
// shows up as a button below the code. Pressing it — by mouse or by holding
// the head cursor on it, which is what `.nc-head-btn` marks it as — writes
// the voice into the program and applies; pressing again takes it out.

import {
  ensureMetaprogramSync,
  applyProgramText,
  getProgramText
} from '../src/audio-net/Metaprogrammer.js';
import { parseMetaprogram } from '../src/audio-net/MetaprogrammerParser.js';
import { parseNetCyclesButtons } from '../src/editor-router-core.js';
import { toggleNetCyclesButtonCode, metaprogramReadOnly } from '../src/editor-router.js';
import { refreshFacialGestureButtons } from '../src/facial-gesture.js';

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
    <div class="ts-voice-btns nc-voice-btns"></div>
    <div class="ts-meta nc-errors" style="color:#ff8a8a;"></div>
    <div class="ts-meta nc-byline"></div>
  `;
  container.appendChild(wrap);

  const ta = wrap.querySelector('.nc-code');
  const errorsEl = wrap.querySelector('.nc-errors');
  const bylineEl = wrap.querySelector('.nc-byline');
  const applyBtn = wrap.querySelector('.nc-apply');
  const btnsEl = wrap.querySelector('.nc-voice-btns');

  const sync = ensureMetaprogramSync();
  const readOnly = metaprogramReadOnly();
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

  const esc = (s) => String(s).replace(/[&<>"']/g,
    c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

  // One button per `*`-declared statement. `.nc-head-btn` + data-netcycles-code
  // is the head-cursor dwell contract (facial-gesture.js), so a dwell and a
  // click run the very same toggle.
  function renderButtons() {
    const buttons = parseNetCyclesButtons(ta.value);
    btnsEl.innerHTML = buttons.map(b =>
      `<button class="ts-voice-btn nc-head-btn${b.active ? ' on' : ''}" type="button"` +
      ` data-netcycles-code="${esc(b.snippet)}"` +
      ` title="${esc(b.snippet)}"${readOnly ? ' disabled' : ''}>▶ ${esc(b.label)}</button>`
    ).join('');
    btnsEl.querySelectorAll('.nc-head-btn').forEach(btn => {
      btn.addEventListener('click', () => press(btn.dataset.netcyclesCode));
    });
    // The head-cursor bar in the facial-control panel lists the same buttons
    // whenever this editor holds focus; keep it in step with the declarations
    // as they are typed rather than waiting for the next studio re-render.
    refreshFacialGestureButtons();
  }

  function press(snippet) {
    if (readOnly) return;
    const errors = toggleNetCyclesButtonCode(snippet);
    // toggleNetCyclesButtonCode has already written the textarea and the doc,
    // and its 'trussal-netcycles-program' event has already re-rendered the
    // button row — only the error line and the byline are left to update.
    showErrors(ta.value);
    bylineEl.textContent = errors.length
      ? 'button left the program invalid — fix it above, then apply'
      : 'applied — takes effect at the next cycle boundary';
  }

  // Local typing → CRDT doc.
  ta.addEventListener('input', () => {
    if (readOnly) return;
    sync.setText(ta.value);
    parseOnIdle();
    renderButtons();
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
    renderButtons();
  };
  sync.onRemoteChange((_, payload) => {
    refreshFromDoc();
    if (payload && payload.authorIndex != null) {
      bylineEl.textContent = `last edit by ${payload.authorIndex} (${payload.modality || 'keyboard'})`;
    }
  });
  // A head-cursor dwell writes the textarea itself, so refreshFromDoc sees no
  // change and returns early — the button row still has to be re-read, since
  // what the dwell changed is exactly which buttons are on.
  document.addEventListener('trussal-netcycles-program', () => {
    refreshFromDoc();
    renderButtons();
  });

  const apply = () => {
    if (readOnly) return;
    const errors = applyProgramText(ta.value);
    if (errors.length) showErrors(ta.value);
    else {
      errorsEl.textContent = '';
      bylineEl.textContent = 'applied — takes effect at the next cycle boundary';
    }
    renderButtons();
  };
  applyBtn.addEventListener('click', apply);
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); apply(); }
  });

  showErrors(ta.value);
  renderButtons();
  return wrap;
}

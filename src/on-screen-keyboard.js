// on-screen-keyboard.js
// On-screen QWERTY keyboard with head-cursor dwell, drag, collapse, and word
// autocomplete ("autopredict"). It types into whichever Trussal Studio code
// editor was last focused — the personal Strudel textarea or the shared
// JPattern metaprogram editor — and its Eval key routes the same way
// studio.js's own eval does. Outside a meeting, where the Studio toolbar
// doesn't exist, it targets the two
// Jitsi-native name fields instead: the prejoin screen's display-name input
// and the lobby knock screen's name field (Eval is a no-op on those — see
// _isTypingTarget / PREJOIN_NAME_ID / LOBBY_NAME_ID).
//
// The autopredict row is a head-cursor affordance: its chips are dwell
// targets, so it only appears while the MediaPipe head cursor (the Face
// toggle) is on — see isHeadCursorEnabled() in _updatePredictions().
//
// The toggle lives in the Trussal Studio toolbar group (injectKeyboardToggle),
// next to the Face button. The panel itself stays a body-level fixed element
// so it can be dragged anywhere and span the full width; tickKbdUi() retracts
// it when the meeting ends, but it is no longer tied to any one Studio window.
//
// The 🌐 key (bottom left) opens a menu of writing systems
// (writing-systems-core.js): picking one swaps the QWERTY rows for that
// script's pages, and the choice is remembered per browser. IPA stays its own
// key on every layout, and its ABC key returns to whichever script was on.

import { wordPrefixAt, predictCompletions } from './on-screen-keyboard-core.js';
import { IPA_PAGES, ipaKeyLabel } from './ipa-core.js';
import {
  WRITING_SYSTEMS, DEFAULT_SYSTEM, PER_ROW, writingSystem, systemPages, composeHangul,
} from './writing-systems-core.js';
import { EMOJI_MIMES, shortcode } from './custom-emoji-core.js';
import {
  addEmojiFromFile, removeEmoji, listOwnEmoji, emojiUrl, subscribeCustomEmoji, initCustomEmoji,
} from './custom-emoji.js';
import { isHeadCursorEnabled, setHeadCursorEnabled, setGestureDetectionEnabled } from './facial-gesture.js';
import {
  attachHeadDragResize, isHeadDragActive, setPanelBox, pinTopLeft as _pinTopLeft,
} from './panel-drag-resize.js';

export { pinTopLeft as _pinTopLeft } from './panel-drag-resize.js';

const KBD_PANEL_ID  = 'trussal-kbd-panel';
const KBD_TOGGLE_ID = 'trussal-kbd-toggle';
const DWELL_MS      = 1000;
// Per-viewer convenience: which writing system the keyboard was last left on.
const SYSTEM_STORAGE_KEY = 'trussal-kbd-writing-system';

// The single-line fields that live outside a meeting — Trussal's own welcome
// overlay room-name box, the prejoin display-name input and the lobby knock
// name field — are the other typing targets the on-screen keyboard has to
// reach. They're why Landmark and Gesture Mode holds the keyboard open
// standalone on those screens (see setKeyboardStandalone below); without this
// a performer with no physical keyboard could open the panel there but nothing
// they pressed would land anywhere.
const WELCOME_ROOM_ID = 'trussal-room-input';
const PREJOIN_NAME_ID = 'premeeting-name-input';
const LOBBY_NAME_ID   = 'lobby-name-field';
const NATIVE_FIELD_IDS = [WELCOME_ROOM_ID, PREJOIN_NAME_ID, LOBBY_NAME_ID];

function _isTypingTarget(el) {
  return !!el && (
    (el.classList && el.classList.contains('ts-code')) ||
    NATIVE_FIELD_IDS.includes(el.id)
  );
}

// The prejoin and lobby name fields are React-controlled: assigning `.value`
// directly and firing `input` does nothing, because React's value tracker
// already recorded the new string via its own setter override and so sees no
// change to forward to onChange — React then reverts the DOM on its next
// render and the Join button never enables. Writing through the native
// prototype setter leaves the tracker stale, so the `input` event registers
// as a real change. Trussal's own welcome overlay input is a plain uncontrolled
// field, where this is simply equivalent to `el.value = v`.
function _setNativeValue(el, value) {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value);
  else el.value = value;
}

// ── Layout (total = 14.5 flex-units per row) ────────────────────────────────────
const ROWS = [
  [
    {l:'`',k:'`',s:'~'},{l:'1',k:'1',s:'!'},{l:'2',k:'2',s:'@'},{l:'3',k:'3',s:'#'},
    {l:'4',k:'4',s:'$'},{l:'5',k:'5',s:'%'},{l:'6',k:'6',s:'^'},{l:'7',k:'7',s:'&'},
    {l:'8',k:'8',s:'*'},{l:'9',k:'9',s:'('},{l:'0',k:'0',s:')'},{l:'-',k:'-',s:'_'},
    {l:'=',k:'=',s:'+'},
    {l:'⌫',k:'Backspace',w:1.5},
  ],
  [
    {l:'⇥',k:'Tab',w:1.5},
    {l:'q',k:'q',s:'Q'},{l:'w',k:'w',s:'W'},{l:'e',k:'e',s:'E'},{l:'r',k:'r',s:'R'},
    {l:'t',k:'t',s:'T'},{l:'y',k:'y',s:'Y'},{l:'u',k:'u',s:'U'},{l:'i',k:'i',s:'I'},
    {l:'o',k:'o',s:'O'},{l:'p',k:'p',s:'P'},{l:'[',k:'[',s:'{'},{l:']',k:']',s:'}'},
    {l:'\\',k:'\\',s:'|'},
  ],
  [
    {l:'⇪',k:'CapsLock',w:1.5},
    {l:'a',k:'a',s:'A'},{l:'s',k:'s',s:'S'},{l:'d',k:'d',s:'D'},{l:'f',k:'f',s:'F'},
    {l:'g',k:'g',s:'G'},{l:'h',k:'h',s:'H'},{l:'j',k:'j',s:'J'},{l:'k',k:'k',s:'K'},
    {l:'l',k:'l',s:'L'},{l:';',k:';',s:':'},{l:"'",k:"'",s:'"'},
    {l:'↵',k:'Enter',w:2},
  ],
  [
    {l:'⇧',k:'ShiftLeft',w:2.25},
    {l:'z',k:'z',s:'Z'},{l:'x',k:'x',s:'X'},{l:'c',k:'c',s:'C'},{l:'v',k:'v',s:'V'},
    {l:'b',k:'b',s:'B'},{l:'n',k:'n',s:'N'},{l:'m',k:'m',s:'M'},{l:',',k:',',s:'<'},
    {l:'.',k:'.',s:'>'},{l:'/',k:'/',s:'?'},
    {l:'⇧',k:'ShiftRight',w:2.25},
  ],
  [
    {l:'🌐',k:'Globe',w:1.5,title:'Choose a writing system'},
    {l:'←',k:'ArrowLeft',w:1.25},{l:'↑',k:'ArrowUp',w:1.25},{l:'↓',k:'ArrowDown',w:1.25}, {l:'→',k:'ArrowRight',w:1.25},
    {l:'IPA',k:'IPA',w:1.5,title:'Show the IPA keyboard'},
    {l:'space',k:' ',w:4.5}, {l:'↵eval',k:'Eval',w:2},
  ],
];

// ── Writing-system layout ────────────────────────────────────────────────────
// Any script other than Latin: a tab row when it has more than one page, the
// page's keys, and an editing row that keeps 🌐 in the bottom-left corner.
function _scriptRows() {
  const ws    = writingSystem(_system);
  const pages = ws.id === 'emoji' ? [..._ownEmojiPages(), ...systemPages(ws)] : systemPages(ws);
  const page  = pages.find(p => p.id === _sysPage) || pages[0];
  const perRow = page.perRow || PER_ROW;
  const rows  = [];
  if (pages.length > 1) {
    rows.push(pages.map(p => ({
      l: p.label, k: `SysPage:${p.id}`, w: perRow / pages.length,
      title: `${ws.label}: ${p.label}`, on: p.id === page.id,
    })));
  }
  for (const r of page.rows) {
    const row = r.map(kd => ({ ...kd, script: true }));
    if (row.length < perRow) row.push({ spacer: true, w: perRow - row.length });
    rows.push(row);
  }
  const shift = page.rows.some(r => r.some(kd => kd.s));
  rows.push([
    {l:'🌐',k:'Globe',w:1.5,title:'Choose a writing system'},
    ...(shift ? [{l:'⇧',k:'ShiftLeft',w:1.5}] : []),
    {l:'←',k:'ArrowLeft'},{l:'→',k:'ArrowRight'},
    {l:'⌫',k:'Backspace',w:1.5},
    {l:'space',k:' ',w:shift ? 3.5 : 5},
    {l:'↵',k:'Enter',w:1.5},
    {l:'IPA',k:'IPA',w:1.5,title:'Show the IPA keyboard'},
    {l:'↵eval',k:'Eval',w:2},
  ]);
  return rows;
}

// ── Uploaded emoji ("Mine") ──────────────────────────────────────────────────
// The emoji keyboard's first page(s): ＋ to upload an image (or drop one on
// the keyboard), 🗑 to switch to deleting, then this browser's uploads, each
// typing its :shortcode: — which every browser in the meeting paints as the
// picture (custom-emoji.js).
let _emojiDeleteMode = false;
let _fileInput       = null;

function _ownEmojiPages() {
  const keys = [
    {l:'＋',k:'EmojiUpload',title:'Upload an image as an emoji (or drop one on the keyboard)'},
    {l:'🗑',k:'EmojiDelete',title:'Delete mode: the next emoji you press is removed',on:_emojiDeleteMode},
    ...listOwnEmoji().map(e => ({
      l: e.name, k: shortcode(e.name), img: emojiUrl(e), emojiName: e.name,
      title: _emojiDeleteMode ? `Delete ${shortcode(e.name)}` : shortcode(e.name),
    })),
  ];
  const perPage = PER_ROW * 4;
  const pages = [];
  for (let i = 0; i < keys.length; i += perPage) {
    const slice = keys.slice(i, i + perPage);
    const rows = [];
    for (let j = 0; j < slice.length; j += PER_ROW) rows.push(slice.slice(j, j + PER_ROW));
    if (keys.length <= 2) {
      rows[0].push({ spacer: true, w: PER_ROW - 2, text: 'Drop an image here, or press ＋, to make your own emoji' });
    }
    pages.push({ id: `mine-${pages.length + 1}`, label: pages.length ? `Mine ${pages.length + 1}` : 'Mine', rows });
  }
  return pages;
}

function _rerenderIfEmoji() {
  if (_ipaPage || _system !== 'emoji') return;
  const panel = document.getElementById(KBD_PANEL_ID);
  if (panel) { _renderRows(panel.querySelector('.ts-kbd-body')); _renderModState(); }
}

// Upload status rides in the title bar for a few seconds.
let _titleTimer = null;
function _flashTitle(msg) {
  const title = document.querySelector(`#${KBD_PANEL_ID} .ts-kbd-title`);
  if (!title) return;
  title.textContent = msg;
  clearTimeout(_titleTimer);
  _titleTimer = setTimeout(() => { title.textContent = _panelTitle(); }, 4000);
}

async function _uploadEmoji(files) {
  const images = [...(files || [])].filter(f => /^image\//.test(f.type));
  if (!images.length) { _flashTitle('Only image files can become emoji'); return; }
  if (_system !== 'emoji') _chooseSystem('emoji');
  _sysPage = null;
  const added = [];
  for (const file of images) {
    try { added.push(shortcode(await addEmojiFromFile(file))); }
    catch (e) { _flashTitle(e.message || 'Could not add that image'); return; }
  }
  _rerenderIfEmoji();
  _flashTitle(`Added ${added.join(' ')}`);
}

// ── IPA layout ──────────────────────────────────────────────────────────────────
// The IPA key swaps the key rows for one page of the chart (ipa-core.js's
// IPA_PAGES) at a time: a tab row to pick the page or return to ABC, the
// page's symbols, and the editing keys a performer still needs mid-word.
// One page at a time keeps the keys big enough to dwell on — the whole chart
// at once is ~195 keys. The last page is the chart's shaded cells, the
// articulations judged impossible; their keys are shaded the same way.
const IPA_PER_ROW = 15;

function _ipaRows(pageId) {
  const group = IPA_PAGES.find(g => g.id === pageId) || IPA_PAGES[0];
  const ws = writingSystem(_system);
  const tabs = [
    {l: ws.id === DEFAULT_SYSTEM ? 'ABC' : ws.sample, k:'ABC', w:1.5, title:`Back to the ${ws.label} keyboard`},
    ...IPA_PAGES.map(g => ({
      l: g.label, k: `IPAPage:${g.id}`, w: (IPA_PER_ROW - 1.5) / IPA_PAGES.length,
      title: `IPA: ${g.label}`, on: g.id === group.id,
    })),
  ];
  const rows = [tabs];
  const judged = group.impossible ? ' (judged impossible)' : '';
  for (let i = 0; i < group.symbols.length; i += IPA_PER_ROW) {
    const row = group.symbols.slice(i, i + IPA_PER_ROW)
      .map(({ sym, name }) => ({
        l: ipaKeyLabel(sym), k: sym, title: `${sym} — ${name}${judged}`, ipa: true, impossible: !!group.impossible,
      }));
    // Pad a short last row so its keys stay the same width as the rows above.
    if (row.length < IPA_PER_ROW) row.push({ spacer: true, w: IPA_PER_ROW - row.length });
    rows.push(row);
  }
  rows.push([
    {l:'←',k:'ArrowLeft',w:1.5},{l:'→',k:'ArrowRight',w:1.5},
    {l:'⌫',k:'Backspace',w:1.5},
    {l:'space',k:' ',w:8.5}, {l:'↵eval',k:'Eval',w:2},
  ]);
  return rows;
}

// ── State ──────────────────────────────────────────────────────────────────────
let _shift        = false;
let _caps         = false;
let _visible      = false;
// Standalone = the keyboard is held open by Landmark and Gesture Mode rather
// than by the Studio toolbar's Keys button, so it stays up on the welcome page
// and prejoin screen too and tickKbdUi() must not retract it.
let _standalone   = false;
let _collapsed    = false;
// null = the current writing system's rows; otherwise the id of the IPA page
// on show.
let _ipaPage      = null;
// The writing system (writing-systems-core.js id), its page on show (null =
// the first), and whether the 🌐 menu is open.
let _system       = _loadSystem();
let _sysPage      = null;
let _menuOpen     = false;
// Where the caret sat after the last Hangul jamo this keyboard typed — the
// next jamo only composes into that syllable if the caret has not moved.
let _composeAt    = -1;
let _composeTA    = null;
let _lastTA       = null;
let _dwellEl      = null;
let _dwellStart   = 0;
let _dwellFired   = false;
let _rafId        = null;
let _activityBound = false;

// Latch the editor the user last touched so on-screen keys and completions
// target it. Detached nodes (a peer switch rebuilds the detail panel) are
// rejected in _getTA(), so this can safely hold whatever was focused last.
document.addEventListener('focusin', (e) => {
  if (_isTypingTarget(e.target)) {
    _lastTA = e.target;
    _updatePredictions();
  }
});

// ── Helpers ────────────────────────────────────────────────────────────────────
export function _esc(s) {
  return String(s).replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}

function _getTA() {
  // A stale _lastTA is the classic autopredict failure: switching the selected
  // participant rebuilds the detail panel, so the textarea it pointed at is
  // now detached — reads see empty/old text and writes land nowhere. Drop it
  // the moment it leaves the document and fall back to the live personal
  // editor. :not(.jp-code) — the shared JPattern textarea is also a .ts-code.
  if (_lastTA && _lastTA.isConnected) return _lastTA;
  _lastTA = null;
  return document.querySelector('.ts-window[data-window="personal"] .ts-detail .ts-code:not(.jp-code)')
      || document.querySelector('.ts-window[data-window="personal"] .ts-code:not(.jp-code)')
      // The personal window only mounts after its toolbar button is clicked,
      // and the toolbar only mounts in a meeting — exactly when none of these
      // single-line fields exists, so never a Studio editor and one of these
      // at once.
      || document.getElementById(WELCOME_ROOM_ID)
      || document.getElementById(PREJOIN_NAME_ID)
      || document.getElementById(LOBBY_NAME_ID);
}

// ── Predictions ────────────────────────────────────────────────────────────────
function _updatePredictions() {
  const row = document.querySelector(`#${KBD_PANEL_ID} .ts-kbd-pred-row`);
  if (!row || !_visible) return;
  const ta = _getTA();
  // Autopredict is Strudel-keyword completion — meaningless over a plain name
  // field, so it only ever considers a real .ts-code editor. It's also a
  // head-cursor affordance: a suggestion is chosen by dwelling on its chip,
  // so the row only earns its space above the keys while the MediaPipe head
  // cursor is on.
  if (!ta || !ta.classList?.contains('ts-code') || !isHeadCursorEnabled()) {
    row.classList.remove('ts-kbd-pred-on');
    if (row.childElementCount) row.innerHTML = '';
    return;
  }
  const text  = ta.value;
  const caret = ta.selectionStart ?? text.length;
  const preds = predictCompletions(text, caret);
  // Hide the row entirely when there is nothing to suggest — an always-present
  // empty strip below the title bar is the "rectangle that does nothing".
  if (!preds.length) {
    row.classList.remove('ts-kbd-pred-on');
    if (row.childElementCount) row.innerHTML = '';
    return;
  }
  row.innerHTML = preds.map(p =>
    `<button class="ts-kbd-pred-btn" data-completion="${_esc(p)}">${_esc(p)}</button>`
  ).join('');
  row.querySelectorAll('.ts-kbd-pred-btn').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => _insertCompletion(btn.dataset.completion));
  });
  row.classList.add('ts-kbd-pred-on');
}

function _insertCompletion(word) {
  const ta = _getTA();
  if (!ta) return;
  const pos    = ta.selectionStart ?? ta.value.length;
  const prefix = wordPrefixAt(ta.value, pos);
  const start  = pos - prefix.length;
  _setNativeValue(ta, ta.value.slice(0, start) + word + ta.value.slice(pos));
  ta.setSelectionRange(start + word.length, start + word.length);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  _updatePredictions();
}

// Refresh predictions on ordinary typing too — physically at the keyboard, an
// arrow key moving the caret, or a click repositioning it. Without this the
// row only ever updated when a key was pressed ON the on-screen keyboard,
// which read as "autopredict isn't happening" for anyone typing normally.
function _bindEditorActivity() {
  if (_activityBound) return;
  _activityBound = true;
  const refresh = (e) => {
    if (!_visible) return;
    const t = e.target;
    if (_isTypingTarget(t)) { _lastTA = t; _updatePredictions(); }
  };
  document.addEventListener('input', refresh, true);
  document.addEventListener('keyup', refresh, true);
  document.addEventListener('selectionchange', () => {
    if (!_visible) return;
    const a = document.activeElement;
    if (_isTypingTarget(a)) { _lastTA = a; _updatePredictions(); }
  });
}

// ── Modifier display ────────────────────────────────────────────────────────────
function _renderModState() {
  const panel = document.getElementById(KBD_PANEL_ID);
  if (!panel) return;
  const upper = _shift || _caps;
  panel.querySelectorAll('.ts-kbd-key[data-lower]').forEach(el => {
    el.querySelector('.ts-kbd-label').textContent =
      upper ? el.dataset.shiftedLabel : el.dataset.lower;
  });
  panel.querySelectorAll('.ts-kbd-key[data-k="ShiftLeft"],.ts-kbd-key[data-k="ShiftRight"]').forEach(el => {
    el.classList.toggle('ts-kbd-mod-on', _shift);
  });
  panel.querySelectorAll('.ts-kbd-key[data-k="CapsLock"]').forEach(el => {
    el.classList.toggle('ts-kbd-mod-on', _caps);
  });
}

// ── Typing ─────────────────────────────────────────────────────────────────────
function _activateKeyDef(kd) {
  if (kd.emojiName && _emojiDeleteMode) {
    removeEmoji(kd.emojiName)
      .then(() => { _flashTitle(`Deleted ${shortcode(kd.emojiName)}`); _rerenderIfEmoji(); })
      .catch(e => _flashTitle(e.message || 'Could not delete that emoji'));
    return;
  }
  const upper = _shift || _caps;
  _typeKey((upper && kd.s) ? kd.s : kd.k);
}

function _currentRows() {
  if (_ipaPage) return _ipaRows(_ipaPage);
  return _system === DEFAULT_SYSTEM ? ROWS : _scriptRows();
}

// ── Writing systems ─────────────────────────────────────────────────────────────
function _loadSystem() {
  try {
    const id = localStorage.getItem(SYSTEM_STORAGE_KEY);
    if (id && WRITING_SYSTEMS.some(ws => ws.id === id)) return id;
  } catch { /* storage blocked — Latin it is */ }
  return DEFAULT_SYSTEM;
}

function _panelTitle() {
  if (_ipaPage) return 'IPA keyboard';
  return _system === DEFAULT_SYSTEM ? 'keyboard' : `keyboard · ${writingSystem(_system).label}`;
}

function _setMenuOpen(on) {
  _menuOpen = on;
  const panel = document.getElementById(KBD_PANEL_ID);
  if (!panel) return;
  panel.querySelector('.ts-kbd-menu')?.classList.toggle('ts-kbd-menu-on', on);
  panel.querySelectorAll('.ts-kbd-key[data-k="Globe"]').forEach(el => el.classList.toggle('ts-kbd-mod-on', on));
}

// Switch the keyboard to writing system `id` (null just closes the menu).
function _chooseSystem(id) {
  if (id && WRITING_SYSTEMS.some(ws => ws.id === id)) {
    _system  = id;
    _sysPage = null;
    _shift   = false;
    _composeAt = -1;
    try { localStorage.setItem(SYSTEM_STORAGE_KEY, id); } catch { /* per-session only */ }
    _setIpaPage(null);
    const panel = document.getElementById(KBD_PANEL_ID);
    panel?.querySelectorAll('.ts-kbd-menu-opt').forEach(el =>
      el.classList.toggle('ts-kbd-mod-on', el.dataset.system === id));
  }
  _setMenuOpen(false);
}

function _setSysPage(id) {
  _sysPage = id;
  _shift   = false;
  const panel = document.getElementById(KBD_PANEL_ID);
  if (!panel) return;
  _renderRows(panel.querySelector('.ts-kbd-body'));
  _renderModState();
}

// Caret stops. Arrows move by user-perceived character (a conjunct, a flag,
// a family emoji); Backspace removes one code point — undoing the last vowel
// sign of a conjunct, as every Indic keyboard does — except across an emoji,
// which goes whole rather than leaving a stray joiner or half a flag.
const _segmenter = (typeof Intl !== 'undefined' && Intl.Segmenter)
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

function _cluster(val, i) {
  return _segmenter ? _segmenter.segment(val).containing(i) : null;
}

function _codePointBefore(val, pos) {
  const c = val.charCodeAt(pos - 1);
  return (c >= 0xDC00 && c <= 0xDFFF && pos >= 2) ? pos - 2 : pos - 1;
}

function _backspaceStop(val, pos) {
  if (pos <= 0) return 0;
  const seg = _cluster(val, pos - 1);
  if (seg && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(seg.segment)) return seg.index;
  return _codePointBefore(val, pos);
}

function _leftStop(val, pos) {
  if (pos <= 0) return 0;
  const seg = _cluster(val, pos - 1);
  return seg ? seg.index : _codePointBefore(val, pos);
}

function _rightStop(val, pos) {
  if (pos >= val.length) return val.length;
  const seg = _cluster(val, pos);
  if (seg) return seg.index + seg.segment.length;
  const c = val.charCodeAt(pos);
  return (c >= 0xD800 && c <= 0xDBFF) ? pos + 2 : pos + 1;
}

function _setIpaPage(page) {
  _ipaPage = page;
  const panel = document.getElementById(KBD_PANEL_ID);
  if (!panel) return;
  panel.classList.toggle('ts-kbd-ipa', !!page);
  panel.dataset.system = page ? 'ipa' : _system;
  const title = panel.querySelector('.ts-kbd-title');
  if (title) title.textContent = _panelTitle();
  _renderRows(panel.querySelector('.ts-kbd-body'));
  _renderModState();
}

function _typeKey(key) {
  if (key === 'IPA') { _setMenuOpen(false); _setIpaPage(IPA_PAGES[0].id); return; }
  if (key === 'ABC') { _setIpaPage(null); return; }
  if (key.startsWith('IPAPage:')) { _setIpaPage(key.slice('IPAPage:'.length)); return; }
  if (key === 'Globe') { _setMenuOpen(!_menuOpen); return; }
  if (key === 'EmojiUpload') { _fileInput?.click(); return; }
  if (key === 'EmojiDelete') { _emojiDeleteMode = !_emojiDeleteMode; _rerenderIfEmoji(); return; }
  if (key.startsWith('SysPage:')) { _setSysPage(key.slice('SysPage:'.length)); return; }
  if (key === 'CapsLock') { _caps = !_caps; _renderModState(); return; }
  if (key === 'ShiftLeft' || key === 'ShiftRight') { _shift = !_shift; _renderModState(); return; }

  if (key === 'Eval') {
    const ta = _getTA();
    // Eval routes by editor: the shared JPattern textarea (.jp-code — it also
    // carries .ts-code) applies the metaprogram; the personal editor evals
    // Strudel. studio.js handles the dispatch either way, keyed on the
    // 'jpattern' kind — the same name classifyEditor() uses, so every input
    // modality agrees on one vocabulary. Not a real editor (e.g. the
    // prejoin/lobby name field) → nothing to run; studio.js's listener would
    // otherwise try to eval whatever name the performer just typed as a
    // Strudel pattern.
    if (!ta || !ta.classList?.contains('ts-code')) return;
    document.dispatchEvent(new CustomEvent('trussal-kbd-eval', {
      detail: {
        code: ta.value,
        editor: ta.classList.contains('jp-code') ? 'jpattern' : 'strudel'
      }
    }));
    return;
  }

  const ta = _getTA();
  if (!ta) return;

  const s   = ta.selectionStart ?? ta.value.length;
  const e   = ta.selectionEnd   ?? ta.value.length;
  const val = ta.value;

  const isTextarea = ta.tagName === 'TEXTAREA';
  // Any key but another jamo ends a Hangul syllable in progress.
  const composeFrom = (_composeTA === ta && s === e) ? _composeAt : -1;
  _composeAt = -1;

  if (key === 'Backspace') {
    if (s !== e) {
      _setNativeValue(ta, val.slice(0, s) + val.slice(e));
      ta.setSelectionRange(s, s);
    } else if (s > 0) {
      const from = _backspaceStop(val, s);
      _setNativeValue(ta, val.slice(0, from) + val.slice(s));
      ta.setSelectionRange(from, from);
    }
  } else if (key === 'Enter') {
    if (isTextarea) {
      _setNativeValue(ta, val.slice(0, s) + '\n' + val.slice(e));
      ta.setSelectionRange(s + 1, s + 1);
    } else {
      // A single-line field (welcome room name, prejoin / lobby name) takes
      // no newline. Mimic a physical Enter so the screen's own submit-on-Enter
      // handler runs — that's the hands-free performer's way off this screen.
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      ta.dispatchEvent(new Event('change', { bubbles: true }));
      for (const type of ['keydown', 'keypress', 'keyup']) {
        ta.dispatchEvent(new KeyboardEvent(type, {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
        }));
      }
      if (ta.form && typeof ta.form.requestSubmit === 'function') {
        try { ta.form.requestSubmit(); } catch { ta.form.submit(); }
      }
      _updatePredictions();
      return;
    }
  } else if (key === 'Tab') {
    if (isTextarea) {
      _setNativeValue(ta, val.slice(0, s) + '  ' + val.slice(e));
      ta.setSelectionRange(s + 2, s + 2);
    }
  } else if (key === 'ArrowLeft') {
    const p = _leftStop(val, s); ta.setSelectionRange(p, p);
  } else if (key === 'ArrowRight') {
    const p = _rightStop(val, e); ta.setSelectionRange(p, p);
  } else if (key === 'ArrowUp' || key === 'ArrowDown') {
    if (isTextarea) _moveLine(ta, key === 'ArrowUp' ? -1 : 1);
  } else if (key) {
    // A key types its whole string: one letter, a conjunct, an astral-plane
    // letter (Osage), or an emoji sequence.
    let start = s;
    let text  = key;
    const hangul = !_ipaPage && writingSystem(_system).compose === 'hangul';
    if (hangul && composeFrom === s && s > 0) {
      const joined = composeHangul(val[s - 1], key);
      if (joined != null) { start = s - 1; text = joined; }
    }
    _setNativeValue(ta, val.slice(0, start) + text + val.slice(e));
    const p = start + text.length;
    ta.setSelectionRange(p, p);
    if (hangul) { _composeAt = p; _composeTA = ta; }
    if (_shift) { _shift = false; _renderModState(); }
  }

  ta.dispatchEvent(new Event('input', { bubbles: true }));
  _updatePredictions();
}

function _moveLine(ta, dir) {
  const val       = ta.value;
  const pos       = ta.selectionStart ?? val.length;
  const lineStart = val.lastIndexOf('\n', pos - 1) + 1;
  const col       = pos - lineStart;
  if (dir === -1) {
    if (lineStart === 0) return;
    const prevEnd   = lineStart - 1;
    const prevStart = val.lastIndexOf('\n', prevEnd - 1) + 1;
    ta.setSelectionRange(prevStart + Math.min(col, prevEnd - prevStart),
                         prevStart + Math.min(col, prevEnd - prevStart));
  } else {
    const lineEnd = val.indexOf('\n', pos);
    if (lineEnd === -1) return;
    const nextStart = lineEnd + 1;
    const nextEnd   = val.indexOf('\n', nextStart);
    const nextLen   = (nextEnd === -1 ? val.length : nextEnd) - nextStart;
    ta.setSelectionRange(nextStart + Math.min(col, nextLen),
                         nextStart + Math.min(col, nextLen));
  }
}

// ── Close (✕) ────────────────────────────────────────────────────────────────
// Closing the keyboard with the ✕ — never by collapsing it — takes the rest of
// Landmark and Gesture Mode with it: the MediaPipe head cursor, gesture actions
// and the mode flag itself, so no cursor is left drifting after the window
// closes. Hiding stops this panel's own dwell loop via _showPanel; dropping the
// standalone hold keeps Landmark and Gesture Mode from re-raising the panel
// under it (tickKbdUi). Everything stays down until the performer retriggers the
// mode — hold one eye shut for 2s (the camera keeps running watch-only), press
// →, click the Face button, or call gestureAndLandmarkConfig.
function _closeKeyboard() {
  _standalone = false;
  _showPanel(false);
  // The event flips the mode off through landmark-gesture-mode's shared handler
  // so its bookkeeping stays in step; the direct calls guarantee the cursor and
  // gesture actions are gone even if that flag had drifted out of sync.
  setHeadCursorEnabled(false);
  setGestureDetectionEnabled(false);
  try {
    document.dispatchEvent(new CustomEvent('trussal-landmark-gesture-mode', {
      detail: { on: false, source: 'keyboard-close' },
    }));
  } catch (e) { /* document not ready — cursor and gestures are already off */ }
}

// ── Collapse ───────────────────────────────────────────────────────────────────
function _setCollapsed(val) {
  _collapsed = val;
  const panel = document.getElementById(KBD_PANEL_ID);
  if (!panel) return;
  const btn  = panel.querySelector('.ts-kbd-collapse-btn');
  // The collapsed look is entirely CSS (.ts-kbd-collapsed hides the body and
  // drops the height back to auto, which also takes a resized window's
  // --tdr-h out of the picture; the property survives for the expand back).
  panel.classList.toggle('ts-kbd-collapsed', val);
  if (btn) btn.textContent = val ? '▲' : '▼';
}

const MIN_W = 320;
const MIN_H = 170;

// ── Drag ───────────────────────────────────────────────────────────────────────
// Pin the panel to a top/left box. _pinTopLeft clears the CSS bottom/right
// anchors (--tdr-bottom/--tdr-right: auto) so a moved top/left is the ONLY
// constraint — a fixed element that honours both top and bottom stretches
// vertically, the "dead space grows as you drag it up" bug (see
// panel-drag-resize.js).
function _makeDraggable(panel, handle) {
  handle.classList.add('tdr-draggable');
  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('button, .ts-kbd-resize')) return;
    e.preventDefault();
    handle.classList.add('tdr-dragging');
    const rect   = panel.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    _pinTopLeft(panel, rect);
    const origL = rect.left;
    const origT = rect.top;
    function onMove(ev) {
      setPanelBox(panel, { left: origL + ev.clientX - startX, top: origT + ev.clientY - startY });
    }
    function onUp() {
      handle.classList.remove('tdr-dragging');
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

// ── Resize (four corner handles) ───────────────────────────────────────────────
// Each corner moves its own two edges and leaves the opposite corner fixed.
// The body/rows are flex:1, so a taller panel means taller keys, not padding.
function _makeResizable(panel) {
  panel.querySelectorAll('.ts-kbd-resize').forEach((h) => {
    const west  = h.classList.contains('ts-kbd-resize-nw') || h.classList.contains('ts-kbd-resize-sw');
    const north = h.classList.contains('ts-kbd-resize-nw') || h.classList.contains('ts-kbd-resize-ne');
    h.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const r  = panel.getBoundingClientRect();
      const sx = e.clientX, sy = e.clientY;
      _pinTopLeft(panel, r);
      setPanelBox(panel, { width: r.width, height: r.height });
      const maxW = window.innerWidth  - 20;
      const maxH = window.innerHeight - 20;
      function onMove(ev) {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (west) {
          const w = Math.min(maxW, Math.max(MIN_W, r.width - dx));
          setPanelBox(panel, { width: w, left: r.left + (r.width - w) });
        } else {
          setPanelBox(panel, { width: Math.min(maxW, Math.max(MIN_W, r.width + dx)) });
        }
        if (north) {
          const ht = Math.min(maxH, Math.max(MIN_H, r.height - dy));
          setPanelBox(panel, { height: ht, top: r.top + (r.height - ht) });
        } else {
          setPanelBox(panel, { height: Math.min(maxH, Math.max(MIN_H, r.height + dy)) });
        }
      }
      function onUp() {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      }
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    });
  });
}

// ── DOM construction ───────────────────────────────────────────────────────────

function _buildPanel() {
  const panel = document.createElement('div');
  panel.id = KBD_PANEL_ID;

  // ── Header (drag handle + collapse button) ──
  const header = document.createElement('div');
  header.className = 'ts-kbd-header';

  const title = document.createElement('span');
  title.className = 'ts-kbd-title';
  title.textContent = _panelTitle();
  panel.dataset.system = _system;

  const collapseBtn = document.createElement('button');
  collapseBtn.className = 'ts-kbd-collapse-btn';
  collapseBtn.type      = 'button';
  collapseBtn.title     = 'Collapse / expand keyboard';
  collapseBtn.textContent = '▼';
  collapseBtn.addEventListener('mousedown', e => e.preventDefault());
  collapseBtn.addEventListener('click', () => _setCollapsed(!_collapsed));

  header.appendChild(title);
  header.appendChild(collapseBtn);

  const closeBtn = document.createElement('button');
  closeBtn.className = 'ts-kbd-close-btn';
  closeBtn.type      = 'button';
  closeBtn.title     = 'Close keyboard';
  closeBtn.textContent = '✕';
  closeBtn.addEventListener('mousedown', e => e.preventDefault());
  closeBtn.addEventListener('click', _closeKeyboard);
  header.appendChild(closeBtn);

  panel.appendChild(header);

  // ── Body (predictions + key rows) ──
  const body = document.createElement('div');
  body.className = 'ts-kbd-body';

  const predRow = document.createElement('div');
  predRow.className = 'ts-kbd-pred-row';
  body.appendChild(predRow);

  _renderRows(body);
  body.appendChild(_buildMenu());

  // Emoji upload: a hidden picker for the ＋ key, and image files dropped
  // anywhere on the keyboard.
  _fileInput = document.createElement('input');
  _fileInput.type = 'file';
  _fileInput.accept = EMOJI_MIMES.join(',');
  _fileInput.multiple = true;
  _fileInput.hidden = true;
  _fileInput.addEventListener('change', () => { _uploadEmoji(_fileInput.files); _fileInput.value = ''; });
  panel.appendChild(_fileInput);
  panel.addEventListener('dragover', (e) => {
    if ([...(e.dataTransfer?.items || [])].some(it => it.kind === 'file')) {
      e.preventDefault();
      panel.classList.add('ts-kbd-dropping');
    }
  });
  panel.addEventListener('dragleave', (e) => {
    if (!panel.contains(e.relatedTarget)) panel.classList.remove('ts-kbd-dropping');
  });
  panel.addEventListener('drop', (e) => {
    panel.classList.remove('ts-kbd-dropping');
    if (!e.dataTransfer?.files?.length) return;
    e.preventDefault();
    _uploadEmoji(e.dataTransfer.files);
  });
  initCustomEmoji().then(_rerenderIfEmoji);
  subscribeCustomEmoji(_rerenderIfEmoji);

  panel.appendChild(body);

  // ── Corner resize handles ──
  for (const corner of ['nw', 'ne', 'sw', 'se']) {
    const grip = document.createElement('div');
    grip.className = `ts-kbd-resize ts-kbd-resize-${corner}`;
    panel.appendChild(grip);
  }

  document.body.appendChild(panel);
  _makeDraggable(panel, header);
  _makeResizable(panel);
  // Head-cursor move/resize: ✥ / ⇲ buttons in the header, same as Studio and
  // the facial-control panel. Mouse drag/resize above stays as it was.
  attachHeadDragResize(panel, { handle: header, minW: MIN_W, minH: MIN_H });
}

// The 🌐 menu: one entry per writing system, laid over the keys. Entries are
// dwell targets like keys (see _dwellTick), and the first one closes it.
function _buildMenu() {
  const menu = document.createElement('div');
  menu.className = 'ts-kbd-menu';
  const entries = [{ id: '', label: 'Close', sample: '✕' }, ...WRITING_SYSTEMS];
  for (const ws of entries) {
    const opt = document.createElement('button');
    opt.type = 'button';
    opt.className = 'ts-kbd-menu-opt';
    opt.dataset.system = ws.id;
    opt.title = ws.id ? `Type in ${ws.label}` : 'Close this menu';
    if (ws.id === _system) opt.classList.add('ts-kbd-mod-on');
    const sample = document.createElement('span');
    sample.className = 'ts-kbd-menu-sample';
    sample.textContent = ws.sample;
    const label = document.createElement('span');
    label.className = 'ts-kbd-menu-label';
    label.textContent = ws.label;
    opt.append(sample, label);
    opt.addEventListener('mousedown', e => e.preventDefault());
    opt.addEventListener('click', () => _chooseSystem(opt.dataset.system || null));
    menu.appendChild(opt);
  }
  return menu;
}

// (Re)build the key rows for the current layout. The prediction row above
// them and the 🌐 menu are left alone, so switching layouts keeps their place.
function _renderRows(body) {
  if (!body) return;
  body.querySelectorAll('.ts-kbd-row').forEach(el => el.remove());
  const menu = body.querySelector('.ts-kbd-menu');
  _currentRows().forEach((row, ri) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'ts-kbd-row';
    row.forEach((kd, ki) => {
      if (kd.spacer) {
        const gap = document.createElement('div');
        gap.className = 'ts-kbd-spacer';
        if (kd.text) { gap.classList.add('ts-kbd-hint'); gap.textContent = kd.text; }
        gap.style.setProperty('--tsk-flex', String(kd.w));
        rowEl.appendChild(gap);
        return;
      }
      const btn = document.createElement('button');
      btn.className    = 'ts-kbd-key';
      btn.type         = 'button';
      btn.dataset.k    = kd.k;
      btn.dataset.row  = ri;
      btn.dataset.key  = ki;
      if (kd.title) btn.title = kd.title;
      if (kd.ipa) btn.classList.add('ts-kbd-ipa-key');
      if (kd.impossible) btn.classList.add('ts-kbd-impossible-key');
      if (kd.script) btn.classList.add('ts-kbd-script-key');
      if (kd.on || (kd.k === 'Globe' && _menuOpen)) btn.classList.add('ts-kbd-mod-on');
      // Width in flex units; the stylesheet reads --tsk-flex (see the .ts-kbd-key
      // rule) so no element styles are written here.
      if (kd.w) btn.style.setProperty('--tsk-flex', String(kd.w));
      if (kd.s) {
        btn.dataset.lower        = kd.l;
        btn.dataset.shiftedLabel = kd.s;
      }
      const label = document.createElement('span');
      label.className   = 'ts-kbd-label';
      if (kd.img) {
        const img = document.createElement('img');
        img.className = 'ts-kbd-emoji-img';
        img.src = kd.img;
        img.alt = kd.k;
        label.appendChild(img);
        btn.classList.add('ts-kbd-own-emoji');
        if (_emojiDeleteMode) btn.classList.add('ts-kbd-deleting');
      } else {
        label.textContent = kd.l;
      }
      btn.appendChild(label);
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', () => { _activateKeyDef(kd); _flash(btn); });
      rowEl.appendChild(btn);
    });
    body.insertBefore(rowEl, menu);
  });
}

function _flash(el) {
  el.classList.add('ts-kbd-flash');
  setTimeout(() => el.classList.remove('ts-kbd-flash'), 150);
}

function _ensureDOM() {
  if (document.getElementById(KBD_PANEL_ID)) return;
  _buildPanel();
  _bindEditorActivity();
}

// ── Dwell loop (head-cursor) ────────────────────────────────────────────────────
function _startDwellLoop() {
  if (_rafId) return;
  _rafId = requestAnimationFrame(_dwellTick);
}

function _stopDwellLoop() {
  if (_rafId) { cancelAnimationFrame(_rafId); _rafId = null; }
  if (_dwellEl) {
    _dwellEl.style.setProperty('--dwell', '0');
    _dwellEl.classList.remove('ts-kbd-dwelling');
    _dwellEl = null;
  }
}

function _dwellTick() {
  if (!_visible) { _rafId = null; return; }
  _rafId = requestAnimationFrame(_dwellTick);

  // While the head cursor is dragging/resizing a panel (this one included),
  // don't also let a dwell land on a key under it. Drop any partial dwell so
  // it can't fire the instant the panel is released.
  if (isHeadDragActive()) {
    if (_dwellEl) {
      _dwellEl.style.setProperty('--dwell', '0');
      _dwellEl.classList.remove('ts-kbd-dwelling');
      _dwellEl = null;
    }
    return;
  }

  // Only the visible head cursor dwells. In MediaPipe's watch-only state (the
  // camera up just to catch the enable gesture) faceCtx still follows the
  // face, and without this an invisible point drifting over the keys pressed
  // them.
  const ctx = window.faceCtx;
  if (!isHeadCursorEnabled()) {
    if (_dwellEl) {
      _dwellEl.style.setProperty('--dwell', '0');
      _dwellEl.classList.remove('ts-kbd-dwelling');
      _dwellEl = null;
    }
    return;
  }
  if (!ctx || (ctx.cursorX === window.innerWidth / 2 && ctx.cursorY === window.innerHeight / 2)) return;

  const panel = document.getElementById(KBD_PANEL_ID);
  if (!panel || !panel.classList.contains('ts-kbd-on')) return;

  const cx = ctx.cursorX;
  const cy = ctx.cursorY;
  let hoveredEl = null;

  // Detect over keys, predictions, and the collapse button — or, while the 🌐
  // menu covers the keys, over its entries instead.
  const targets = _menuOpen
    ? '.ts-kbd-menu-opt, .ts-kbd-collapse-btn, .ts-kbd-close-btn'
    : '.ts-kbd-key, .ts-kbd-pred-btn, .ts-kbd-collapse-btn, .ts-kbd-close-btn';
  for (const el of panel.querySelectorAll(targets)) {
    const r = el.getBoundingClientRect();
    if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) {
      hoveredEl = el; break;
    }
  }

  const now = performance.now();
  if (hoveredEl !== _dwellEl) {
    if (_dwellEl) {
      _dwellEl.style.setProperty('--dwell', '0');
      _dwellEl.classList.remove('ts-kbd-dwelling');
    }
    _dwellEl    = hoveredEl;
    _dwellStart = hoveredEl ? now : 0;
    _dwellFired = false;
  }

  if (hoveredEl && !_dwellFired) {
    const p = Math.min((now - _dwellStart) / DWELL_MS, 1);
    hoveredEl.style.setProperty('--dwell', p.toFixed(3));
    hoveredEl.classList.toggle('ts-kbd-dwelling', p > 0.05);
    if (p >= 1) {
      _dwellFired = true;
      hoveredEl.style.setProperty('--dwell', '0');
      hoveredEl.classList.remove('ts-kbd-dwelling');
      _activateDwelled(hoveredEl);
    }
  }
}

function _activateDwelled(el) {
  _flash(el);
  if (el.classList.contains('ts-kbd-collapse-btn')) {
    _setCollapsed(!_collapsed);
    return;
  }
  if (el.classList.contains('ts-kbd-close-btn')) {
    _closeKeyboard();
    return;
  }
  if (el.classList.contains('ts-kbd-pred-btn')) {
    _insertCompletion(el.dataset.completion);
    return;
  }
  if (el.classList.contains('ts-kbd-menu-opt')) {
    _chooseSystem(el.dataset.system || null);
    return;
  }
  const ri = parseInt(el.dataset.row);
  const ki = parseInt(el.dataset.key);
  const kd = _currentRows()[ri]?.[ki];
  if (kd && !kd.spacer) _activateKeyDef(kd);
}

// ── Meeting visibility ──────────────────────────────────────────────────────────
function _inMeeting() {
  if (document.getElementById('trussal-welcome-overlay')) return false;
  if (document.querySelector('.prejoin-screen,.premeeting-screen,[class*="premeeting"],[class*="prejoin"]')) return false;
  const lv = document.getElementById('largeVideoContainer');
  if (!lv) return false;
  const r = lv.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

function _showPanel(on) {
  _visible = on;
  const panel = document.getElementById(KBD_PANEL_ID);
  if (panel) panel.classList.toggle('ts-kbd-on', on);
  const toggle = document.getElementById(KBD_TOGGLE_ID);
  if (toggle) toggle.classList.toggle('on', on);
  if (on) { _startDwellLoop(); _updatePredictions(); }
  else    { _stopDwellLoop(); }
}

/**
 * Inject the Keys toggle into the Trussal Studio toolbar group. Called from
 * studio.js ensureToolbar(), which passes the #trussal-studio-inputs host
 * beside the window buttons. The button carries .ts-dwell-btn so
 * facial-gesture.js's head-cursor dwell loop clicks it for free, exactly like
 * the Face and collapse buttons beside it.
 */
export function injectKeyboardToggle(headerEl) {
  if (!headerEl || document.getElementById(KBD_TOGGLE_ID)) return;
  const btn = document.createElement('button');
  btn.id    = KBD_TOGGLE_ID;
  btn.type  = 'button';
  btn.className = 'ts-dwell-btn';
  btn.title = 'Toggle the on-screen keyboard';
  btn.textContent = 'Keys';
  btn.addEventListener('mousedown', e => e.preventDefault());
  btn.addEventListener('click', () => {
    try { _ensureDOM(); } catch (e) { console.error('[on-screen-keyboard] panel init failed', e); return; }
    _showPanel(!_visible);
  });
  const closeBtn = headerEl.querySelector('.ts-close');
  if (closeBtn) headerEl.insertBefore(btn, closeBtn);
  else headerEl.appendChild(btn);
}

/**
 * Whether the keyboard is currently held open by Landmark and Gesture Mode
 * (as opposed to the toolbar's Keys button). gestureAndLandmarkConfig reports
 * this back as `virtualKeyboardEnabled`.
 */
export function isKeyboardStandalone() { return _standalone; }

/**
 * Landmark and Gesture Mode calls this to show/hide the keyboard independently
 * of any Studio window — so it is available on the welcome page and prejoin
 * screen, not just in a meeting with a Studio window open.
 */
export function setKeyboardStandalone(on) {
  _standalone = !!on;
  if (_standalone) {
    try { _ensureDOM(); } catch (e) { console.error('[on-screen-keyboard] panel init failed', e); return; }
    _showPanel(true);
  } else {
    // Let the toolbar's Keys button own visibility again; tickKbdUi() keeps
    // the panel up in a meeting but still retracts it when the room ends.
    tickKbdUi();
  }
}

/**
 * Housekeeping tick from studio.js's tickUi(). The toggle lives in the Studio
 * toolbar and comes and goes with it; this only has to retract the body-level
 * panel when the meeting ends — unless Landmark and Gesture Mode is holding it
 * open (standalone).
 */
export function tickKbdUi() {
  if (_standalone) {
    if (!_visible) {
      try { _ensureDOM(); } catch (e) { console.error('[on-screen-keyboard] panel init failed', e); return; }
      _showPanel(true);
    }
    _updatePredictions();
    return;
  }
  if (!_visible) return;
  if (!_inMeeting()) { _showPanel(false); return; }
  // Reflect a head-cursor toggle on the autopredict row without waiting for
  // the next editor keystroke to call _updatePredictions().
  _updatePredictions();
}

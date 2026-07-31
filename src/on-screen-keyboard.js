// on-screen-keyboard.js
// On-screen QWERTY keyboard with head-cursor dwell, drag, collapse, and trie autocomplete.

const KBD_STYLE_ID = 'trussal-kbd-style';
const KBD_PANEL_ID = 'trussal-kbd-panel';
const KBD_BTN_ID   = 'trussal-kbd-btn';
const DWELL_MS     = 1000;

// ── Trie ───────────────────────────────────────────────────────────────────────
class TrieNode { constructor() { this.ch = {}; this.end = false; this.w = 0; } }
class Trie {
  constructor() { this.root = new TrieNode(); }
  insert(word, weight) {
    let n = this.root;
    for (const c of word) { if (!n.ch[c]) n.ch[c] = new TrieNode(); n = n.ch[c]; }
    n.end = true; n.w = Math.max(n.w, weight || 1);
  }
  predict(prefix, limit) {
    limit = limit || 5;
    if (!prefix) return [];
    let n = this.root;
    for (const c of prefix) { if (!n.ch[c]) return []; n = n.ch[c]; }
    const out = [];
    (function dfs(node, s) {
      if (out.length >= limit * 4) return;
      if (node.end) out.push({ s, w: node.w });
      for (const c in node.ch) dfs(node.ch[c], s + c);
    })(n, prefix);
    return out.sort((a, b) => b.w - a.w).slice(0, limit).map(x => x.s);
  }
}

const TRIE = new Trie();
[
  ['note',10],['n',9],['s',10],['sound',7],['stack',9],['cat',7],['seq',6],
  ['chord',7],['scale',6],['arp',5],['gain',9],['cutoff',7],['resonance',5],
  ['pan',6],['room',6],['size',5],['delay',7],['orbit',5],['slow',8],['fast',8],
  ['rev',7],['jux',6],['add',7],['transpose',6],['speed',5],['every',8],
  ['sometimes',7],['often',6],['rarely',5],['degradeBy',5],['struct',5],
  ['euclid',6],['crush',4],['shape',5],['coarse',4],['vowel',5],['hcutoff',4],
  ['begin',5],['end',5],['loop',5],['pitch',5],['silence',5],['rest',5],['live',6],
  ['bd',8],['sd',8],['hh',9],['cp',7],['bass',7],['piano',6],['violin',5],
  ['tabla',4],['crow',4],['jazz',4],['psr',3],
  ['osc',8],['noise',7],['voronoi',6],['solid',6],['gradient',5],
  ['out',8],['color',7],['colorama',5],['rotate',6],['pixelate',5],
  ['kaleid',5],['invert',6],['contrast',5],['brightness',5],['saturate',5],
  ['hue',5],['modulate',6],['blend',6],['diff',5],['mult',5],['luma',5],
  ['thresh',4],['mask',4],['modulateScale',3],['modulateRotate',3],
].forEach(([w, wt]) => TRIE.insert(w, wt));

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
    {l:'←',k:'ArrowLeft',w:1.5},{l:'↑',k:'ArrowUp',w:1.5},{l:'↓',k:'ArrowDown',w:1.5},
    {l:'space',k:' ',w:6.5},
    {l:'→',k:'ArrowRight',w:1.5},{l:'↵eval',k:'Eval',w:2},
  ],
];

// ── State ──────────────────────────────────────────────────────────────────────
let _shift      = false;
let _caps       = false;
let _visible    = false;
let _collapsed  = false;
let _lastTA     = null;
let _dwellEl    = null;
let _dwellStart = 0;
let _dwellFired = false;
let _rafId      = null;

document.addEventListener('focusin', (e) => {
  if (e.target?.classList?.contains('ts-code')) _lastTA = e.target;
});

// ── Helpers ────────────────────────────────────────────────────────────────────
function _esc(s) {
  return String(s).replace(/[&<>"']/g,
    c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
}
function _getTA() {
  return _lastTA || document.querySelector('#trussal-studio-overlay .ts-code');
}
function _wordPrefix() {
  const ta = _getTA();
  if (!ta) return '';
  const m = ta.value.slice(0, ta.selectionStart ?? ta.value.length)
    .match(/[a-zA-Z_$][a-zA-Z0-9_$]*$/);
  return m ? m[0] : '';
}

// ── Predictions ────────────────────────────────────────────────────────────────
function _updatePredictions() {
  const row = document.querySelector(`#${KBD_PANEL_ID} .ts-kbd-pred-row`);
  if (!row) return;
  const prefix = _wordPrefix();
  const preds  = prefix.length >= 1 ? TRIE.predict(prefix) : [];
  if (!preds.length) { row.innerHTML = ''; return; }
  row.innerHTML = preds.map(p =>
    `<button class="ts-kbd-pred-btn" data-completion="${_esc(p)}">${_esc(p)}</button>`
  ).join('');
  row.querySelectorAll('.ts-kbd-pred-btn').forEach(btn => {
    btn.addEventListener('mousedown', e => e.preventDefault());
    btn.addEventListener('click', () => _insertCompletion(btn.dataset.completion));
  });
}

function _insertCompletion(word) {
  const ta = _getTA();
  if (!ta) return;
  const pos    = ta.selectionStart ?? ta.value.length;
  const before = ta.value.slice(0, pos);
  const m      = before.match(/[a-zA-Z_$][a-zA-Z0-9_$]*$/);
  const start  = pos - (m ? m[0].length : 0);
  ta.value = ta.value.slice(0, start) + word + ta.value.slice(pos);
  ta.setSelectionRange(start + word.length, start + word.length);
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  _updatePredictions();
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
  const upper = _shift || _caps;
  _typeKey((upper && kd.s) ? kd.s : kd.k);
}

function _typeKey(key) {
  if (key === 'CapsLock') { _caps = !_caps; _renderModState(); return; }
  if (key === 'ShiftLeft' || key === 'ShiftRight') { _shift = !_shift; _renderModState(); return; }

  if (key === 'Eval') {
    const ta = _getTA();
    // Eval routes by editor: the shared Net Cycles editor (.nc-code) applies
    // the metaprogram; the personal editor evals Strudel. studio.js handles
    // the dispatch either way.
    document.dispatchEvent(new CustomEvent('trussal-kbd-eval', {
      detail: {
        code: ta ? ta.value : '',
        editor: ta && ta.classList.contains('nc-code') ? 'netcycles' : 'strudel'
      }
    }));
    return;
  }

  const ta = _getTA();
  if (!ta) return;

  const s   = ta.selectionStart ?? ta.value.length;
  const e   = ta.selectionEnd   ?? ta.value.length;
  const val = ta.value;

  if (key === 'Backspace') {
    if (s !== e) {
      ta.value = val.slice(0, s) + val.slice(e);
      ta.setSelectionRange(s, s);
    } else if (s > 0) {
      ta.value = val.slice(0, s - 1) + val.slice(s);
      ta.setSelectionRange(s - 1, s - 1);
    }
  } else if (key === 'Enter') {
    ta.value = val.slice(0, s) + '\n' + val.slice(e);
    ta.setSelectionRange(s + 1, s + 1);
  } else if (key === 'Tab') {
    ta.value = val.slice(0, s) + '  ' + val.slice(e);
    ta.setSelectionRange(s + 2, s + 2);
  } else if (key === 'ArrowLeft') {
    const p = Math.max(0, s - 1); ta.setSelectionRange(p, p);
  } else if (key === 'ArrowRight') {
    const p = Math.min(val.length, e + 1); ta.setSelectionRange(p, p);
  } else if (key === 'ArrowUp' || key === 'ArrowDown') {
    _moveLine(ta, key === 'ArrowUp' ? -1 : 1);
  } else if (key.length === 1) {
    ta.value = val.slice(0, s) + key + val.slice(e);
    ta.setSelectionRange(s + 1, s + 1);
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

// ── Collapse ───────────────────────────────────────────────────────────────────
function _setCollapsed(val) {
  _collapsed = val;
  const panel = document.getElementById(KBD_PANEL_ID);
  if (!panel) return;
  const body = panel.querySelector('.ts-kbd-body');
  const btn  = panel.querySelector('.ts-kbd-collapse-btn');
  if (body) body.style.display = _collapsed ? 'none' : 'flex';
  if (btn)  btn.textContent    = _collapsed ? '▲' : '▼';
}

// ── Drag ───────────────────────────────────────────────────────────────────────
function _makeDraggable(panel, handle) {
  handle.style.cursor = 'grab';
  handle.addEventListener('mousedown', (e) => {
    if (e.target.closest('button')) return;
    e.preventDefault();
    handle.style.cursor = 'grabbing';
    const rect   = panel.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    // Switch from bottom/left anchor to top/left so drag works in all positions.
    panel.style.bottom = '';
    panel.style.left   = `${rect.left}px`;
    panel.style.top    = `${rect.top}px`;
    const origL = rect.left;
    const origT = rect.top;
    function onMove(ev) {
      panel.style.left = `${origL + ev.clientX - startX}px`;
      panel.style.top  = `${origT + ev.clientY - startY}px`;
    }
    function onUp() {
      handle.style.cursor = 'grab';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    }
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  });
}

// ── DOM construction ───────────────────────────────────────────────────────────
function _injectStyles() {
  if (document.getElementById(KBD_STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = KBD_STYLE_ID;
  s.textContent = `
    #${KBD_PANEL_ID} {
      position: fixed;
      bottom: 60px; left: 10px;
      width: min(840px, calc(100vw - 20px));
      z-index: 1000001;
      background: rgba(5, 10, 8, 0.97);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 10px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.7);
      display: none;
      flex-direction: column;
      user-select: none;
      font-family: sans-serif;
      overflow: hidden;
    }
    .ts-kbd-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 6px 10px;
      border-bottom: 1px solid rgba(255,255,255,0.08);
      cursor: grab;
    }
    .ts-kbd-header:active { cursor: grabbing; }
    .ts-kbd-title {
      font-size: 11px;
      font-weight: 600;
      color: #7aa68a;
      letter-spacing: 0.5px;
      pointer-events: none;
    }
    .ts-kbd-collapse-btn {
      background: rgba(255,255,255,0.06);
      border: 1px solid rgba(255,255,255,0.15);
      color: #7aa68a;
      cursor: pointer;
      border-radius: 4px;
      padding: 1px 7px;
      font-size: 10px;
      line-height: 1.5;
      position: relative;
      overflow: hidden;
      transition: background 0.1s, color 0.1s;
    }
    .ts-kbd-collapse-btn:hover { background: rgba(255,255,255,0.12); color: #d6f5e2; }
    .ts-kbd-collapse-btn.strudel-dwell-hover { border-color: #ffcc00; color: #ffcc00; }
    .ts-kbd-collapse-btn.strudel-btn-active  { border-color: #68d391; color: #68d391; }
    .ts-kbd-collapse-btn::after {
      content: '';
      position: absolute;
      bottom: 0; left: 0;
      width: 100%;
      height: calc(var(--dwell,0) * 100%);
      background: rgba(255,204,0,0.35);
      pointer-events: none;
    }
    .ts-kbd-body {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 8px;
    }
    .ts-kbd-pred-row {
      display: flex;
      gap: 4px;
      overflow-x: auto;
      min-height: 24px;
      padding-bottom: 2px;
      scrollbar-width: none;
    }
    .ts-kbd-pred-btn {
      flex: 0 0 auto;
      padding: 1px 10px;
      border-radius: 999px;
      border: 1px solid rgba(31,244,102,0.35);
      background: rgba(31,244,102,0.08);
      color: #1ff466;
      font-family: ui-monospace, monospace;
      font-size: 11px;
      cursor: pointer;
      position: relative;
      overflow: hidden;
      transition: background 0.08s;
    }
    .ts-kbd-pred-btn:hover, .ts-kbd-pred-btn.ts-kbd-dwelling {
      background: rgba(31,244,102,0.2);
    }
    .ts-kbd-pred-btn::after {
      content: '';
      position: absolute;
      bottom: 0; left: 0;
      width: 100%;
      height: calc(var(--dwell,0) * 100%);
      background: rgba(255,204,0,0.4);
      pointer-events: none;
    }
    .ts-kbd-row {
      display: flex;
      gap: 3px;
    }
    .ts-kbd-key {
      min-height: 38px;
      padding: 0 2px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: 5px;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(255,255,255,0.06);
      color: #d6f5e2;
      font-size: 12px;
      cursor: pointer;
      position: relative;
      overflow: hidden;
      transition: background 0.05s;
    }
    .ts-kbd-key:hover {
      background: rgba(255,255,255,0.12);
      border-color: rgba(255,255,255,0.22);
    }
    .ts-kbd-key.ts-kbd-dwelling { border-color: rgba(255,204,0,0.5); }
    .ts-kbd-key.ts-kbd-mod-on {
      background: rgba(31,244,102,0.15);
      border-color: rgba(31,244,102,0.4);
      color: #1ff466;
    }
    .ts-kbd-key.ts-kbd-flash { background: rgba(31,244,102,0.3) !important; }
    .ts-kbd-key[data-k="Eval"] {
      background: rgba(31,244,102,0.1);
      border-color: rgba(31,244,102,0.35);
      color: #1ff466;
      font-size: 10px;
      font-weight: 600;
    }
    .ts-kbd-key[data-k="Eval"]:hover { background: rgba(31,244,102,0.22); }
    .ts-kbd-key::after {
      content: '';
      position: absolute;
      bottom: 0; left: 0;
      width: 100%;
      height: calc(var(--dwell,0) * 100%);
      background: rgba(255,204,0,0.3);
      pointer-events: none;
    }
    .ts-kbd-label { pointer-events: none; font-size: 11px; }
    #${KBD_BTN_ID} {
      position: fixed;
      bottom: 80px; left: 20px;
      z-index: 9999;
      padding: 0.45rem 0.85rem;
      border-radius: 999px;
      border: 1px solid rgba(31,244,102,0.4);
      background: rgba(31,244,102,0.12);
      color: #1ff466;
      font-weight: 600;
      font-size: 13px;
      cursor: pointer;
      display: none;
      font-family: sans-serif;
      transition: background 0.1s;
    }
    #${KBD_BTN_ID}:hover { background: rgba(31,244,102,0.22); }
    #${KBD_BTN_ID}.on    { background: rgba(31,244,102,0.28); }
  `;
  document.head.appendChild(s);
}

function _buildPanel() {
  const panel = document.createElement('div');
  panel.id = KBD_PANEL_ID;

  // ── Header (drag handle + collapse button) ──
  const header = document.createElement('div');
  header.className = 'ts-kbd-header';

  const title = document.createElement('span');
  title.className = 'ts-kbd-title';
  title.textContent = '⌨ keyboard';

  const collapseBtn = document.createElement('button');
  collapseBtn.className = 'ts-kbd-collapse-btn';
  collapseBtn.type      = 'button';
  collapseBtn.title     = 'Collapse / expand keyboard';
  collapseBtn.textContent = '▼';
  collapseBtn.addEventListener('mousedown', e => e.preventDefault());
  collapseBtn.addEventListener('click', () => _setCollapsed(!_collapsed));

  header.appendChild(title);
  header.appendChild(collapseBtn);
  panel.appendChild(header);

  // ── Body (predictions + key rows) ──
  const body = document.createElement('div');
  body.className = 'ts-kbd-body';

  const predRow = document.createElement('div');
  predRow.className = 'ts-kbd-pred-row';
  body.appendChild(predRow);

  ROWS.forEach((row, ri) => {
    const rowEl = document.createElement('div');
    rowEl.className = 'ts-kbd-row';
    row.forEach((kd, ki) => {
      const btn = document.createElement('button');
      btn.className    = 'ts-kbd-key';
      btn.type         = 'button';
      btn.dataset.k    = kd.k;
      btn.dataset.row  = ri;
      btn.dataset.key  = ki;
      btn.style.flex   = String(kd.w || 1);
      if (kd.s) {
        btn.dataset.lower        = kd.l;
        btn.dataset.shiftedLabel = kd.s;
      }
      const label = document.createElement('span');
      label.className   = 'ts-kbd-label';
      label.textContent = kd.l;
      btn.appendChild(label);
      btn.addEventListener('mousedown', e => e.preventDefault());
      btn.addEventListener('click', () => { _activateKeyDef(kd); _flash(btn); });
      rowEl.appendChild(btn);
    });
    body.appendChild(rowEl);
  });

  panel.appendChild(body);
  document.body.appendChild(panel);
  _makeDraggable(panel, header);
}

function _flash(el) {
  el.classList.add('ts-kbd-flash');
  setTimeout(() => el.classList.remove('ts-kbd-flash'), 150);
}

function _ensureDOM() {
  if (document.getElementById(KBD_PANEL_ID)) return;
  _injectStyles();
  _buildPanel();
}

function _ensureToggleBtn() {
  let btn = document.getElementById(KBD_BTN_ID);
  if (btn) return btn;
  if (!document.body) return null;
  _injectStyles();
  btn = document.createElement('button');
  btn.id    = KBD_BTN_ID;
  btn.type  = 'button';
  btn.title = 'Toggle on-screen keyboard';
  btn.textContent = '⌨';
  btn.addEventListener('click', () => {
    _ensureDOM();
    _visible = !_visible;
    btn.classList.toggle('on', _visible);
    const panel = document.getElementById(KBD_PANEL_ID);
    if (panel) panel.style.display = _visible ? 'flex' : 'none';
    if (_visible) _startDwellLoop();
    else          _stopDwellLoop();
  });
  document.body.appendChild(btn);
  return btn;
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

  const ctx = window.faceCtx;
  if (!ctx || (ctx.cursorX === window.innerWidth / 2 && ctx.cursorY === window.innerHeight / 2)) return;

  const panel = document.getElementById(KBD_PANEL_ID);
  if (!panel || panel.style.display === 'none') return;

  const cx = ctx.cursorX;
  const cy = ctx.cursorY;
  let hoveredEl = null;

  // Detect over keys, predictions, and the collapse button.
  for (const el of panel.querySelectorAll('.ts-kbd-key, .ts-kbd-pred-btn, .ts-kbd-collapse-btn')) {
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
  if (el.classList.contains('ts-kbd-pred-btn')) {
    _insertCompletion(el.dataset.completion);
    return;
  }
  const ri = parseInt(el.dataset.row);
  const ki = parseInt(el.dataset.key);
  if (!isNaN(ri) && !isNaN(ki)) _activateKeyDef(ROWS[ri][ki]);
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

export function tickKbdUi() {
  const inMeeting = _inMeeting();
  const btn = _ensureToggleBtn();
  if (!btn) return;
  if (!inMeeting) {
    btn.style.display = 'none';
    if (_visible) {
      _visible = false;
      btn.classList.remove('on');
      const panel = document.getElementById(KBD_PANEL_ID);
      if (panel) panel.style.display = 'none';
      _stopDwellLoop();
    }
    return;
  }
  btn.style.display = 'block';
}

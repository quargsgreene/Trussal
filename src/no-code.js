// no-code.js — the Studio's No Code window: a library of uploaded snippets on
// the left, a shared whiteboard on the right, and what happens when the board
// runs.
//
// The library format, the board's shape and every running rule live in
// no-code-core.js; this module is the glue between that and the browser.
//
// SHARED, PER MEETING. An upload is merged into the library this browser
// holds and the whole library goes to the sidecar, which keeps it (and the
// board) for the life of the room and sends both to every later joiner
// (latency-instrument/server.js 'no-code-library' / 'no-code-board'). Every
// board edit sends the whole board; whoever edited last wins.
//
// RUNNING. Run plays the board in this browser: asset packs load into this
// browser's IndexedDB, and the patterns become this performer's personal
// program, evaluated as if they had pressed Play. Room snippets (a prebake
// fragment) and metaprogram patterns are room-wide by nature, so they go to
// the room from whoever pressed Run. "Run for room" also asks every other
// human to run the same board in their own browser — their own programs,
// their own ctx.token for flows — without repeating the room-wide parts.
//
// A flow's source is JavaScript run in each browser that runs the board, on
// the same footing as the Strudel code every browser already evaluates for
// every peer. It may read live JSON through ctx.fetchJson (fetchJson below).
//
// PREPOPULATED. Every room starts with the weather examples
// (examples/no-code/weather-library.json) in its library, bundled rather than
// fetched so every browser holds the same snippets before anyone uploads. An
// upload merges into them, so they stay unless a later upload replaces one.
//
// SINGLE-SHOT ASSETS. Clicking the icon of an asset pack marked `singleShot`
// streams its one asset — audio into this performer's Strudel bus (which the
// room hears), video into their published tile, text into the meeting chat —
// as soon as it is their turn in the ring, and stops the stream when the turn
// passes.

import {
  subscribePeerState,
  getLocalPeer,
  getActiveJPatternToken,
  isPeerJPatternTurn,
  sendNoCodeLibrary,
  sendNoCodeBoard,
  sendNoCodeRun,
} from './peer-state.js';
import {
  parseLibrary,
  validateLibrary,
  mergeLibrary,
  libraryById,
  snippetId,
  singleShotAsset,
  thumbnailAudioFor,
  operandCount,
  emptyBoard,
  addLine,
  placeAt,
  removeAt,
  moveLine,
  sanitizeBoard,
  runBoard,
  NO_CODE_MAX_BYTES,
} from './no-code-core.js';
import { validatePrebake } from './meeting-prebake-core.js';
import { loadCodeAssets, sendChatMessage, sendPrebakeToRoom } from './meeting-prebake.js';
import { getStrudelAudioContext } from './latency-instrument.js';
import { setPublishedVideoSource } from './published-video.js';
import { attachPanelControls } from './panel-drag-resize.js';
import weatherLibrary from '../examples/no-code/weather-library.json';

const BUTTON_ID = 'trussal-no-code-button';
const WINDOW_ID = 'trussal-no-code-window';
const DRAG_TYPE = 'application/x-trussal-snippet';
// Longest chat line a single-shot text posts; Jitsi's own input has no hard
// cap, but a whole novel in one bubble helps nobody.
const TEXT_SHOT_MAX_CHARS = 4000;
// ctx.fetchJson: a hung API must not hang Run, and "Run for room" makes every
// browser run the board, so one answer serves this browser for a while
// rather than each run asking again.
const FETCH_TIMEOUT_MS = 10000;
const FETCH_CACHE_MS = 10 * 60 * 1000;

const IS_BOT = typeof window !== 'undefined' && !!window.__trussalIsBot;
const IS_AGGREGATOR = typeof window !== 'undefined' && !!window.__trussalIsAggregator;

function defaultLibrary() {
  const parsed = parseLibrary(JSON.stringify(weatherLibrary));
  if (!parsed.ok) console.error('[no-code] the bundled weather library is invalid', parsed.errors);
  return parsed.ok ? parsed.snippets : [];
}

let library = defaultLibrary();
let board = emptyBoard();
let lineErrors = new Map(); // line index → message, from the last run
let target = null;          // the empty slot a "+" fills, as a path, or null
let statusText = '';

let win = null;
let stackSeq = 0;

// --- Status -------------------------------------------------------------------

function status(text) {
  statusText = text;
  const el = win?.querySelector('.nc-status');
  if (el) el.textContent = text;
}

// --- Thumbnail audio ------------------------------------------------------------

const thumbAudio = new Map(); // src → HTMLAudioElement

function playThumb(snippet, event) {
  const src = thumbnailAudioFor(snippet, event);
  if (!src) return;
  let el = thumbAudio.get(src);
  if (!el) {
    el = new Audio(src);
    el.preload = 'auto';
    thumbAudio.set(src, el);
  }
  try { el.currentTime = 0; } catch (e) { /* not seekable yet */ }
  // Hover sound before any click is refused by autoplay policy; that only
  // costs the sound, so it is not worth a warning on every pass of the mouse.
  el.play().catch((e) => { if (event === 'click') console.warn('[no-code] thumbnail audio did not play', e); });
}

// --- Single-shot streaming ---------------------------------------------------------

let pendingShot = null;  // { snippet, asset } waiting for this performer's turn
let liveShot = null;     // { stop } while streaming

function myTurn() {
  const local = getLocalPeer();
  return isPeerJPatternTurn(local?.jitsiId);
}

function stopShot() {
  const shot = liveShot;
  liveShot = null;
  if (shot) {
    try { shot.stop(); } catch (e) { console.warn('[no-code] stopping a single shot failed', e); }
  }
}

async function streamAudio(asset) {
  const { audioCtx, destinationNode } = await getStrudelAudioContext();
  const res = await fetch(asset.src);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const buffer = await audioCtx.decodeAudioData(await res.arrayBuffer());
  const source = audioCtx.createBufferSource();
  source.buffer = buffer;
  source.connect(destinationNode);
  const shot = { stop: () => { try { source.stop(); } catch (e) { /* already ended */ } source.disconnect(); } };
  source.onended = () => { if (liveShot === shot) liveShot = null; source.disconnect(); };
  liveShot = shot;
  source.start();
}

async function streamVideo(asset) {
  const { audioCtx, destinationNode } = await getStrudelAudioContext();
  const video = document.createElement('video');
  video.crossOrigin = 'anonymous';
  video.playsInline = true;
  video.src = asset.src;
  // The soundtrack goes where the performer's audio goes, not out of the
  // element directly.
  const sound = audioCtx.createMediaElementSource(video);
  sound.connect(destinationNode);
  const shot = {
    stop: () => {
      video.pause();
      setPublishedVideoSource(null);
      sound.disconnect();
      video.removeAttribute('src');
      video.load();
    },
  };
  video.addEventListener('ended', () => { if (liveShot === shot) stopShot(); });
  liveShot = shot;
  setPublishedVideoSource(video);
  await video.play();
}

async function streamText(asset) {
  const res = await fetch(asset.src);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  const text = (await res.text()).trim().slice(0, TEXT_SHOT_MAX_CHARS);
  if (!text) throw new Error('the text file is empty');
  if (!sendChatMessage(text)) throw new Error('Jitsi chat is not available');
}

function fireShot({ snippet, asset }) {
  stopShot();
  const run = asset.medium === 'audio' ? streamAudio : asset.medium === 'video' ? streamVideo : streamText;
  status(`Streaming "${snippet.name}"`);
  run(asset).catch((e) => {
    console.error(`[no-code] single shot "${snippet.name}" failed`, e);
    stopShot();
    status(`"${snippet.name}" did not stream: ${e.message}`);
  });
}

function requestShot(snippet) {
  const asset = singleShotAsset(snippet);
  if (!asset) return;
  if (myTurn()) {
    pendingShot = null;
    fireShot({ snippet, asset });
  } else {
    pendingShot = { snippet, asset };
    status(`"${snippet.name}" will stream on your turn`);
  }
}

document.addEventListener('trussal-jpattern-active', () => {
  if (myTurn()) {
    if (pendingShot) {
      const shot = pendingShot;
      pendingShot = null;
      fireShot(shot);
    }
  } else if (liveShot) {
    stopShot();
  }
});

// --- Board edits ----------------------------------------------------------------

function commit(next) {
  if (next === board) return;
  board = next;
  lineErrors = new Map();
  target = null;
  sendNoCodeBoard(board);
  renderBoard();
}

function snippetFor(id) {
  return libraryById(library).get(id) || null;
}

function samePath(a, b) {
  return !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
}

// Drop or "+" a snippet: into the given slot path, before line `at`, or onto
// the end of the board.
function place(id, { path = null, at = null } = {}) {
  const snippet = snippetFor(id);
  if (!snippet) return;
  if (path) commit(placeAt(board, path, snippet));
  else commit(addLine(board, snippet, at));
}

// --- Running --------------------------------------------------------------------

const fetchCache = new Map(); // url → { at, promise }

function fetchJson(url) {
  const key = String(url);
  const hit = fetchCache.get(key);
  if (hit && Date.now() - hit.at < FETCH_CACHE_MS) return hit.promise;
  const promise = fetch(key, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }).then((res) => {
    if (!res.ok) throw new Error(`${key}: ${res.status} ${res.statusText}`);
    return res.json();
  });
  fetchCache.set(key, { at: Date.now(), promise });
  // A failure is not remembered: the next run asks again.
  promise.catch(() => { if (fetchCache.get(key)?.promise === promise) fetchCache.delete(key); });
  return promise;
}

function groupSamples(samples) {
  const out = {};
  for (const s of samples) (out[s.bank] ||= []).push({ name: s.name, src: s.src });
  return out;
}

async function run({ roomWide }) {
  const local = getLocalPeer();
  status('Running…');
  const { plan, errors } = await runBoard(board, library, {
    token: local?.roomIndex != null ? String(local.roomIndex) : null,
    activeToken: getActiveJPatternToken(),
    isMyTurn: myTurn(),
    fetchJson,
  });
  lineErrors = new Map(errors.map((e) => [e.line, e.message]));
  for (const e of errors) console.warn(`[no-code] line ${e.line + 1}: ${e.message}`);
  renderBoard();

  const problems = [];
  if (plan.samples.length || Object.keys(plan.files).length) {
    problems.push(...await loadCodeAssets({ samples: groupSamples(plan.samples), files: plan.files }));
  }
  if (roomWide && plan.prebake) {
    const { errors: prebakeErrors } = validatePrebake(plan.prebake);
    if (prebakeErrors.length) problems.push(...prebakeErrors.map((e) => `room: ${e}`));
    else {
      const mp = await sendPrebakeToRoom(plan.prebake, { keepMetaprogram: true });
      problems.push(...mp.map((e) => `room metaprogram ${e.line}:${e.col} ${e.message}`));
    }
  }
  if (roomWide && plan.metaprogram) {
    const m = await import('./audio-net/Metaprogrammer.js');
    problems.push(...m.applyProgramText(plan.metaprogram).map((e) => `metaprogram ${e.line}:${e.col} ${e.message}`));
  }
  if (plan.program) {
    document.dispatchEvent(new CustomEvent('trussal-no-code-program', { detail: { code: plan.program } }));
  }
  for (const p of problems) console.warn('[no-code]', p);

  const failed = errors.length + problems.length;
  status(failed ? `Ran with ${failed} problem(s)${errors.length ? ' — see the marked lines' : ', see console'}` : 'Board ran');
}

function runSafely(opts) {
  run(opts).catch((e) => {
    console.error('[no-code] running the board failed', e);
    status(`Run failed: ${e.message}`);
  });
}

// --- Upload ---------------------------------------------------------------------

async function onFileChosen(file) {
  status('Reading snippets…');
  const parsed = parseLibrary(await file.text());
  for (const w of parsed.warnings) console.warn('[no-code]', w);
  if (!parsed.ok) {
    for (const e of parsed.errors) console.error('[no-code]', e);
    status(`Snippets rejected: ${parsed.errors[0]}${parsed.errors.length > 1 ? ` (+${parsed.errors.length - 1} more, see console)` : ''}`);
    return;
  }
  const merged = mergeLibrary(library, parsed.snippets);
  if (JSON.stringify(merged).length > NO_CODE_MAX_BYTES) {
    status(`The library would be over the ${NO_CODE_MAX_BYTES / (1024 * 1024)}MB limit`);
    return;
  }
  library = merged;
  sendNoCodeLibrary(library);
  renderLibrary();
  renderBoard();
  status(`Added ${parsed.snippets.length} snippet(s) from "${file.name}"${parsed.warnings.length ? ` (${parsed.warnings.length} warning(s), see console)` : ''}`);
}

// A library from the room is re-checked here: a buggy or hostile peer's
// snippet is dropped rather than rendered or run.
function acceptLibrary(snippets) {
  library = snippets.filter((s) => s && typeof s === 'object'
    && !validateLibrary({ snippets: [s] }).errors.length
    && s.id === snippetId(s));
}

// --- Rendering ------------------------------------------------------------------

const TYPE_BADGE = { pattern: 'P', room: 'R', assetPack: 'A', flow: 'F' };

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, title, onClick, className = '') {
  const b = el('button', `ts-btn ts-dwell-btn ${className}`.trim(), label);
  b.type = 'button';
  b.title = title;
  b.addEventListener('click', onClick);
  return b;
}

// The audiovisual icon of a snippet: its thumbnail (or a type badge), its
// hover and click sounds, and — for a single-shot pack — click to stream.
function icon(snippet, { draggable = false } = {}) {
  const node = el('div', `nc-icon nc-type-${snippet?.type || 'missing'}`);
  if (!snippet) {
    node.append(el('span', 'nc-badge', '?'), el('span', 'nc-icon-name', 'missing'));
    node.title = 'This snippet is not in the library (yet)';
    return node;
  }
  if (snippet.thumbnailImage) {
    const img = el('img', 'nc-thumb');
    img.src = snippet.thumbnailImage;
    img.alt = '';
    img.draggable = false;
    node.append(img);
  } else {
    node.append(el('span', 'nc-badge', TYPE_BADGE[snippet.type]));
  }
  node.append(el('span', 'nc-icon-name', snippet.name));
  const shot = singleShotAsset(snippet);
  if (shot) node.classList.add('nc-single-shot');
  node.title = [
    snippet.name,
    `${snippet.type}${snippet.language ? ` · ${snippet.language}` : ''}${snippet.medium ? ` · ${snippet.medium}` : ''}`,
    operandCount(snippet) ? `${operandCount(snippet)} operand(s)` : null,
    shot ? `click to stream this ${shot.medium} on your turn` : null,
    snippet.description || null,
  ].filter(Boolean).join('\n');
  node.addEventListener('mouseenter', () => playThumb(snippet, 'hover'));
  node.addEventListener('click', () => {
    playThumb(snippet, 'click');
    if (shot) requestShot(snippet);
  });
  if (draggable) {
    node.draggable = true;
    node.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData(DRAG_TYPE, snippet.id);
      e.dataTransfer.setData('text/plain', snippet.name);
      e.dataTransfer.effectAllowed = 'copy';
    });
  }
  return node;
}

// A drop target: highlighted while a snippet is dragged over it.
function dropTarget(node, onDrop) {
  node.addEventListener('dragover', (e) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
    node.classList.add('nc-drop-over');
  });
  node.addEventListener('dragleave', () => node.classList.remove('nc-drop-over'));
  node.addEventListener('drop', (e) => {
    node.classList.remove('nc-drop-over');
    const id = e.dataTransfer.getData(DRAG_TYPE);
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    onDrop(id);
  });
}

function renderLibrary() {
  const list = win?.querySelector('.nc-library-list');
  if (!list) return;
  list.replaceChildren();
  if (!library.length) {
    list.append(el('p', 'nc-empty-note', 'No snippets yet. Upload a JSON file of snippets to fill the library.'));
    return;
  }
  for (const snippet of library) {
    const card = el('div', 'nc-card');
    card.append(icon(snippet, { draggable: true }));
    const meta = el('div', 'nc-card-meta');
    meta.append(el('div', 'nc-card-name', snippet.name));
    meta.append(el('div', 'nc-card-kind', [snippet.type, snippet.language, snippet.medium].filter(Boolean).join(' · ')));
    if (snippet.description) meta.append(el('div', 'nc-card-desc', snippet.description));
    card.append(meta);
    card.append(button('+', target ? 'Place in the selected slot' : 'Add as a new line', () => {
      if (target) place(snippet.id, { path: target });
      else place(snippet.id);
    }, 'nc-add'));
    list.append(card);
  }
}

function renderNode(node, path) {
  const snippet = snippetFor(node.ref);
  const box = el('div', 'nc-node');
  box.append(icon(snippet));
  if (node.operands.length) {
    const slots = el('div', 'nc-slots');
    node.operands.forEach((child, i) => {
      const childPath = [...path, i];
      const slot = el('div', 'nc-slot');
      if (child) {
        slot.append(renderNode(child, childPath));
        slot.append(button('×', 'Empty this slot', () => commit(removeAt(board, childPath)), 'nc-remove'));
      } else {
        slot.classList.add('nc-slot-empty');
        if (samePath(target, childPath)) slot.classList.add('nc-slot-target');
        slot.textContent = `operand ${i + 1}`;
        slot.tabIndex = 0;
        slot.title = 'Drop a snippet here, or select this slot and press + on a snippet';
        slot.addEventListener('click', () => {
          target = samePath(target, childPath) ? null : childPath;
          renderBoard();
          renderLibrary();
        });
      }
      dropTarget(slot, (id) => place(id, { path: childPath }));
      slots.append(slot);
    });
    box.append(slots);
  }
  return box;
}

function renderBoard() {
  const lines = win?.querySelector('.nc-lines');
  if (!lines) return;
  lines.replaceChildren();
  board.lines.forEach((line, i) => {
    const row = el('div', 'nc-line');
    const err = lineErrors.get(i);
    if (err) {
      row.classList.add('nc-line-error');
      row.title = err;
    }
    const gutter = el('div', 'nc-gutter', String(i + 1));
    gutter.title = 'Drop a snippet here to insert a line above';
    dropTarget(gutter, (id) => place(id, { at: i }));
    row.append(gutter);
    row.append(renderNode(line, [i]));
    const tools = el('div', 'nc-line-tools');
    tools.append(
      button('↑', 'Move line up', () => commit(moveLine(board, i, i - 1))),
      button('↓', 'Move line down', () => commit(moveLine(board, i, i + 1))),
      button('×', 'Remove line', () => commit(removeAt(board, [i])), 'nc-remove'),
    );
    row.append(tools);
    if (err) row.append(el('div', 'nc-line-message', err));
    lines.append(row);
  });
  const add = el('div', 'nc-newline', board.lines.length ? 'Drop here to add a line' : 'Drag snippets from the library onto the whiteboard');
  dropTarget(add, (id) => place(id));
  lines.append(add);
}

function ensureWindow() {
  if (win) return win;
  win = el('div', 'ts-window');
  win.id = WINDOW_ID;
  win.dataset.window = 'no-code';
  win.setAttribute('role', 'dialog');
  win.setAttribute('aria-labelledby', `${WINDOW_ID}-title`);
  win.innerHTML = `
    <div class="ts-header">
      <div class="ts-title" id="${WINDOW_ID}-title">No Code</div>
      <button class="ts-dwell-btn ts-collapse-btn" type="button" title="Collapse / expand window">▼</button>
      <button class="ts-close" type="button" title="Close No Code">✕</button>
    </div>
    <div class="ts-window-body nc-body">
      <section class="nc-library" aria-label="Snippet library">
        <div class="nc-bar"></div>
        <div class="nc-library-list"></div>
      </section>
      <section class="nc-board" aria-label="Whiteboard">
        <div class="nc-bar"></div>
        <div class="nc-lines"></div>
      </section>
    </div>
    <div class="nc-status" role="status"></div>
  `;
  document.body.appendChild(win);

  const input = el('input', 'ts-hidden');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    try { await onFileChosen(file); } catch (e) {
      console.error('[no-code] upload failed', e);
      status(`Upload failed: ${e.message}`);
    }
  });
  const libBar = win.querySelector('.nc-library .nc-bar');
  libBar.append(button('Upload snippets', 'Upload a JSON file of snippets into this meeting\'s library', () => input.click()), input);

  const boardBar = win.querySelector('.nc-board .nc-bar');
  boardBar.append(
    button('Run', 'Run the whiteboard line by line as your own program', () => runSafely({ roomWide: true }), 'play'),
    button('Run for room', 'Run the whiteboard in every participant\'s browser', () => {
      sendNoCodeRun(board.rev);
      runSafely({ roomWide: true });
    }),
    button('Clear', 'Remove every line from the whiteboard', () => commit({ rev: board.rev + 1, lines: [] })),
  );

  // Same outside-click guard as the Studio windows: clicks in here must not
  // read as clicks outside an open Jitsi popover.
  win.addEventListener('mousedown', (e) => e.stopPropagation());
  win.addEventListener('click', (e) => e.stopPropagation());
  win.addEventListener('pointerdown', () => {
    stackSeq += 1;
    win.style.setProperty('--ts-stack', String(999990 + 500 + stackSeq));
  });
  win.querySelector('.ts-close').addEventListener('click', () => setOpen(false));
  const collapseBtn = win.querySelector('.ts-collapse-btn');
  collapseBtn.addEventListener('click', () => {
    const collapsed = win.classList.toggle('ts-collapsed');
    collapseBtn.textContent = collapsed ? '▲' : '▼';
  });
  attachPanelControls(win, { handle: win.querySelector('.ts-header'), minW: 560, minH: 320 });

  status(statusText);
  renderLibrary();
  renderBoard();
  return win;
}

function setOpen(open) {
  if (open) ensureWindow();
  if (win) win.classList.toggle('ts-open', open);
  const btn = document.getElementById(BUTTON_ID);
  if (btn) {
    btn.classList.toggle('on', open);
    btn.setAttribute('aria-expanded', String(open));
  }
}

export function closeNoCodeWindow() {
  setOpen(false);
}

// --- Room state -----------------------------------------------------------------

subscribePeerState((event, payload) => {
  if (IS_BOT || IS_AGGREGATOR) return;
  if (event === 'no-code-library') {
    acceptLibrary(payload.snippets);
    renderLibrary();
    renderBoard();
  } else if (event === 'no-code-board') {
    board = sanitizeBoard(payload.board);
    lineErrors = new Map();
    target = null;
    renderBoard();
  } else if (event === 'no-code-run') {
    // The room-wide parts already went out from whoever asked.
    runSafely({ roomWide: false });
  }
});

// The toolbar button, beside Prebake.
export function injectNoCodeButton(host) {
  if (!host || IS_BOT || IS_AGGREGATOR || document.getElementById(BUTTON_ID)) return;
  const btn = el('button', 'ts-dwell-btn', 'No Code');
  btn.id = BUTTON_ID;
  btn.type = 'button';
  btn.title = 'No Code: drag uploaded snippets onto a shared whiteboard and run them';
  btn.setAttribute('aria-controls', WINDOW_ID);
  btn.setAttribute('aria-expanded', 'false');
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => setOpen(!win?.classList.contains('ts-open')));
  host.insertBefore(btn, host.querySelector('.ts-close'));
}

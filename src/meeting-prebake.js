// meeting-prebake.js — the Studio's Prebake upload, and what each browser does
// with the prebake once it arrives.
//
// The file format and every translation rule live in meeting-prebake-core.js;
// this module is the glue between that and the browser.
//
// ONE UPLOAD, APPLIED EVERYWHERE BY ITS OWNER. Anyone in the meeting uploads
// the file from the toolbar. The sidecar relays it to the whole room and keeps
// it for the life of the room, so a participant who joins later receives it
// at hello (latency-instrument/server.js 'prebake'). Each browser then applies
// only what is its own to apply, because only it can:
//
//   • a human applies its token's entry — display name, personal theme,
//     gesture settings, Landmark and Gesture Mode on/off, and its code
//     (samples/files into this browser's IndexedDB, the source into the
//     personal editor, unevaluated — the performer presses Play — in the
//     editor language it names, JPattern by default). Any of
//     those the entry leaves out falls back to its default — the default
//     theme, the default gesture map, the mode off, the default program — so
//     a prebaked participant starts from a known state, not from whatever
//     this browser was last left in. A display name has no default and is
//     only changed when given; samples and files already stored are kept. A
//     human with no entry is left alone, unless the prebake sets
//     `applySettingsToExistingParticipants`, which resets them to defaults too;
//   • a human also spawns the bots it owns ("0a", "0b" … for human "0") and,
//     as each one boots, pushes that bot its code over the same remote-control
//     path the Studio's per-bot editor uses;
//   • a bot names itself from its own entry (its owner cannot rename it);
//   • whoever's display name matches a `meetingChat` entry posts that entry's
//     lines and files, as themselves — Jitsi only lets a browser speak for its
//     own participant.
//
// The metaprogram is the exception: it is one shared CRDT document, so only
// the uploader applies it, once, and the CRDT carries it to everyone else.
//
// Each browser applies a given prebake once per tab (keyed by the id the
// sidecar stamps on it), so a reconnect or reload does not re-post chat lines
// or re-spawn bots. Uploading a new file replaces the room's prebake and is
// applied afresh.
//
// ALTERNATIVES. Every browser keeps the prebake's alternatives rotation for
// itself, timed from the moment of upload (the sidecar says how long ago that
// was), and applies its own part of each alternative as it fires, by the same
// rules as above. A program it loads is played at once if the performer is
// already playing, so the rotation is heard live. Whoever joins (or reloads)
// mid-rotation catches up to the alternative in force without posting its
// chat lines, which went out when it fired. An alternative's metaprogram is
// set by the uploader, or by the lowest-numbered human once they have left.

import {
  subscribePeerState,
  getAllPeers,
  getLocalPeer,
  sendPrebake,
  sendRemotePattern,
  sendSampleFile,
} from './peer-state.js';
import {
  parsePrebake,
  assembleProgram,
  themePatch,
  gestureConfigWithDefaults,
  humanEntryFor,
  codeFileStore,
  chatKindFor,
  flattenFiles,
  flattenSamples,
  botsForOwner,
  spawnCountFor,
  chatEntryFor,
  chatMessages,
  editorLanguageFor,
  latestFiringAt,
  nextFiringAt,
  settingsFiringAt,
  metaprogramApplierIndex,
} from './meeting-prebake-core.js';
import { emojiNameFromFilename } from './custom-emoji-core.js';
import { initCustomEmoji, listOwnEmoji, addEmojiFromFile } from './custom-emoji.js';
import roomIndices from '../latency-instrument/room-indices.js';
import { ensureDirective } from './program-directive.js';
import { setTheme } from './theme-context.js';
import { DEFAULT_PATTERN } from './strudel.js';
import { setNickname, localParticipantName } from './chat-entry.js';
import { uploadSamplesToDB } from './user-samples.js';
import { uploadChatFilesToDB, postChatFile } from './file-cycles.js';
import { spawnBots } from './audio-net/UserBotOrchestration.js';
import { buildDefaultProgram } from './audio-net/MetaprogrammerParser.js';

const { parseParticipantToken } = roomIndices;

const PREBAKE_BUTTON_ID = 'trussal-prebake-button';
const APPLIED_KEY = 'trussal.prebake.applied';
const APPLIED_ALT_KEY = 'trussal.prebake.appliedAlternative';
// Long enough for a just-set display name to reach the room before the first
// chat line goes out under it.
const RENAME_SETTLE_MS = 1500;

const IS_BOT = typeof window !== 'undefined' && !!window.__trussalIsBot;
const IS_AGGREGATOR = typeof window !== 'undefined' && !!window.__trussalIsAggregator;

let current = null;      // { id, prebake, fromIndex, startedAt } — the room's prebake
let appliedTag = null;   // `${id}:${token}` this tab has applied (or is applying)
let altTimer = null;     // the next alternatives firing
let altChain = Promise.resolve(); // applies run one after another, never overlapping
const pendingBotCode = new Map(); // bot token → editor text still to push

function status(text) {
  document.dispatchEvent(new CustomEvent('trussal-prebake-status', { detail: text }));
}

function readApplied(key = APPLIED_KEY) {
  try { return sessionStorage.getItem(key); } catch (e) { return null; }
}

function writeApplied(tag, key = APPLIED_KEY) {
  try {
    sessionStorage.setItem(key, tag);
  } catch (e) {
    // Only the reload guard is lost: this tab's appliedTag still stops a
    // second apply until the page reloads.
    console.warn('[prebake] could not record the applied prebake for this tab', e);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- Fetching the file's referenced files -----------------------------------

async function fetchBlob(src) {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.blob();
}

// uploadSamplesToDB / uploadChatFilesToDB read a File's name, folder path,
// type, size and bytes — a stand-in with those fields stores exactly as a
// picked file would, with `bank` as the folder that names a sample bank.
function asUploadFile(name, blob, bank = null) {
  return {
    name,
    webkitRelativePath: bank ? `${bank}/${name}` : '',
    type: blob.type,
    size: blob.size,
    arrayBuffer: () => blob.arrayBuffer(),
    text: () => blob.text(),
  };
}

async function fetchAll(entries, label) {
  const out = [];
  const errors = [];
  for (const entry of entries) {
    try {
      out.push({ ...entry, blob: await fetchBlob(entry.src) });
    } catch (e) {
      errors.push(`${label} "${entry.name}": ${e.message}`);
    }
  }
  return { out, errors };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result).split(',')[1] || '');
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// --- Applying a human's entry -----------------------------------------------

// Fetch a `code` object's samples and files into this browser's IndexedDB.
// Also how a No Code asset pack loads (no-code.js). Returns the problems.
export async function loadCodeAssets(code) {
  const errors = [];
  const samples = await fetchAll(flattenSamples(code.samples), 'sample');
  const files = await fetchAll(flattenFiles(code.files), 'file');
  errors.push(...samples.errors, ...files.errors);

  const toSampleStore = [
    ...samples.out.map((s) => asUploadFile(s.name, s.blob, s.bank)),
    ...files.out.filter((f) => codeFileStore(f.bucket) === 'data').map((f) => asUploadFile(f.name, f.blob)),
  ];
  const toFileStore = files.out.filter((f) => codeFileStore(f.bucket) === 'files').map((f) => asUploadFile(f.name, f.blob));

  let loaded = { audio: 0, images: 0, packs: 0 };
  if (toSampleStore.length) {
    await uploadSamplesToDB(toSampleStore, (r) => { loaded = r; errors.push(...(r.errors || [])); });
  }
  if (toFileStore.length) {
    await uploadChatFilesToDB(toFileStore, (r) => { errors.push(...(r.errors || [])); });
  }
  if (loaded.audio || loaded.images || loaded.packs) {
    document.dispatchEvent(new CustomEvent('trussal-prebake-samples-loaded', { detail: loaded }));
  }
  return errors;
}

// `live`: an alternative firing mid-performance, whose program is played at
// once if the performer is already playing (studio.js).
async function loadCode(code, live) {
  const errors = await loadCodeAssets(code);
  const program = assembleProgram(code, 'personal') ?? DEFAULT_PATTERN;
  const { language, source } = editorLanguageFor(code);
  document.dispatchEvent(new CustomEvent('trussal-prebake-program', {
    detail: { code: program, language, source, live },
  }));
  return errors;
}

// Add a human's `customEmoji` to their own emoji. One whose :shortcode: they
// already have is skipped, so an alternative that repeats does not pile up
// numbered copies.
async function loadCustomEmoji(list) {
  if (!Array.isArray(list) || !list.length) return [];
  await initCustomEmoji();
  const have = new Set(listOwnEmoji().map((e) => e.name));
  const wanted = list.filter((e) => !have.has(emojiNameFromFilename(e.name)));
  const { out, errors } = await fetchAll(wanted, 'emoji');
  for (const e of out) {
    try {
      await addEmojiFromFile(new File([e.blob], e.name, { type: e.blob.type }));
    } catch (err) {
      errors.push(`emoji "${e.name}": ${err.message}`);
    }
  }
  return errors;
}

// Bots are spawned through the fleet like the Studio's own botConfig spawn;
// their samples go first, because the fleet builds each bot's sample list at
// spawn time. Every listed bot's code waits in pendingBotCode until that bot
// has booted (flushBotCode).
async function prepareBots(prebake, ownerToken) {
  const mine = botsForOwner(prebake, ownerToken);
  pendingBotCode.clear();
  if (!mine.length) return [];
  const errors = [];

  for (const { entry } of mine) {
    const { out, errors: fetchErrors } = await fetchAll(flattenSamples(entry.code?.samples), 'bot sample');
    errors.push(...fetchErrors);
    for (const s of out) sendSampleFile({ bank: s.bank, name: s.name, data: await blobToBase64(s.blob) });
  }

  for (const { token, entry } of mine) {
    const program = assembleProgram(entry.code, 'bot');
    if (program) pendingBotCode.set(token, program);
  }

  const present = getAllPeers()
    .filter((p) => p.isBot && !p.isAggregator)
    .map((p) => parseParticipantToken(String(p.roomIndex)))
    .filter((t) => t && t.suffix != null && String(t.ownerIndex) === ownerToken)
    .map((t) => t.ordinal);
  const count = spawnCountFor(mine.map((b) => b.ordinal), present);
  if (count) spawnBots(count, getLocalPeer()?.pattern || '');
  flushBotCode();
  return errors;
}

// A bot announces its program once its own REPL has booted; a push before
// then would land on an editor that does not exist yet.
function flushBotCode() {
  if (!pendingBotCode.size) return;
  for (const peer of getAllPeers()) {
    if (!peer.isBot || !peer.peerId) continue;
    const token = String(peer.roomIndex);
    const code = pendingBotCode.get(token);
    if (!code || !peer.pattern) continue;
    pendingBotCode.delete(token);
    sendRemotePattern(peer.peerId, code);
  }
}

// --- Chat -------------------------------------------------------------------

// Exactly what Jitsi's own chat input dispatches (features/chat sendMessage);
// its middleware sends the text on the conference as this participant.
export function sendChatMessage(text) {
  try {
    const store = window.APP?.store;
    if (store && typeof store.dispatch === 'function') {
      store.dispatch({ type: 'SEND_MESSAGE', message: text, ignorePrivacy: false });
      return true;
    }
    const room = window.APP?.conference?._room;
    if (room && typeof room.sendTextMessage === 'function') { room.sendTextMessage(text); return true; }
  } catch (e) {
    console.warn('[prebake] could not send a chat message', e);
  }
  return false;
}

async function postChat(prebake, displayName, chat = true) {
  const entry = chat ? chatEntryFor(prebake, displayName) : null;
  if (!entry) return [];
  const errors = [];
  for (const text of chatMessages(entry)) {
    if (!sendChatMessage(text)) errors.push('chat: Jitsi chat is not available');
  }
  const files = flattenFiles(entry.files);
  if (!files.length) return errors;
  // The sidecar only relays attachments from humans.
  if (IS_BOT) return [...errors, 'chat: bots cannot post files, skipped'];
  const { out, errors: fetchErrors } = await fetchAll(files, 'chat file');
  errors.push(...fetchErrors);
  for (const f of out) {
    const ok = await postChatFile({ name: f.name, kind: chatKindFor(f.bucket, f.name), mime: f.blob.type, blob: f.blob });
    if (!ok) errors.push(`chat file "${f.name}": not posted (over 10MB?)`);
  }
  return errors;
}

// --- Apply ------------------------------------------------------------------

// `chat`: post this participant's meetingChat lines (not when catching up to
// an alternative that already fired). `live`: see loadCode.
async function applyHuman(prebake, token, { chat = true, live = false } = {}) {
  const entry = humanEntryFor(prebake, token);
  const errors = [];
  let renamed = false;
  if (entry) {
    const name = entry.displayName?.trim();
    if (name && name !== localParticipantName()) renamed = setNickname(name);
    setTheme(themePatch(entry.personalTheme));
    // The mode first (off unless asked for): it switches all three limbs
    // together, and any limb the config names then overrides it. This is only
    // the state at this moment — the performer can switch it again any time
    // from the Face button, the eye gesture or → as usual.
    document.dispatchEvent(new CustomEvent('trussal-landmark-gesture-mode', {
      detail: { on: entry.enableMediaPipe === true, source: 'prebake' },
    }));
    if (typeof window.gestureAndLandmarkConfig === 'function') {
      try {
        window.gestureAndLandmarkConfig(gestureConfigWithDefaults(entry.gestureAndLandmarkConfig));
      } catch (e) {
        errors.push(`gestureAndLandmarkConfig: ${e.message}`);
      }
    }
    errors.push(...await loadCustomEmoji(entry.customEmoji));
    errors.push(...await loadCode(entry.code || {}, live));
  }
  errors.push(...await prepareBots(prebake, token));
  if (renamed) await sleep(RENAME_SETTLE_MS);
  errors.push(...await postChat(prebake, entry?.displayName?.trim() || localParticipantName(), chat));
  return { applied: !!entry, errors };
}

async function applyBot(prebake, token, { chat = true } = {}) {
  const entry = prebake.bots?.[token] || null;
  let renamed = false;
  const name = entry?.displayName?.trim();
  if (name && name !== localParticipantName()) renamed = setNickname(name);
  if (renamed) await sleep(RENAME_SETTLE_MS);
  const errors = await postChat(prebake, name || localParticipantName(), chat);
  return { applied: !!entry, errors };
}

// --- Alternatives -----------------------------------------------------------

function isMetaprogramApplier(local) {
  const humans = getAllPeers()
    .filter((p) => !p.isBot && !p.isAggregator && p.roomIndex != null)
    .map((p) => p.roomIndex);
  return metaprogramApplierIndex(current.fromIndex, humans) === Number(local.roomIndex);
}

// Apply every alternative of `owner` (the room's prebake when it was queued)
// that fires at `at` ms after upload, in file order.
async function applyFiring(owner, at, { catchUp }) {
  const local = getLocalPeer();
  if (current !== owner || !local?.jitsiId || local.roomIndex == null) return;
  const token = String(local.roomIndex);
  const tag = `${current.id}:${token}:${at}`;
  if (readApplied(APPLIED_ALT_KEY) === tag) return;
  writeApplied(tag, APPLIED_ALT_KEY);

  const errors = [];
  let applied = false;
  for (const settings of settingsFiringAt(current.prebake, at)) {
    const result = IS_BOT
      ? await applyBot(settings, token, { chat: !catchUp })
      : await applyHuman(settings, token, { chat: !catchUp, live: true });
    applied ||= result.applied;
    errors.push(...result.errors);
    // The CRDT already holds a metaprogram that fired before this browser
    // caught up, so only a live firing sets it.
    if (!IS_BOT && !catchUp && isMetaprogramApplier(local)
      && typeof settings.metaprogram === 'string' && settings.metaprogram.trim()) {
      const m = await import('./audio-net/Metaprogrammer.js');
      for (const e of await m.applyProgramText(ensureDirective(settings.metaprogram, 'metaprogram'))) {
        errors.push(`metaprogram ${e.line}:${e.col} ${e.message}`);
      }
    }
  }
  for (const e of errors) console.warn('[prebake]', e);
  if (IS_BOT || !applied) return;
  const what = `prebake alternative applied for participant ${token}`;
  status(errors.length ? `${what} — ${errors.length} problem(s), see console` : what);
}

function queueFiring(at, opts) {
  const owner = current;
  altChain = altChain
    .then(() => applyFiring(owner, at, opts))
    .catch((e) => {
      console.error('[prebake] applying an alternative failed', e);
      status(`prebake alternative failed: ${e.message}`);
    });
  return altChain;
}

function scheduleNextFiring() {
  clearTimeout(altTimer);
  altTimer = null;
  if (!current) return;
  const elapsed = Date.now() - current.startedAt;
  const next = nextFiringAt(current.prebake, elapsed);
  if (next == null) return;
  const owner = current;
  altTimer = setTimeout(() => {
    if (current !== owner) return;
    queueFiring(next, { catchUp: false });
    scheduleNextFiring();
  }, next - elapsed);
}

// Called once this browser has applied (or skipped) the prebake itself:
// catch up to the alternative in force, if one has fired, then follow the
// rotation from here.
function startAlternatives() {
  if (!current) return;
  const latest = latestFiringAt(current.prebake, Date.now() - current.startedAt);
  if (latest != null) queueFiring(latest, { catchUp: true });
  scheduleNextFiring();
}

function tryApply() {
  if (!current || IS_AGGREGATOR) return;
  const local = getLocalPeer();
  if (!local?.jitsiId || local.roomIndex == null) return;
  const token = String(local.roomIndex);
  const tag = `${current.id}:${token}`;
  if (appliedTag === tag) return;
  appliedTag = tag;
  if (readApplied() === tag) {
    altChain = altChain.then(startAlternatives);
    return;
  }
  writeApplied(tag);

  const { prebake } = current;
  const base = (IS_BOT ? applyBot(prebake, token) : applyHuman(prebake, token));
  altChain = base.then(startAlternatives, startAlternatives);
  base
    .then(({ applied, errors }) => {
      for (const e of errors) console.warn('[prebake]', e);
      if (IS_BOT) return;
      const what = applied ? `prebake applied for participant ${token}` : `prebake received (nothing for participant ${token})`;
      status(errors.length ? `${what} — ${errors.length} problem(s), see console` : what);
    })
    .catch((e) => {
      console.error('[prebake] applying the prebake failed', e);
      status(`prebake failed: ${e.message}`);
    });
}

subscribePeerState((event, payload) => {
  if (event === 'prebake') {
    // A reconnect re-sends the same prebake: keep its rotation, just re-time it.
    const same = current?.id === payload.id;
    current = { ...payload, startedAt: Date.now() - (payload.elapsed || 0) };
    clearTimeout(altTimer);
    altTimer = null;
    if (same && appliedTag) { scheduleNextFiring(); return; }
    pendingBotCode.clear();
    tryApply();
  } else if (event === 'peer-upsert' || event === 'connected') {
    tryApply();
    flushBotCode();
  }
});

// --- Upload -----------------------------------------------------------------

async function onFileChosen(file) {
  status('Reading prebake…');
  const { ok, prebake, errors, warnings } = parsePrebake(await file.text());
  for (const w of warnings) console.warn('[prebake]', w);
  if (!ok) {
    for (const e of errors) console.error('[prebake]', e);
    status(`Prebake rejected: ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more, see console)` : ''}`);
    return;
  }
  const mpErrors = await sendPrebakeToRoom(prebake);
  if (mpErrors.length) {
    const e = mpErrors[0];
    status(`Prebake sent; metaprogram ${e.line}:${e.col} ${e.message}`);
    return;
  }
  status(`Prebake "${file.name}" sent to the room${warnings.length ? ` (${warnings.length} warning(s), see console)` : ''}`);
}

// Send an already-validated prebake to the room and apply its metaprogram
// here (the CRDT carries it to everyone else). A prebake with no metaprogram
// sets the room's default one, unless `keepMetaprogram` — a No Code room
// snippet that does not mention the metaprogram leaves it as it is. Returns
// the metaprogram's parse errors.
export async function sendPrebakeToRoom(prebake, { keepMetaprogram = false } = {}) {
  sendPrebake(prebake);
  const given = typeof prebake.metaprogram === 'string' && prebake.metaprogram.trim();
  if (!given && keepMetaprogram) return [];
  const metaprogram = given ? ensureDirective(prebake.metaprogram, 'metaprogram') : buildDefaultProgram();
  const m = await import('./audio-net/Metaprogrammer.js');
  return m.applyProgramText(metaprogram);
}

// The toolbar button, next to Keys and Face. The hidden input lives inside the
// button's own wrapper so a toolbar re-attach carries it along.
export function injectPrebakeButton(host) {
  if (!host || IS_BOT || document.getElementById(PREBAKE_BUTTON_ID)) return;
  const btn = document.createElement('button');
  btn.id = PREBAKE_BUTTON_ID;
  btn.type = 'button';
  btn.className = 'ts-dwell-btn';
  btn.title = 'Upload a meeting prebake (JSON): the metaprogram, every participant\'s and bot\'s setup, and the opening chat';
  btn.textContent = 'Prebake';
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.json,application/json';
  input.className = 'ts-hidden';
  btn.addEventListener('mousedown', (e) => e.preventDefault());
  btn.addEventListener('click', () => input.click());
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    try { await onFileChosen(file); } catch (e) {
      console.error('[prebake] upload failed', e);
      status(`Prebake failed: ${e.message}`);
    }
  });
  const closeBtn = host.querySelector('.ts-close');
  host.insertBefore(btn, closeBtn);
  host.insertBefore(input, closeBtn);
}

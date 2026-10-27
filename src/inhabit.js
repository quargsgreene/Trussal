// inhabit.js — the browser half of the Metaprogram's `# inhabit` method (see
// inhabit-core.js for the grammar and the rules). While the map has this
// participant inside a HOST, this browser:
//
//   editor       shows the host's personal editor instead of its own: one Yjs
//                doc per host, shared by the host and every guest inside it,
//                so any number of them type into it at once. Play runs it as
//                the host's program (a remote-control 'pattern', which the
//                sidecar allows a guest). The guest's own editor comes back,
//                untouched, when it leaves.
//   chats        lists the host's private text chats and sends private
//                messages AS the host — the host's browser sends them.
//   theme        wears the host's theme (never saved as its own).
//   devices      lists the host's output devices, and answers `.out(…)`
//                routing requests for them in the host's place.
//   permissions  holds the host's metaprogram permissions (the sidecar
//                enforces this; shown here).
//   room         follows the host into its breakout room (breakout.js).
//   ring         takes the host's turn on the metaprogram rotation — its
//                audio is mixed into the host's slot by the aggregator, and
//                isPeerJPatternTurn answers for the host's token.
//   settings     takes on the host's audio effect toggles.
//
// And while guests are inside THIS participant, this browser seeds and keeps
// its editor doc, sends each guest a snapshot of the rest on every change,
// carries out what they ask (a private message, a route decision, running
// the editor), and says plainly who is inside and what they can see.
//
// A bot is a participant like any other: a human may inhabit a bot (its
// editor doc is seeded from the bot's running pattern, and Play re-evaluates
// the bot) and a bot may inhabit a human (it takes the human's slot, room
// and permissions; a bot has no screen to show an editor, chats or a theme
// on, so it keeps playing its own code — in the host's place).

import * as Y from 'yjs';
import {
  subscribePeerState, getAllPeers, getLocalPeer, getInhabitMap,
  sendInhabitMap, sendInhabitRelay, sendEditorCrdtUpdate, requestEditorCrdtState,
  sendRemotePattern, sendLocalEffects,
} from './peer-state.js';
import {
  inhabitRole, resolveInhabitMap, inhabitMapsEqual, sanitizeHostSnapshot, privateChatEntry,
  INHABIT_THEME_KEYS, MAX_CHAT_TEXT, MAX_CHAT_MESSAGES,
} from './inhabit-core.js';
import { encodeUpdateB64, encodeFullState, applyRemoteUpdate, applyTextDiff } from './audio-net/MetaprogrammerCrdtSync.js';
import { getProgramText } from './audio-net/Metaprogrammer.js';
import { parseMetaprogram } from './audio-net/MetaprogrammerParser.js';
import { getTheme, setThemeOverride, subscribeTheme } from './theme-context.js';
import { getDeviceInventory, getRouteRequests, decideRoute } from './output-route.js';
import { stripOutRoutes } from './output-route-core.js';
import { getCurrentRoomName } from './breakout.js';
import { jitsiState } from './chat-entry.js';
import { mayInhabitMe } from './permissions.js';

const LOCAL_IS_BOT = !!(typeof window !== 'undefined' && window.__trussalIsBot);
const LOCAL_IS_AGGREGATOR = !!(typeof window !== 'undefined' && window.__trussalIsAggregator);

// The local personal editor — the same element studio.js's
// loadProgramIntoEditor writes to.
const EDITOR_SELECTOR = '.ts-window[data-window="personal"] .ts-detail[data-peer-key="local"] .ts-code';
const DOC_TEXT_KEY = 'editor';
const SNAPSHOT_EVERY = 25;       // full-state snapshot every n local updates, as MetaprogrammerCrdtSync does
const SNAPSHOT_DEBOUNCE_MS = 300;
const HOST_SEED_WAIT_MS = 1500;  // how long a host waits for its doc's history before seeding without it
const TICK_MS = 1000;

let map = {};
let guestState = null; // { host, savedEditor, savedEffects, snapshot }
let hostState = null;  // { guests: Set<token>, lastSent: Map<token, json>, unsubChat, unsubTheme }
const editors = new Map(); // host token → { host, doc, text, ready, localUpdates }
let bound = null;          // the editor doc the local textarea is showing
let writing = false;       // set while this module writes the textarea itself
const written = new WeakSet(); // textareas already filled from `bound`

// --- who is who -----------------------------------------------------------------

function myToken() {
  const t = getLocalPeer()?.roomIndex;
  return t == null ? null : String(t);
}

function peerByToken(token) {
  return getAllPeers().find((p) => p.roomIndex != null && String(p.roomIndex) === String(token)) || null;
}

function presentTokens() {
  return getAllPeers().filter((p) => p.roomIndex != null && !p.isAggregator).map((p) => String(p.roomIndex));
}

function nameOf(token) {
  const p = peerByToken(token);
  return p?.displayName || `Participant ${token}`;
}

function editorEl() {
  return typeof document === 'undefined' ? null : document.querySelector(EDITOR_SELECTOR);
}

// Whether this browser is inside someone else right now — studio.js asks
// before it saves a draft or runs the editor.
export function isInhabiting() {
  return !!guestState && !LOCAL_IS_BOT;
}

// Play / Ctrl+Enter while inhabiting: the editor is the host's, so the code
// runs as the host's program. Returns the status line to show.
export function runInHost(code) {
  const host = guestState?.host;
  const peer = host != null ? peerByToken(host) : null;
  if (!peer || !peer.peerId) return 'The participant you are inhabiting is not here';
  const c = typeof code === 'string' ? code : '';
  // A bot's bare REPL has no `.out(…)` routing — same as editing its tile.
  sendRemotePattern(peer.peerId, peer.isBot ? stripOutRoutes(c) : c);
  return `Sent to ${nameOf(host)} — it plays as their program`;
}

// --- the shared editor doc ------------------------------------------------------

function editorDoc(host) {
  let entry = editors.get(host);
  if (entry) return entry;
  const doc = new Y.Doc();
  entry = { host, doc, text: doc.getText(DOC_TEXT_KEY), ready: false, localUpdates: 0 };
  doc.on('update', (update, origin) => {
    if (origin === 'remote') return;
    entry.localUpdates++;
    const snapshot = entry.localUpdates % SNAPSHOT_EVERY === 0;
    sendEditorCrdtUpdate(host, snapshot ? encodeFullState(doc) : encodeUpdateB64(update), { snapshot });
  });
  entry.text.observe((event, tx) => {
    if (tx.origin !== 'remote') return;
    // The host's own doc is not shown until the host has seeded it (seedHost)
    // — writing a guest's history into the host's textarea first would throw
    // away what the host had there.
    if (host === myToken() && !entry.ready) return;
    entry.ready = true;
    if (bound === entry) writeEditor(entry, event.delta);
  });
  editors.set(host, entry);
  return entry;
}

// Where `offset` lands once a Y.Text delta has been applied before/around it.
function shiftOffset(offset, delta) {
  let pos = 0;
  let out = offset;
  for (const op of delta || []) {
    if (op.retain) pos += op.retain;
    else if (op.insert != null) {
      const len = typeof op.insert === 'string' ? op.insert.length : 1;
      if (pos <= out) out += len;
      pos += len;
    } else if (op.delete) {
      if (pos < out) out -= Math.min(op.delete, out - pos);
    }
  }
  return out;
}

// Show the doc in the textarea, keeping the local caret where it was relative
// to the text around it. The 'input' it dispatches is what studio.js keys its
// draft and voice buttons off; isInhabiting() keeps a guest's draft its own.
function writeEditor(entry, delta = null) {
  const el = editorEl();
  if (!el || !entry.ready) return;
  const value = entry.text.toString();
  written.add(el);
  if (el.value === value) return;
  const focused = typeof document !== 'undefined' && document.activeElement === el;
  const start = focused && delta ? shiftOffset(el.selectionStart, delta) : null;
  const end = focused && delta ? shiftOffset(el.selectionEnd, delta) : null;
  writing = true;
  try {
    el.value = value;
    if (start != null) el.setSelectionRange(start, end);
    el.dispatchEvent(new Event('input', { bubbles: true }));
  } finally {
    writing = false;
  }
}

function setEditorLocked(locked, host = null) {
  const el = editorEl();
  if (!el) return;
  el.readOnly = !!locked;
  if (locked) el.placeholder = `Waiting for ${nameOf(host)}'s editor…`;
  else el.removeAttribute('placeholder');
}

// The host's own text, which its doc is seeded from: what its editor shows —
// or, while the host is itself away inside someone else, the editor it left
// behind; a bot's running pattern.
function ownEditorText() {
  if (guestState) return guestState.savedEditor ?? getLocalPeer()?.pattern ?? '';
  const el = editorEl();
  if (el && !LOCAL_IS_BOT) return el.value;
  return getLocalPeer()?.pattern ?? '';
}

function seedHost(entry) {
  if (entry.ready) return;
  applyTextDiff(entry.text, ownEditorText(), 'local');
  entry.ready = true;
  if (bound === entry) writeEditor(entry);
  scheduleSnapshot(true);
}

// Which doc the textarea should show: the host's while inside one, this
// participant's own while hosting, none otherwise. (A bot has no textarea;
// its own doc is kept on its pattern instead — see the peer-upsert hook.)
function rebind() {
  const me = myToken();
  const wanted = guestState && !LOCAL_IS_BOT ? guestState.host : (hostState ? me : null);
  if ((bound?.host ?? null) !== wanted) {
    bound = wanted == null ? null : editorDoc(wanted);
    if (bound && wanted !== me) requestEditorCrdtState(wanted);
    const el = editorEl();
    if (el) written.delete(el);
  }
  const el = editorEl();
  if (!bound || !el || written.has(el)) return;
  if (bound.ready) { setEditorLocked(false); writeEditor(bound); } else if (wanted !== me) setEditorLocked(true, wanted);
}

// Start keeping this participant's own doc: fetch whatever history it has
// (guests may have typed into it in an earlier inhabitation, or before this
// browser reloaded), then seed it from the editor — with or without the
// history, if none comes back in time.
function startOwnDoc() {
  const me = myToken();
  const entry = editorDoc(me);
  entry.ready = false;
  requestEditorCrdtState(me);
  setTimeout(() => { if (hostState) seedHost(entry); }, HOST_SEED_WAIT_MS);
}

if (typeof document !== 'undefined') {
  document.addEventListener('input', (e) => {
    if (writing || !bound || !bound.ready) return;
    const el = e.target;
    if (!el || typeof el.matches !== 'function' || !el.matches(EDITOR_SELECTOR)) return;
    applyTextDiff(bound.text, el.value, 'local');
  }, true);
}

// --- being a guest --------------------------------------------------------------

function enterGuest(host) {
  const el = editorEl();
  const me = getLocalPeer();
  guestState = {
    host,
    savedEditor: el && !LOCAL_IS_BOT ? el.value : null,
    savedEffects: me?.effects ? { ...me.effects } : null,
    snapshot: null,
  };
  const peer = peerByToken(host);
  if (peer?.peerId && !LOCAL_IS_BOT) sendInhabitRelay(peer.peerId, 'join');
  console.log(`[inhabit] inhabiting ${nameOf(host)} (${host})`);
}

function leaveGuest() {
  const { host, savedEditor, savedEffects } = guestState;
  guestState = null;
  bound = null;
  if (!LOCAL_IS_BOT) {
    setThemeOverride(null);
    const el = editorEl();
    if (el) {
      setEditorLocked(false);
      // Back to this participant's own editor — as its own guests left it,
      // if it is hosting, else as it was before the inhabitation.
      const own = hostState ? editors.get(myToken()) : null;
      const value = own?.ready ? own.text.toString() : savedEditor;
      if (typeof value === 'string' && el.value !== value) {
        writing = true;
        try { el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); } finally { writing = false; }
      }
      written.delete(el);
    }
    if (savedEffects && JSON.stringify(savedEffects) !== JSON.stringify(getLocalPeer()?.effects)) sendLocalEffects(savedEffects);
  }
  console.log(`[inhabit] left ${nameOf(host)} (${host})`);
}

function onSnapshot(from, data) {
  if (!guestState) return;
  const hostPeer = peerByToken(guestState.host);
  if (!hostPeer || hostPeer.peerId !== from) return;
  const snap = sanitizeHostSnapshot(data);
  guestState.snapshot = snap;
  if (LOCAL_IS_BOT) return;
  setThemeOverride(snap.theme);
  const effects = snap.settings.effects;
  if (effects && JSON.stringify(effects) !== JSON.stringify(getLocalPeer()?.effects)) sendLocalEffects(effects);
  const entry = editors.get(guestState.host);
  if (snap.editorReady && entry && !entry.ready) {
    entry.ready = true;
    if (bound === entry) { setEditorLocked(false); writeEditor(entry); }
  }
  renderPanel();
}

// --- being a host ---------------------------------------------------------------

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && k in obj) out[k] = obj[k];
  return out;
}

function chatMessages() {
  const msgs = jitsiState()?.['features/chat']?.messages;
  return Array.isArray(msgs) ? msgs : [];
}

// The host's private messages, with each outgoing one's recipient looked up
// by name (Jitsi keeps only the name) so a guest can reply to it.
function privateChats() {
  const byName = new Map(getAllPeers().filter((p) => p.jitsiId && p.displayName).map((p) => [p.displayName, p.jitsiId]));
  return chatMessages()
    .map((m) => privateChatEntry(m && m.privateMessage && m.messageType === 'local'
      ? { ...m, recipientId: byName.get(m.recipient) ?? null }
      : m))
    .filter(Boolean)
    .slice(-MAX_CHAT_MESSAGES);
}

async function buildSnapshot() {
  const me = getLocalPeer();
  const devices = LOCAL_IS_BOT ? { audio: [], screens: [] }
    : await getDeviceInventory().catch(() => ({ audio: [], screens: [] }));
  return {
    displayName: me?.displayName || '',
    isBot: LOCAL_IS_BOT,
    theme: LOCAL_IS_BOT ? {} : pick(getTheme(), INHABIT_THEME_KEYS),
    chats: LOCAL_IS_BOT ? [] : privateChats(),
    devices,
    routes: LOCAL_IS_BOT ? [] : getRouteRequests(),
    room: getCurrentRoomName(),
    editorReady: !!editors.get(myToken())?.ready,
    settings: { effects: me?.effects || null },
  };
}

let snapshotTimer = null;
let snapshotForce = false;

function scheduleSnapshot(force = false) {
  if (!hostState) return;
  snapshotForce = snapshotForce || force;
  if (snapshotTimer) return;
  snapshotTimer = setTimeout(async () => {
    snapshotTimer = null;
    const force = snapshotForce;
    snapshotForce = false;
    if (!hostState) return;
    const snap = await buildSnapshot();
    if (!hostState) return;
    const json = JSON.stringify(snap);
    for (const guest of hostState.guests) {
      if (!force && hostState.lastSent.get(guest) === json) continue;
      const peer = peerByToken(guest);
      if (!peer?.peerId) continue;
      hostState.lastSent.set(guest, json);
      sendInhabitRelay(peer.peerId, 'snapshot', snap);
    }
  }, SNAPSHOT_DEBOUNCE_MS);
}

function watchChat() {
  const store = typeof window !== 'undefined' ? window.APP?.store : null;
  if (!store || typeof store.subscribe !== 'function') return () => {};
  let last = chatMessages();
  return store.subscribe(() => {
    const now = chatMessages();
    if (now === last) return;
    last = now;
    scheduleSnapshot();
  });
}

function updateHost(guests) {
  if (!hostState) {
    hostState = {
      guests: new Set(),
      lastSent: new Map(),
      unsubChat: LOCAL_IS_BOT ? () => {} : watchChat(),
      unsubTheme: LOCAL_IS_BOT ? () => {} : subscribeTheme(() => scheduleSnapshot()),
    };
    startOwnDoc();
    console.log(`[inhabit] being inhabited by ${guests.map(nameOf).join(', ')}`);
  }
  const before = [...hostState.guests].join(' ');
  hostState.guests = new Set(guests);
  for (const g of hostState.lastSent.keys()) if (!hostState.guests.has(g)) hostState.lastSent.delete(g);
  if (before !== [...hostState.guests].join(' ')) scheduleSnapshot();
}

function leaveHost() {
  hostState.unsubChat();
  hostState.unsubTheme();
  hostState = null;
  if (bound && bound.host === myToken()) bound = null;
  console.log('[inhabit] no longer inhabited');
}

function conference() {
  if (typeof window === 'undefined') return null;
  try {
    const fromStore = window.APP?.store?.getState?.()['features/base/conference']?.conference;
    if (fromStore) return fromStore;
  } catch (e) { /* fall through */ }
  return window.APP?.conference?._room || null;
}

// A guest's private message, sent from this browser — so it is the host who
// sends it — and added to the host's own chat log the way Jitsi adds one the
// host typed, so the host sees what was said in their name.
function sendChatAsHost(fromIndex, data) {
  const to = typeof data?.to === 'string' ? data.to : null;
  const text = typeof data?.text === 'string' ? data.text.trim().slice(0, MAX_CHAT_TEXT) : '';
  const recipient = to ? getAllPeers().find((p) => p.jitsiId === to) : null;
  if (!recipient || !text) return;
  const conf = conference();
  try {
    conf.sendPrivateTextMessage(to, text);
  } catch (e) {
    console.warn('[inhabit] could not send a private message for a guest', e);
    return;
  }
  try {
    window.APP?.store?.dispatch({
      type: 'ADD_MESSAGE',
      displayName: getLocalPeer()?.displayName || '',
      hasRead: true,
      participantId: getLocalPeer()?.jitsiId,
      messageType: 'local',
      message: text,
      privateMessage: true,
      recipient: recipient.displayName || '',
      timestamp: Date.now(),
      messageId: `inhabit-${fromIndex}-${Date.now()}`,
      isReaction: false,
      lobbyChat: false,
    });
  } catch (e) { /* the message went out; only the host's own log copy failed */ }
  scheduleSnapshot();
}

function onGuestRequest(fromIndex, kind, data) {
  if (!hostState || fromIndex == null || !hostState.guests.has(String(fromIndex))) return;
  const guest = String(fromIndex);
  if (kind === 'join') {
    hostState.lastSent.delete(guest);
    scheduleSnapshot(true);
  } else if (kind === 'chat' && !LOCAL_IS_BOT) {
    sendChatAsHost(guest, data);
  } else if (kind === 'route' && !LOCAL_IS_BOT) {
    if (data && typeof data.key === 'string') decideRoute(data.key, data.decision);
  }
}

// --- the map ------------------------------------------------------------------------

function refresh() {
  const me = myToken();
  if (me == null || LOCAL_IS_AGGREGATOR) return;
  const next = inhabitRole(map, me, presentTokens());
  // The sidecar already drops every pair this participant's permissionsConfig
  // refuses; checking again here covers the moment before it has heard that
  // config, so a refused guest never gets a snapshot or the editor.
  next.hosting = next.hosting.filter(mayInhabitMe);
  if (next.inhabiting !== (guestState?.host ?? null)) {
    if (guestState) leaveGuest();
    if (next.inhabiting) enterGuest(next.inhabiting);
  }
  if (next.hosting.length) updateHost(next.hosting);
  else if (hostState) leaveHost();
  rebind();
  renderPanel();
}

// With no aggregator in the room nobody resolves the map cycle by cycle, so
// the program's map at cycle 0 is reported instead — by one browser, the
// lowest-indexed human, the same one that seeds a default program. The
// sidecar ignores this the moment an aggregator reports.
// What this browser last reported — compared against rather than the map the
// sidecar sends back, which has every pair a host refuses (permissionsConfig)
// taken out and so may never match. Forgotten on reconnect.
let lastReport = null;

function isLowestHuman() {
  const me = getLocalPeer();
  if (!me || me.isBot || me.roomIndex == null) return false;
  const humans = getAllPeers()
    .filter((p) => !p.isBot && !p.isAggregator && p.roomIndex != null && /^\d+$/.test(String(p.roomIndex)))
    .map((p) => parseInt(p.roomIndex, 10));
  return humans.length > 0 && parseInt(me.roomIndex, 10) === Math.min(...humans);
}

function maybeReportStaticMap() {
  if (LOCAL_IS_BOT || LOCAL_IS_AGGREGATOR) return;
  if (getAllPeers().some((p) => p.isAggregator)) return;
  if (!isLowestHuman()) return;
  const text = getProgramText();
  if (!text) return;
  const { ast, valid } = parseMetaprogram(text);
  if (!valid) return;
  const next = resolveInhabitMap(ast.inhabit, 0);
  const json = JSON.stringify(next);
  if (lastReport === json || (lastReport == null && inhabitMapsEqual(map, next))) return;
  lastReport = json;
  sendInhabitMap(next);
}

subscribePeerState((event, payload) => {
  if (event === 'connected') {
    lastReport = null;
  } else if (event === 'inhabit') {
    map = payload?.map || getInhabitMap();
    refresh();
  } else if (event === 'peer-upsert' || event === 'peer-leave') {
    // A bot host's editor IS its running pattern: keep the doc on it.
    if (LOCAL_IS_BOT && hostState && payload === getLocalPeer()) {
      const own = editors.get(myToken());
      if (own?.ready && typeof payload.pattern === 'string') applyTextDiff(own.text, payload.pattern, 'local');
    }
    refresh();
  } else if (event === 'inhabit-relay') {
    if (payload.kind === 'snapshot') onSnapshot(payload.from, payload.data);
    else onGuestRequest(payload.fromIndex, payload.kind, payload.data);
  } else if (event === 'editor-crdt-update') {
    const entry = editors.get(payload.host);
    if (entry) applyRemoteUpdate(entry.doc, payload.update);
  } else if (event === 'editor-crdt-state') {
    const entry = editors.get(payload.host);
    if (!entry) return;
    for (const u of payload.updates) {
      try { applyRemoteUpdate(entry.doc, u); } catch (e) { console.warn('[inhabit] skipped a bad editor update', e); }
    }
    if (payload.host === myToken()) { if (hostState) seedHost(entry); }
    else if (payload.updates.length && !entry.ready) {
      entry.ready = true;
      if (bound === entry) { setEditorLocked(false); writeEditor(entry); }
    }
  }
});

if (typeof document !== 'undefined' && !LOCAL_IS_AGGREGATOR) {
  // A human host's guests run its editor with a remote-control 'pattern' —
  // the only way the sidecar lets one reach a human — so here it plays as
  // if the host had pressed Play (studio.js).
  document.addEventListener('trussal-remote-pattern', (e) => {
    if (LOCAL_IS_BOT || !hostState) return;
    const code = e.detail?.code;
    if (typeof code === 'string') document.dispatchEvent(new CustomEvent('trussal-inhabit-run', { detail: { code } }));
  });
  document.addEventListener('trussal-jpattern-program', () => maybeReportStaticMap());
  document.addEventListener('trussal-out-routes', () => scheduleSnapshot());
  if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => scheduleSnapshot());
  }
  setInterval(() => {
    maybeReportStaticMap();
    // The studio may have rebuilt the editor since: refresh fills the new one.
    refresh();
    if (hostState) scheduleSnapshot();
  }, TICK_MS);
}

// --- the panel ----------------------------------------------------------------------

const PANEL_ID = 'trussal-inhabit';
let collapsed = false;
let composeTo = '';
let lastRender = null; // what the panel last showed — refresh runs often, so only a change re-renders

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

function section(title, ...children) {
  return h('section', { class: 'inhabit-section' }, h('h3', { text: title }), ...children);
}

function guestPanel() {
  const { host, snapshot } = guestState;
  const hostPeer = peerByToken(host);
  const who = snapshot?.displayName || nameOf(host);
  const parts = [];
  parts.push(h('p', {
    class: 'inhabit-lede',
    text: `You are inhabiting ${who} (${host})${hostPeer?.isBot ? ', a bot' : ''}. You see what they see and act as them until the metaprogram lets you go.`,
  }));
  parts.push(section('Editor', h('p', {
    text: `Your editor is now ${who}'s. Everyone inside them types into it together; Play runs it as ${who}'s program. Your own editor comes back when you leave.`,
  })));
  const perms = [
    hostPeer?.canEditMetaprogram === false ? 'may not edit the metaprogram' : 'may edit the metaprogram',
    hostPeer?.canWriteModulation === false ? 'may not change network modulation' : 'may change network modulation',
  ];
  parts.push(section('Place and permissions', h('p', {
    text: `You take ${who}'s turn on the ring and are in ${snapshot?.room ? `the breakout room "${snapshot.room}"` : 'the main room'} with them. As ${who}, you ${perms.join(' and ')}.`,
  })));
  if (!snapshot) {
    parts.push(h('p', { class: 'inhabit-muted', text: `Waiting for ${who}'s browser…` }));
    return parts;
  }
  const devices = [...snapshot.devices.audio.map((l) => `speaker: ${l}`), ...snapshot.devices.screens.map((l) => `monitor: ${l}`)];
  parts.push(section('Devices',
    devices.length
      ? h('ul', {}, ...devices.map((d) => h('li', { text: d })))
      : h('p', { class: 'inhabit-muted', text: 'No named devices.' }),
    ...snapshot.routes.map((r) => h('div', { class: 'inhabit-route' },
      h('span', { text: `${r.author} → "${r.label}" (${r.media.join(', ') || r.kind})${r.decision ? ` — ${r.decision === 'allow' ? 'allowed' : 'denied'}` : ''}` }),
      r.decision === 'deny' ? null : h('button', { type: 'button', text: 'Deny', onclick: () => sendGuestRequest('route', { key: r.key, decision: 'deny' }) }),
      r.decision ? null : h('button', { type: 'button', class: 'inhabit-primary', text: 'Allow', onclick: () => sendGuestRequest('route', { key: r.key, decision: 'allow' }) }),
    )),
  ));
  parts.push(section('Private chats', chatList(snapshot.chats, who), composeBox(snapshot.chats, host)));
  return parts;
}

function chatList(chats, who) {
  if (!chats.length) return h('p', { class: 'inhabit-muted', text: `${who} has no private messages yet.` });
  return h('ol', { class: 'inhabit-chats' }, ...chats.map((m) => h('li', { class: m.outgoing ? 'out' : 'in' },
    h('span', { class: 'inhabit-chat-who', text: m.outgoing ? `${who} → ${m.peerName || 'someone'}${m.viaGuest ? ` (via ${nameOf(m.viaGuest)})` : ''}` : `${m.peerName || 'someone'} → ${who}` }),
    h('span', { class: 'inhabit-chat-text', text: m.text }),
  )));
}

// A private message from the host: to anyone in the meeting but the host.
function composeBox(chats, host) {
  const hostPeer = peerByToken(host);
  const recipients = getAllPeers().filter((p) => p.jitsiId && p !== hostPeer && !p.isAggregator && p.jitsiId !== getLocalPeer()?.jitsiId);
  if (!recipients.length) return null;
  const last = [...chats].reverse().find((m) => m.peerId);
  if (!recipients.some((p) => p.jitsiId === composeTo)) composeTo = last?.peerId || recipients[0].jitsiId;
  const select = h('select', { 'aria-label': 'Send a private message to' },
    ...recipients.map((p) => {
      const o = h('option', { value: p.jitsiId, text: p.displayName || `Participant ${p.roomIndex}` });
      if (p.jitsiId === composeTo) o.selected = true;
      return o;
    }));
  select.addEventListener('change', () => { composeTo = select.value; });
  const input = h('input', { type: 'text', maxlength: String(MAX_CHAT_TEXT), 'aria-label': 'Private message' });
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    sendGuestRequest('chat', { to: select.value, text });
    input.value = '';
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
  return h('div', { class: 'inhabit-compose' }, select, input, h('button', { type: 'button', class: 'inhabit-primary', text: 'Send', onclick: send }));
}

function sendGuestRequest(kind, data) {
  const peer = guestState && peerByToken(guestState.host);
  if (peer?.peerId) sendInhabitRelay(peer.peerId, kind, data);
}

function hostPanel() {
  const names = [...hostState.guests].map((g) => `${nameOf(g)} (${g})`).join(', ');
  return [h('p', {
    class: 'inhabit-lede',
    text: `${names} ${hostState.guests.size === 1 ? 'is' : 'are'} inhabiting you. They type into your editor and can play it, read and send your private messages, see your theme and device names, answer routing requests for your devices, and take your turn on the ring with you.`,
  })];
}

function renderPanel() {
  if (typeof document === 'undefined' || !document.body || LOCAL_IS_BOT || LOCAL_IS_AGGREGATOR) return;
  let panel = document.getElementById(PANEL_ID);
  if (!guestState && !hostState) { if (panel) panel.remove(); lastRender = null; return; }
  const hostPeer = guestState ? peerByToken(guestState.host) : null;
  const sig = JSON.stringify([
    collapsed, guestState?.host, guestState?.snapshot, hostPeer?.canEditMetaprogram, hostPeer?.canWriteModulation,
    hostState && [...hostState.guests].map(nameOf),
    getAllPeers().map((p) => [p.jitsiId, p.displayName, p.roomIndex]),
  ]);
  if (panel && sig === lastRender) return;
  // Leave a half-typed message alone: re-rendering would take its text.
  if (panel && panel.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  if (!panel) {
    panel = h('div', { id: PANEL_ID, role: 'region', 'aria-label': 'Inhabiting' });
    document.body.appendChild(panel);
  }
  const title = guestState ? `Inhabiting ${guestState.snapshot?.displayName || nameOf(guestState.host)}` : 'You are inhabited';
  const toggle = h('button', {
    type: 'button', class: 'inhabit-toggle', 'aria-expanded': String(!collapsed),
    text: collapsed ? 'Show' : 'Hide',
    onclick: () => { collapsed = !collapsed; renderPanel(); },
  });
  const body = h('div', { class: 'inhabit-body' }, ...(collapsed ? [] : [
    ...(guestState ? guestPanel() : []),
    ...(hostState ? hostPanel() : []),
  ]));
  panel.replaceChildren(h('header', {}, h('h2', { text: title }), toggle), body);
  lastRender = sig;
}

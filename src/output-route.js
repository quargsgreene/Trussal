// `.out("device")` — the browser half. Every browser reads every playing
// performer's routes (and the Metaprogram's `# out` lines), asks whether one
// of ITS OWN devices answers to the name, and — only once its user has allowed
// that author to reach that device — streams the Aggregator's output there:
//
//   audio  → an output device (setSinkId), optionally onto 1-based channels.
//            Two channels take the stream's left/right; one or 3+ take a mono
//            fold of it on each.
//   video  → a window placed on the named monitor (Window Management API),
//            playing the Aggregator's video track.
//   text   → the same window, with that author's painted words mirrored in.
//   css    → the same window, restyled by that author's CSS Cycles sheet.
//
// What is streamed is what the Aggregator streams: its published audio/video
// tracks, gated by the author's turn on the ring (a voice routes while its
// performer is the one being streamed). A Metaprogram route is the whole
// Aggregator output, ungated. With no Aggregator in the room the page's own
// output is used instead (the Strudel master, the Hydra canvas), so a route
// still works in a solo session. The Aggregator mixes a performer's voices of
// one medium into one track, so two voices of one author routed to the same
// device share a stream — the voice names label the request.
//
// Nothing happens to a device without its owner's say-so: each new
// (author, device) pair raises an in-page prompt (never a browser dialog,
// which would block the meeting's event loop), and a Deny holds for the rest
// of the session. A monitor needs one more thing — a click — because opening
// a window on it is only allowed from a user gesture; the Allow click is that
// gesture.

import { getAllPeers, getPeerByJitsiId, subscribePeerState } from './peer-state.js';
import { getAggregatorPeer, getStrudelAudioContext } from './latency-instrument.js';
import { getGateLevel, getProgramChain } from './audio-net/Metaprogrammer.js';
import { resolveMedia } from './audio-net/EffectMedia.js';
import { remoteAudioStream, remoteVideoEl } from './live-capture.js';
import { peerTextClass } from './text-cycles-core.js';
import { peerOutRoutes } from './hydra-code.js';
import { readDirective } from './program-directive.js';
import {
  deviceKindFor, matchOutputDevice, matchScreen, channelMap, permissionKey,
  permissionPrompt, metaprogramRoutes,
} from './output-route-core.js';

const METAPROGRAM = 'metaprogram';
const TICK_MS = 100;
const RECONCILE_MS = 2000;
const TEXT_LINES = 12;

let peerRoutes = new Map();   // author jitsiId → { name, routes }
let metaRoutes = [];          // routes from the Metaprogram's `# out` lines
const decisions = new Map();  // permissionKey → 'allow' | 'deny'
const prompts = new Map();    // permissionKey → card element
const promptRoutes = new Map(); // permissionKey → the wanted route its card asks about
// Keys whose output window the owner closed themselves: not re-asked until
// the route goes away and comes back, so closing a window is a way to say no.
const dismissed = new Set();
const audioSinks = new Map(); // permissionKey → audio sink
const screenSinks = new Map();// permissionKey → screen sink
let screenDetails = null;     // ScreenDetails once window management is granted
let reconciling = null;
let rerun = false;
let ticker = null;
let localTap = null;          // { stream, node, out } — the Strudel master tap

const isLocalAuthor = (author) => {
  const me = getAllPeers().find((p) => p.isLocal);
  return !!me && me.jitsiId === author;
};

function authorName(author) {
  if (author === METAPROGRAM) return 'The Metaprogram';
  return getPeerByJitsiId(author)?.displayName || 'A participant';
}

// --- inputs -----------------------------------------------------------------

// Read straight from peer state rather than from strudel.js's rebuild: the
// owner of a device needs to hear about a route whether or not they have
// pressed Play themselves. A route lives while its author is playing, the
// same as everything else they send. Bots have no peripherals of their own to
// reach for and their output already reaches the room through the Aggregator
// like everyone's, so a bot's code routes nothing.
const routeCache = new Map(); // pattern text → routes
function routesOf(pattern) {
  let r = routeCache.get(pattern);
  if (!r) {
    r = peerOutRoutes(pattern);
    if (routeCache.size > 64) routeCache.clear();
    routeCache.set(pattern, r);
  }
  return r;
}

function refreshPeerRoutes() {
  const next = new Map();
  for (const peer of getAllPeers()) {
    if (!peer.jitsiId || peer.isBot || peer.isAggregator || !peer.playing) continue;
    if (typeof peer.pattern !== 'string' || !peer.pattern.includes('.out')) continue;
    if (readDirective(peer.pattern).kind !== 'personal') continue;
    const routes = routesOf(peer.pattern);
    if (routes.length) next.set(peer.jitsiId, { routes });
  }
  const sig = (m) => JSON.stringify([...m].map(([k, v]) => [k, v.routes]));
  if (sig(next) === sig(peerRoutes)) return;
  peerRoutes = next;
  scheduleReconcile();
}

function refreshMetaRoutes(chain) {
  metaRoutes = metaprogramRoutes(chain, (media) => resolveMedia(media, 0));
  scheduleReconcile();
}

if (typeof document !== 'undefined') {
  document.addEventListener('trussal-metaprogram-chain', (e) => refreshMetaRoutes(e.detail && e.detail.chain));
  document.addEventListener('trussal-text-painted', onTextPainted);
  subscribePeerState((event) => {
    if (event === 'peer-upsert' || event === 'peer-leave') refreshPeerRoutes();
  });
  try { refreshMetaRoutes(getProgramChain()); } catch (e) { /* no program yet */ }
  if (typeof navigator !== 'undefined' && navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', () => scheduleReconcile());
  }
  setInterval(() => { if (peerRoutes.size || metaRoutes.length || audioSinks.size || screenSinks.size) scheduleReconcile(); }, RECONCILE_MS);
}

// --- local devices ------------------------------------------------------------

async function audioOutputs() {
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    return all.filter((d) => d.kind === 'audiooutput');
  } catch (e) {
    return [];
  }
}

async function windowManagementState() {
  if (typeof window === 'undefined' || typeof window.getScreenDetails !== 'function') return 'unsupported';
  for (const name of ['window-management', 'window-placement']) {
    try { return (await navigator.permissions.query({ name })).state; } catch (e) { /* try the older name */ }
  }
  return 'prompt';
}

// Screens without prompting: only once the browser permission already stands.
async function knownScreens() {
  if (screenDetails) return screenDetails.screens;
  if (await windowManagementState() !== 'granted') return null;
  try { screenDetails = await window.getScreenDetails(); } catch (e) { return null; }
  screenDetails.addEventListener?.('screenschange', () => scheduleReconcile());
  return screenDetails.screens;
}

// --- reconcile ------------------------------------------------------------------

function allRoutes() {
  const out = [];
  for (const [author, { routes }] of peerRoutes) for (const r of routes) out.push({ ...r, author });
  for (const r of metaRoutes) out.push({ ...r, author: METAPROGRAM });
  return out;
}

function scheduleReconcile() {
  if (reconciling) { rerun = true; return; }
  reconciling = reconcile()
    .catch((e) => console.warn('[out] reconcile failed', e))
    .finally(() => {
      reconciling = null;
      if (rerun) { rerun = false; scheduleReconcile(); }
    });
}

// One request per (author, device): every medium and voice that author sends
// to that device, gathered so the owner is asked once.
async function reconcile() {
  const routes = allRoutes();
  const wanted = new Map();
  const needAudio = routes.some((r) => deviceKindFor(r.medium) === 'audiooutput');
  const needScreen = routes.some((r) => deviceKindFor(r.medium) === 'screen');
  const outs = needAudio ? await audioOutputs() : [];
  const screens = needScreen ? await knownScreens() : null;
  // Without window-management permission the labels are unknowable, so a
  // multi-screen machine is asked to look the name up; a single-screen one
  // cannot be the owner of a second monitor and stays out of it.
  const canLookUp = !screens && needScreen && typeof window !== 'undefined'
    && window.screen && window.screen.isExtended && typeof window.getScreenDetails === 'function';

  for (const r of routes) {
    const kind = deviceKindFor(r.medium);
    let device = null;
    let deviceId = null;
    let label = r.target;
    if (kind === 'audiooutput') {
      device = matchOutputDevice(outs, r.target);
      if (!device) continue;
      deviceId = device.deviceId;
      label = device.label || r.target;
    } else if (screens) {
      device = matchScreen(screens, r.target);
      if (!device) continue;
      deviceId = `screen:${device.label || r.target}`;
      label = device.label || r.target;
    } else if (canLookUp) {
      deviceId = `screen:?${r.target.toLowerCase()}`;
    } else {
      continue;
    }
    const key = permissionKey({ author: r.author, deviceId });
    let w = wanted.get(key);
    if (!w) {
      w = { key, author: r.author, kind, device, deviceId, label, target: r.target, media: new Set(), voices: new Set(), channels: null };
      wanted.set(key, w);
    }
    w.media.add(r.medium);
    w.voices.add(r.voice);
    if (r.channels) w.channels = [...new Set([...(w.channels || []), ...r.channels])].sort((a, b) => a - b);
  }

  for (const w of wanted.values()) {
    const decision = decisions.get(w.key);
    if (decision === 'deny') continue;
    if (w.kind === 'audiooutput') {
      if (decision === 'allow' || isLocalAuthor(w.author)) {
        decisions.set(w.key, 'allow');
        await ensureAudioSink(w);
      } else {
        showPrompt(w);
      }
    } else {
      const sink = screenSinks.get(w.key);
      if (sink && !sink.win.closed) { sink.media = w.media; continue; }
      if (dismissed.has(w.key)) continue;
      // A window can only be opened from a click, so even an allowed or
      // self-authored route asks — the button is the gesture.
      showPrompt(w);
    }
  }

  for (const [key, sink] of audioSinks) if (!wanted.has(key)) { teardownAudio(sink); audioSinks.delete(key); }
  for (const [key, sink] of screenSinks) {
    if (!wanted.has(key) || sink.win.closed) { teardownScreen(sink); screenSinks.delete(key); }
  }
  for (const [key, card] of prompts) if (!wanted.has(key)) { card.remove(); prompts.delete(key); promptRoutes.delete(key); notifyRoutes(); }
  for (const key of dismissed) if (!wanted.has(key)) dismissed.delete(key);
  ensureTicker();
}

// --- the prompt -------------------------------------------------------------------

function promptHost() {
  let host = document.getElementById('trussal-out-prompts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'trussal-out-prompts';
    host.setAttribute('role', 'region');
    host.setAttribute('aria-label', 'Output routing requests');
    document.body.appendChild(host);
  }
  return host;
}

function showPrompt(w) {
  if (prompts.has(w.key)) return;
  promptRoutes.set(w.key, w);
  const self = isLocalAuthor(w.author);
  const allowed = decisions.get(w.key) === 'allow';
  const card = document.createElement('div');
  card.className = 'out-prompt';
  card.setAttribute('role', 'alertdialog');
  const msg = document.createElement('p');
  const media = [...w.media].sort().join(', ');
  const where = w.device ? w.label : w.target;
  if (self) {
    msg.textContent = `Open your ${media} route on "${where}"?`;
  } else {
    msg.textContent = permissionPrompt({
      authorName: authorName(w.author), voices: [...w.voices], medium: media, deviceLabel: where, channels: w.channels,
    }) + (w.device ? '' : ' If a monitor by that name is attached to this computer, Allow looks it up.');
  }
  const row = document.createElement('div');
  row.className = 'out-prompt-actions';
  const allow = document.createElement('button');
  allow.type = 'button';
  allow.className = 'out-prompt-allow';
  allow.textContent = self || allowed ? 'Open' : 'Allow';
  const deny = document.createElement('button');
  deny.type = 'button';
  deny.className = 'out-prompt-deny';
  deny.textContent = self ? 'Dismiss' : 'Deny';
  row.append(allow, deny);
  card.append(msg, row);
  promptHost().appendChild(card);
  prompts.set(w.key, card);
  notifyRoutes();

  const close = () => { card.remove(); prompts.delete(w.key); promptRoutes.delete(w.key); notifyRoutes(); };
  deny.addEventListener('click', () => {
    decisions.set(w.key, 'deny');
    close();
    console.log(`[out] denied ${authorName(w.author)} → "${w.label}" for this session`);
  });
  allow.addEventListener('click', () => {
    decisions.set(w.key, 'allow');
    close();
    if (w.kind === 'audiooutput') {
      ensureAudioSink(w).catch((e) => console.warn('[out] audio route failed', e));
    } else {
      openScreenSink(w).catch((e) => console.warn('[out] screen route failed', e));
    }
  });
}

// --- what this browser's devices are, for whoever inhabits it -------------------
//
// A guest inhabiting this participant (inhabit.js) sees this computer's
// device names and the routing requests waiting on them, and may answer a
// request in the owner's place. Labels only — never a deviceId.

function notifyRoutes() {
  if (typeof document !== 'undefined') document.dispatchEvent(new CustomEvent('trussal-out-routes'));
}

export async function getDeviceInventory() {
  const audio = (await audioOutputs()).map((d) => d.label).filter(Boolean);
  // Only screens this page may already name: asking for window management
  // here would raise a browser permission prompt on the owner's behalf.
  const screens = (screenDetails?.screens || []).map((sc) => sc.label).filter(Boolean);
  return { audio, screens };
}

// The routing requests waiting on an answer, and those already answered.
export function getRouteRequests() {
  const out = [];
  const seen = new Set();
  for (const [key, w] of promptRoutes) {
    seen.add(key);
    out.push({
      key, author: authorName(w.author), label: w.device ? w.label : w.target,
      kind: w.kind, media: [...w.media].sort(), decision: decisions.get(key) || null,
    });
  }
  for (const [key, sink] of audioSinks) {
    if (seen.has(key)) continue;
    out.push({ key, author: authorName(sink.author), label: sink.label, kind: 'audiooutput', media: ['audio'], decision: 'allow' });
  }
  return out;
}

// Answer a routing request as if its card's button had been pressed. An
// allowed monitor still needs a click here — a window can only be opened
// from a gesture on this computer — so its card stays up, now saying Open.
export function decideRoute(key, decision) {
  if (decision !== 'allow' && decision !== 'deny') return false;
  const w = promptRoutes.get(key);
  const card = prompts.get(key);
  if (!w && !audioSinks.has(key)) return false;
  decisions.set(key, decision);
  if (decision === 'deny') {
    if (card) { card.remove(); prompts.delete(key); promptRoutes.delete(key); }
    const sink = audioSinks.get(key);
    if (sink) { teardownAudio(sink); audioSinks.delete(key); }
    console.log(`[out] denied → "${w ? w.label : key}" for this session (by someone inhabiting you)`);
  } else if (w && w.kind === 'audiooutput') {
    if (card) { card.remove(); prompts.delete(key); promptRoutes.delete(key); }
    ensureAudioSink(w).catch((e) => console.warn('[out] audio route failed', e));
  } else if (card) {
    const allow = card.querySelector('.out-prompt-allow');
    if (allow) allow.textContent = 'Open';
  }
  notifyRoutes();
  return true;
}

// --- sources -----------------------------------------------------------------------

async function sourceAudioStream() {
  const agg = getAggregatorPeer();
  if (agg) return remoteAudioStream(agg);
  if (!localTap) {
    const { audioCtx, destinationNode } = await getStrudelAudioContext();
    const out = audioCtx.createMediaStreamDestination();
    destinationNode.connect(out);
    localTap = { stream: out.stream, node: destinationNode, out };
  }
  return localTap.stream;
}

function sourceVideoStream() {
  const agg = getAggregatorPeer();
  if (agg) {
    const el = remoteVideoEl(agg);
    return el && el.srcObject ? el.srcObject : null;
  }
  const canvas = document.getElementById('hydra-canvas');
  if (!canvas || typeof canvas.captureStream !== 'function') return null;
  if (!canvas._trussalOutStream) canvas._trussalOutStream = canvas.captureStream(30);
  return canvas._trussalOutStream;
}

const gateFor = (author) => (author === METAPROGRAM ? 1 : getGateLevel(author));

// --- audio sink ------------------------------------------------------------------------

async function ensureAudioSink(w) {
  const existing = audioSinks.get(w.key);
  const chKey = (w.channels || []).join(',');
  if (existing && existing.chKey === chKey && existing.stream && existing.stream.active) return;
  if (existing) { teardownAudio(existing); audioSinks.delete(w.key); }
  const stream = await sourceAudioStream();
  if (!stream) return; // the Aggregator's audio has not arrived — the next reconcile retries
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor || !('setSinkId' in Ctor.prototype)) {
    console.warn('[out] this browser cannot choose an audio output device — route skipped');
    return;
  }
  const ctx = new Ctor({ latencyHint: 'interactive' });
  try {
    await ctx.setSinkId(w.deviceId);
  } catch (e) {
    console.warn(`[out] could not open "${w.label}"`, e);
    ctx.close().catch(() => {});
    return;
  }
  const src = ctx.createMediaStreamSource(stream);
  const gate = ctx.createGain();
  gate.gain.value = gateFor(w.author);
  src.connect(gate);
  const dest = ctx.destination;
  const map = channelMap(w.channels, dest.maxChannelCount);
  if (map) {
    const width = Math.max(...map) + 1;
    dest.channelCount = Math.max(width, Math.min(dest.maxChannelCount, 2));
    dest.channelCountMode = 'explicit';
    dest.channelInterpretation = 'discrete';
    const merger = ctx.createChannelMerger(dest.channelCount);
    if (map.length === 2) {
      const split = ctx.createChannelSplitter(2);
      gate.connect(split);
      split.connect(merger, 0, map[0]);
      split.connect(merger, 1, map[1]);
    } else {
      const mono = ctx.createGain();
      mono.channelCount = 1;
      mono.channelCountMode = 'explicit';
      mono.channelInterpretation = 'speakers';
      gate.connect(mono);
      for (const ch of map) mono.connect(merger, 0, ch);
    }
    merger.connect(dest);
  } else {
    gate.connect(dest);
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  audioSinks.set(w.key, { key: w.key, author: w.author, label: w.label, ctx, gate, stream, chKey });
  console.log(`[out] audio of ${authorName(w.author)} → "${w.label}"${map ? ` channels ${w.channels.join(', ')}` : ''}`);
}

function teardownAudio(sink) {
  try { sink.ctx.close(); } catch (e) { /* already closed */ }
  console.log(`[out] audio route of ${authorName(sink.author)} closed`);
}

// --- screen sink ------------------------------------------------------------------------

async function openScreenSink(w) {
  // Window placement has to happen inside this click: getScreenDetails() may
  // prompt, window.open needs the activation, and a popup opened after an
  // await that outlived it is blocked.
  const s0 = w.device;
  const features = s0
    ? `popup,left=${s0.availLeft},top=${s0.availTop},width=${s0.availWidth},height=${s0.availHeight}`
    : 'popup,width=640,height=360';
  const pending = window.open('', `trussal-out-${w.key.replace(/[^\w]+/g, '_')}`, features);
  if (!pending) {
    console.warn('[out] the browser blocked the output window — allow popups for this site and try again');
    decisions.delete(w.key);
    return;
  }
  let screen = w.device;
  if (!screen) {
    try {
      screenDetails = screenDetails || await window.getScreenDetails();
      screen = matchScreen(screenDetails.screens, w.target);
    } catch (e) {
      console.warn('[out] screen lookup refused', e);
    }
    if (!screen) {
      pending.close();
      console.warn(`[out] no monitor here matches "${w.target}" — screens: ${(screenDetails?.screens || []).map((s) => s.label).join(', ') || '(none)'}`);
      return;
    }
    scheduleReconcile(); // the key now resolves to the real label
  }
  try {
    pending.moveTo(screen.availLeft, screen.availTop);
    pending.resizeTo(screen.availWidth, screen.availHeight);
  } catch (e) { /* placement is best-effort */ }
  const key = screen === w.device ? w.key : permissionKey({ author: w.author, deviceId: `screen:${screen.label || w.target}` });
  decisions.set(key, 'allow');
  const prev = screenSinks.get(key);
  if (prev && prev.win !== pending) teardownScreen(prev);
  screenSinks.set(key, buildScreenWindow(pending, { key, author: w.author, media: w.media, label: screen.label || w.target }));
  ensureTicker();
  console.log(`[out] ${[...w.media].join('/')} of ${authorName(w.author)} → "${screen.label || w.target}"`);
}

function buildScreenWindow(win, { key, author, media, label }) {
  const doc = win.document;
  doc.title = `Trussal → ${label}`;
  doc.body.replaceChildren();
  doc.body.className = 'trussal-out-window';
  const base = doc.createElement('style');
  base.textContent = 'html,body{margin:0;height:100%;background:#000;color:#eee;overflow:hidden;font-family:monospace}'
    + 'video{position:fixed;inset:0;width:100%;height:100%;object-fit:contain;transition:opacity .1s}'
    + '#out-text{position:fixed;left:2vw;right:2vw;bottom:2vh;font-size:3vh;line-height:1.4;display:flex;flex-direction:column;gap:.3em;text-shadow:0 1px 4px #000}';
  const sheet = doc.createElement('style');
  sheet.id = 'out-css';
  const video = doc.createElement('video');
  video.autoplay = true;
  video.muted = true;
  video.playsInline = true;
  const text = doc.createElement('div');
  text.id = 'out-text';
  text.className = author === METAPROGRAM ? '' : peerTextClass(author);
  doc.head.append(base, sheet);
  doc.body.append(video, text);
  // Fullscreen needs a gesture inside the window itself.
  doc.addEventListener('click', () => { doc.documentElement.requestFullscreen?.().catch(() => {}); });
  return { key, author, media, label, win, video, text, sheet, lastCss: null, lastVars: null };
}

function teardownScreen(sink) {
  try { if (!sink.win.closed) sink.win.close(); } catch (e) { /* gone */ }
  console.log(`[out] screen route of ${authorName(sink.author)} → "${sink.label}" closed`);
}

function onTextPainted(e) {
  const d = e.detail || {};
  if (!d.text) return;
  for (const sink of screenSinks.values()) {
    if (!sink.media.has('text') || sink.win.closed) continue;
    if (sink.author !== METAPROGRAM && sink.author !== d.peerId) continue;
    const line = sink.win.document.createElement('div');
    line.className = d.peerClass || '';
    line.textContent = d.text;
    sink.text.appendChild(line);
    while (sink.text.childNodes.length > TEXT_LINES) sink.text.removeChild(sink.text.firstChild);
  }
}

// The author's installed CSS Cycles sheet(s), and the custom properties those
// rules read, which CSS Cycles sets on this page's root.
function cssFor(author) {
  const els = [...document.querySelectorAll('style[data-cc-peer]')]
    .filter((el) => author === METAPROGRAM || el.dataset.ccPeer === author);
  return els.map((el) => el.textContent).join('\n');
}

function rootVars() {
  const st = document.documentElement.style;
  let out = '';
  for (let i = 0; i < st.length; i++) {
    const p = st[i];
    if (p.startsWith('--')) out += `${p}:${st.getPropertyValue(p)};`;
  }
  return out;
}

// --- the gate tick ------------------------------------------------------------------------

function ensureTicker() {
  if (ticker || (!audioSinks.size && !screenSinks.size)) return;
  ticker = setInterval(tick, TICK_MS);
}

function tick() {
  if (!audioSinks.size && !screenSinks.size) { clearInterval(ticker); ticker = null; releaseLocalTap(); return; }
  for (const sink of audioSinks.values()) {
    if (sink.ctx.state === 'suspended') sink.ctx.resume().catch(() => {});
    const g = gateFor(sink.author);
    if (sink.gate.gain.value !== g) sink.gate.gain.setTargetAtTime(g, sink.ctx.currentTime, 0.01);
  }
  const vars = rootVars();
  for (const [key, sink] of screenSinks) {
    if (sink.win.closed) {
      screenSinks.delete(key);
      dismissed.add(key);
      console.log(`[out] window on "${sink.label}" closed — not asking again until the route is re-added`);
      continue;
    }
    if (sink.media.has('video')) {
      const stream = sourceVideoStream();
      if (stream && sink.video.srcObject !== stream) sink.video.srcObject = stream;
      sink.video.style.opacity = gateFor(sink.author) > 0 ? '1' : '0';
    } else if (sink.video.srcObject) {
      sink.video.srcObject = null;
    }
    sink.text.style.display = sink.media.has('text') && gateFor(sink.author) > 0 ? '' : 'none';
    if (sink.media.has('css')) {
      const css = cssFor(sink.author);
      if (css !== sink.lastCss) { sink.lastCss = css; sink.sheet.textContent = css; }
      if (vars !== sink.lastVars) { sink.lastVars = vars; sink.win.document.documentElement.style.cssText = vars; }
    } else if (sink.lastCss) {
      sink.lastCss = null;
      sink.sheet.textContent = '';
    }
  }
}

function releaseLocalTap() {
  if (!localTap) return;
  try { localTap.node.disconnect(localTap.out); } catch (e) { /* already gone */ }
  localTap = null;
}


// Personal editor languages — the browser half (editor-languages-core.js is
// the pure half). Owns the selected language, each language's own draft, the
// connection to scripts/live-bridge.mjs, and the in-page Punctual engine.
//
// studio.js asks `runs` of the selected language and either keeps its
// JPattern path ('room') or hands the buffer to evalLanguage/stopLanguage
// here. Nothing here ever reaches peer-state: a 'page' or 'bridge' language
// is heard by the room only through the performer's own audio.

import { DEFAULT_LANGUAGE, DEFAULT_BRIDGE_URL, getLanguage, isLanguage } from './editor-languages-core.js';

const LANGUAGE_KEY = 'trussal.studio.language';
const DRAFT_KEY_PREFIX = 'trussal.studio.pattern.';
const BRIDGE_URL_KEY = 'trussal.studio.bridge.url';
const BRIDGE_TOKEN_KEY = 'trussal.studio.bridge.token';

function readStore(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function writeStore(key, value) {
  try { localStorage.setItem(key, value); } catch { /* private mode: drafts just do not persist */ }
}

export function getSelectedLanguage() {
  const saved = readStore(LANGUAGE_KEY);
  return isLanguage(saved) ? saved : DEFAULT_LANGUAGE;
}

export function setSelectedLanguage(id) {
  writeStore(LANGUAGE_KEY, isLanguage(id) ? id : DEFAULT_LANGUAGE);
}

// JPattern's draft keeps the key it always had (studio.js's STORAGE_KEY) and
// is not handled here; every other language has its own, starting from the
// language's starter.
export function loadDraft(id) {
  const saved = readStore(DRAFT_KEY_PREFIX + id);
  return saved != null ? saved : (getLanguage(id).starter || '');
}

export function saveDraft(id, code) {
  writeStore(DRAFT_KEY_PREFIX + id, code);
}

export function getBridgeSettings() {
  return {
    url: readStore(BRIDGE_URL_KEY) || DEFAULT_BRIDGE_URL,
    token: readStore(BRIDGE_TOKEN_KEY) || '',
  };
}

export function setBridgeSettings({ url, token }) {
  if (typeof url === 'string') writeStore(BRIDGE_URL_KEY, url.trim() || DEFAULT_BRIDGE_URL);
  if (typeof token === 'string') {
    writeStore(BRIDGE_TOKEN_KEY, token.trim());
    // A new token has to be presented on a fresh connection.
    closeBridge();
  }
}

// ── live bridge client ──────────────────────────────────────────────────────

let bridge = null;      // { ws, ready: Promise<void> }
let bridgeListener = null;
const lastSent = new Map(); // language → last buffer sent (Sonic Pi's Stop names its loops)

// Interpreter output and errors arrive unprompted; the studio shows them in
// its status line.
export function onBridgeMessage(fn) {
  bridgeListener = fn;
}

function closeBridge() {
  if (bridge) { try { bridge.ws.close(); } catch { /* already closed */ } }
  bridge = null;
}

function connectBridge() {
  if (bridge && bridge.ws.readyState <= WebSocket.OPEN) return bridge.ready;
  const { url, token } = getBridgeSettings();
  if (!token) return Promise.reject(new Error('Start scripts/live-bridge.mjs and paste its token into the bridge field'));
  const ws = new WebSocket(url);
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'hello', token })));
    ws.addEventListener('message', (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.type === 'ready') { resolve(); return; }
      if (msg.type === 'denied') { reject(new Error('The bridge refused the token — paste the one it printed')); return; }
      if (bridgeListener) bridgeListener(msg);
    });
    ws.addEventListener('error', () => reject(new Error(`No live bridge at ${url} — run: node scripts/live-bridge.mjs`)));
    ws.addEventListener('close', () => {
      reject(new Error('The live bridge closed the connection'));
      if (bridge && bridge.ws === ws) bridge = null;
    });
  });
  bridge = { ws, ready };
  // A failed attempt is not cached: the next Play tries again.
  ready.catch(() => { if (bridge && bridge.ws === ws) bridge = null; });
  return ready;
}

async function sendToBridge(msg) {
  await connectBridge();
  bridge.ws.send(JSON.stringify(msg));
}

// ── Punctual (in-page) ──────────────────────────────────────────────────────

// Punctual is published as an ES module on its own site (CORS-open); loaded
// on first use so nobody who never picks it pays for its ~550 KB.
const PUNCTUAL_URL = 'https://dktr0.github.io/Punctual/punctual.js';
let punctual = null;

async function ensurePunctual() {
  if (punctual) return punctual;
  const P = await import(/* @vite-ignore */ PUNCTUAL_URL);
  punctual = new P.Punctual();
  punctual.startAnimation();
  return punctual;
}

// ── eval / stop ─────────────────────────────────────────────────────────────

// Resolves to the status line to show; rejects with a message worth showing.
export async function evalLanguage(id, code) {
  const lang = getLanguage(id);
  switch (lang.runs) {
    case 'none':
      return 'Text mode — nothing to evaluate';
    case 'page': {
      const p = await ensurePunctual();
      await p.define({ zone: 0, text: code, time: Date.now() / 1000 });
      return `${lang.label} running`;
    }
    case 'bridge':
      lastSent.set(id, code);
      await sendToBridge({ type: 'eval', language: id, code });
      return `${lang.label}: sent to the live bridge`;
    default:
      throw new Error(`${lang.label} is played through the room, not here`);
  }
}

export async function stopLanguage(id) {
  const lang = getLanguage(id);
  if (lang.runs === 'page') {
    if (punctual) punctual.clear({ zone: 0 });
    return `${lang.label} stopped`;
  }
  if (lang.runs === 'bridge') {
    await sendToBridge({ type: 'stop', language: id, code: lastSent.get(id) || '' });
    return `${lang.label}: stop sent`;
  }
  return 'Stopped';
}

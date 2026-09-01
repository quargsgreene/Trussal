// ymeta.mjs — Yjs metaprogram-doc helper for the load harness.
//
// The shared metaprogram is ONE Y.Doc per meeting with a Y.Text named
// 'metaprogram' (see src/audio-net/MetaprogrammerCrdtSync.js). Updates travel
// base64-encoded over the sidecar's `crdt-update` relay. Python can't build a
// valid Yjs update, so it drives this process over a line protocol on
// stdin/stdout instead.
//
// Resolves `yjs` from the repo's own node_modules (node walks up from this
// file: loadtest/tools -> loadtest -> repo root/node_modules/yjs). Run
// `npm ci` at the repo root once if that is missing.
//
// Protocol: one JSON object per line in, one per line out.
//   in  {"id":1,"cmd":"reset"}
//   out {"id":1,"ok":true,"text":""}
//   in  {"id":2,"cmd":"settext","text":"$ participants <0 1>\n# tempo 110","snapshot":false}
//   out {"id":2,"ok":true,"update":"<b64>","snapshot":false,"bytes":37,"text":"..."}
//   in  {"id":3,"cmd":"snapshot"}
//   out {"id":3,"ok":true,"update":"<b64>","snapshot":true,"bytes":52}
//   in  {"id":4,"cmd":"apply_remote","update":"<b64>"}
//   out {"id":4,"ok":true,"text":"...merged..."}

import * as Y from 'yjs';
import readline from 'node:readline';

const TEXT_KEY = 'metaprogram';
const SNAPSHOT_EVERY = 25;

let doc, ytext, localUpdates;

function reset() {
  doc = new Y.Doc();
  ytext = doc.getText(TEXT_KEY);
  localUpdates = 0;
}
reset();

function b64(update) {
  let s = '';
  for (const byte of update) s += String.fromCharCode(byte);
  return Buffer.from(s, 'binary').toString('base64');
}
function unb64(s) {
  const bin = Buffer.from(s, 'base64').toString('binary');
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// common-prefix/suffix diff -> single delete+insert, exactly like applyTextDiff
function applyTextDiff(next, origin) {
  const prev = ytext.toString();
  if (prev === next) return false;
  let start = 0;
  const maxStart = Math.min(prev.length, next.length);
  while (start < maxStart && prev[start] === next[start]) start++;
  let endPrev = prev.length;
  let endNext = next.length;
  while (endPrev > start && endNext > start && prev[endPrev - 1] === next[endNext - 1]) {
    endPrev--; endNext--;
  }
  doc.transact(() => {
    if (endPrev > start) ytext.delete(start, endPrev - start);
    if (endNext > start) ytext.insert(start, next.slice(start, endNext));
  }, origin);
  return true;
}

function handle(req) {
  const { id, cmd } = req;
  if (cmd === 'reset') {
    reset();
    return { id, ok: true, text: '' };
  }
  if (cmd === 'settext') {
    let captured = null;
    const onUpdate = (u, origin) => { if (origin === 'local') captured = u; };
    doc.on('update', onUpdate);
    const changed = applyTextDiff(String(req.text ?? ''), 'local');
    doc.off('update', onUpdate);
    if (!changed) return { id, ok: true, update: null, snapshot: false, bytes: 0, text: ytext.toString() };
    localUpdates++;
    const wantSnap = !!req.snapshot || localUpdates % SNAPSHOT_EVERY === 0;
    const payload = wantSnap ? Y.encodeStateAsUpdate(doc) : captured;
    const enc = b64(payload);
    return { id, ok: true, update: enc, snapshot: wantSnap, bytes: payload.length, text: ytext.toString() };
  }
  if (cmd === 'snapshot') {
    const payload = Y.encodeStateAsUpdate(doc);
    return { id, ok: true, update: b64(payload), snapshot: true, bytes: payload.length, text: ytext.toString() };
  }
  if (cmd === 'apply_remote') {
    Y.applyUpdate(doc, unb64(req.update), 'remote');
    return { id, ok: true, text: ytext.toString() };
  }
  return { id, ok: false, error: `unknown cmd ${cmd}` };
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  line = line.trim();
  if (!line) return;
  let req;
  try { req = JSON.parse(line); }
  catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n'); return; }
  let res;
  try { res = handle(req); }
  catch (e) { res = { id: req.id, ok: false, error: String(e && e.message || e) }; }
  process.stdout.write(JSON.stringify(res) + '\n');
});
rl.on('close', () => process.exit(0));

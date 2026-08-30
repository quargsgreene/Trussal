// O2LiteClient — the browser-side WebSocket client for Trussal's O2 relay
// (latency-instrument/o2-relay.js).
//
// This is NOT upstream o2ws.js. It speaks Trussal's own transport: one
// serialized o2lite-format.js message per binary WebSocket frame (no length
// prefix, no o2host discovery handshake), fanned out per `?room=` by the
// relay. The API is a small ES-module class that the JPattern driver
// (src/audio-net/Metaprogrammer.js) and node:test (test/clock-sync.test.js)
// both drive.
//
// Two message classes:
//   - Clock sync: sendCsGet(seq, t) emits `/_cs/get` (,it). The relay answers
//     point-to-point with `/_cs/rply` (,itt seq clientTime serverTime), which
//     is routed to onCsReply() callbacks — ClockSync.makeClockSyncOverO2 wires
//     handleReply() there.
//   - Everything else: send(address, typespec, args, timestamp) is fanned out
//     by the relay to the rest of the room; inbound app messages dispatch to
//     the matching method(address, handler) callbacks.
//
// Serialization is shared with the relay by construction, through the ESM
// facade src/audio-net/o2lite_driver.js (→ latency-instrument/o2lite-format.js),
// so the browser and the sidecar encode bytes identically.

import {
  serializeMessage,
  deserializeMessage,
  CS_GET,
  CS_REPLY
} from '../../src/audio-net/o2lite_driver.js';

const WS_OPEN = 1; // WHATWG WebSocket.OPEN — same in browsers and the `ws` lib.

// Bridge the two event surfaces we care about: browsers and the node `ws`
// package both implement addEventListener; fall back to EventEmitter-style
// .on() just in case.
function addListener(ws, type, fn) {
  if (typeof ws.addEventListener === 'function') ws.addEventListener(type, fn);
  else if (typeof ws.on === 'function') ws.on(type, fn);
}
function removeListener(ws, type, fn) {
  if (typeof ws.removeEventListener === 'function') ws.removeEventListener(type, fn);
  else if (typeof ws.off === 'function') ws.off(type, fn);
}

export class O2LiteClient {
  constructor({ url, WebSocketImpl } = {}) {
    if (!url) throw new TypeError('O2LiteClient needs a url');
    this.url = url;
    this._WS = WebSocketImpl || (typeof WebSocket !== 'undefined' ? WebSocket : null);
    if (!this._WS) throw new TypeError('O2LiteClient: no WebSocket implementation available');
    this.ws = null;
    this._methods = [];     // [{ path, handler }]
    this._csReplyCbs = [];  // [(seq, clientTime, serverTime) => void]
    this._connectPromise = null;
  }

  // Resolves once the socket is open. Idempotent: repeated calls share the
  // first connect's promise.
  connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new this._WS(this.url);
      } catch (e) { reject(e); return; }
      this.ws = ws;
      // Deliver binary frames as ArrayBuffer on both platforms; deserialize
      // also accepts a Node Buffer, so this is belt-and-suspenders.
      try { ws.binaryType = 'arraybuffer'; } catch (e) { /* readonly on some impls until open */ }

      const onOpen = () => { removeListener(ws, 'error', onError); resolve(this); };
      const onError = (ev) => {
        removeListener(ws, 'error', onError);
        reject((ev && ev.error) || new Error('O2LiteClient websocket error'));
      };
      addListener(ws, 'open', onOpen);
      addListener(ws, 'error', onError);
      addListener(ws, 'message', (ev) => this._onMessage(ev));
    });
    return this._connectPromise;
  }

  _onMessage(ev) {
    // addEventListener('message') hands us a MessageEvent (.data); the .on()
    // fallback hands us the raw payload.
    const data = ev && typeof ev === 'object' && 'data' in ev ? ev.data : ev;
    let msg;
    try { msg = deserializeMessage(data); } catch (e) { return; }

    if (msg.address === CS_REPLY) {
      const [seq, clientTime, serverTime] = msg.args;
      for (const cb of this._csReplyCbs) {
        try { cb(seq, clientTime, serverTime); } catch (e) { /* isolate handlers */ }
      }
      return; // system traffic never reaches app methods
    }

    for (const { path, handler } of this._methods) {
      if (this._matches(path, msg.address)) {
        try { handler(msg); } catch (e) { /* isolate handlers */ }
      }
    }
  }

  // A handler registered at `path` receives an address it equals, or any
  // address beneath it. '/' is the catch-all.
  _matches(path, address) {
    if (path === '/' || path === address) return true;
    const base = path.endsWith('/') ? path : path + '/';
    return address.startsWith(base);
  }

  method(path, handler) {
    if (typeof handler !== 'function') throw new TypeError('method() needs a handler function');
    this._methods.push({ path, handler });
    return this;
  }

  onCsReply(cb) {
    if (typeof cb !== 'function') throw new TypeError('onCsReply() needs a function');
    this._csReplyCbs.push(cb);
    return this;
  }

  // Fan a message out to the room. Silently no-ops until the socket is open —
  // JPattern tolerates running unsynced, so a pre-connect send is dropped
  // rather than thrown.
  send(address, typespec = ',', args = [], timestamp = 0) {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return false;
    this.ws.send(serializeMessage({ address, typespec, args, timestamp }));
    return true;
  }

  // One clock-sync round-trip request. `/_cs/get` is answered by the relay
  // itself (never fanned out), so it carries no timestamp.
  sendCsGet(seq, clientTime) {
    if (!this.ws || this.ws.readyState !== WS_OPEN) return false;
    this.ws.send(serializeMessage({ address: CS_GET, typespec: ',it', args: [seq, clientTime] }));
    return true;
  }

  close() {
    if (this.ws) { try { this.ws.close(); } catch (e) { /* already closing */ } }
  }
}

export default O2LiteClient;

// Pure logic for the live() Strudel source: the rolling capture ring and
// device-name matching. No DOM, no WebAudio — runs identically in the browser
// bundle and under node:test. The browser glue lives in live-input.js.

// Mono ring buffer of float frames. write() appends (overwriting the oldest
// audio once full); snapshot(n) returns the most recent n frames in
// chronological order, front-padded with silence while the ring is still
// filling so playback length always equals the requested length.
export class LiveRing {
  constructor(capacity) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.data = new Float32Array(this.capacity);
    this.writePos = 0;
    this.total = 0;
  }

  get filled() { return Math.min(this.total, this.capacity); }

  write(chunk) {
    if (!chunk || !chunk.length) return;
    let src = chunk;
    if (src.length > this.capacity) src = src.subarray(src.length - this.capacity);
    const first = Math.min(src.length, this.capacity - this.writePos);
    this.data.set(src.subarray(0, first), this.writePos);
    if (first < src.length) this.data.set(src.subarray(first), 0);
    this.writePos = (this.writePos + src.length) % this.capacity;
    this.total += chunk.length;
  }

  snapshot(frames) {
    const len = Math.max(0, Math.min(Math.floor(frames), this.capacity));
    const out = new Float32Array(len);
    const n = Math.min(len, this.filled);
    if (n === 0) return out;
    const start = (this.writePos - n + this.capacity) % this.capacity;
    const dest = len - n;
    const first = Math.min(n, this.capacity - start);
    out.set(this.data.subarray(start, start + first), dest);
    if (first < n) out.set(this.data.subarray(0, n - first), dest + first);
    return out;
  }
}

// Resolve a user-typed device name against enumerated inputs
// ([{deviceId, label}]). Exact label match wins over substring; a raw
// deviceId is accepted as a last resort. Empty name → null, which the
// caller treats as "use the default input". Case-insensitive throughout.
export function matchAudioDevice(devices, name) {
  const wanted = (name || '').trim().toLowerCase();
  if (!wanted) return null;
  const labeled = devices.filter(d => d.label);
  return labeled.find(d => d.label.toLowerCase() === wanted)
      || labeled.find(d => d.label.toLowerCase().includes(wanted))
      || devices.find(d => d.deviceId === name)
      || null;
}

// Superdough sound key for a device name: s("live_motu_m4") etc. Must stay
// mini-notation safe (letters, digits, underscores only).
export function liveSlug(name) {
  const base = (name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `live_${base || 'default'}`;
}

// --- live() call rewriting --------------------------------------------------
//
// Two source transforms applied to every peer's code before evaluation.
//
// 1. Device names must not be mini-parsed. Strudel's transpiler rewrites EVERY
//    double-quoted (and backtick) string into mini(...), and real device labels
//    routinely contain characters the krill grammar rejects — "Scarlett 2i2 USB
//    (Focusrite)" throws, and one throw kills the whole combined program, not
//    just that voice. Single-quoted strings are the only literal the transpiler
//    leaves alone, so every live() name is re-emitted single-quoted.
//
// 2. `silent` renames the call to _liveSilent, the stub used for remote peers'
//    voices (capture belongs to the authoring browser — see live-input.js).
//
// Deliberately textual: this runs on peer code that is only ever a string here,
// and matches the surrounding buildPeerBlock transforms.

// live( "…" | '…' | `…` ) with the argument optional. No lookbehind — a
// leading-boundary capture group keeps the bundle parseable on older Safari.
const LIVE_CALL_RE = /(^|[^\w.$])live\s*\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)?\s*\)/g;
const LIVE_NAME_RE = /(^|[^\w.$])live\s*\(/g;

// Raw JS string literal → its actual value.
function decodeLiteral(raw) {
  const body = raw.slice(1, -1);
  if (raw[0] === '"') {
    try { return JSON.parse(raw); } catch (e) { /* fall through to manual unescape */ }
  }
  return body.replace(/\\(.)/g, '$1');
}

// Value → single-quoted JS literal the transpiler will not touch.
function singleQuote(value) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r?\n/g, ' ')}'`;
}

export function rewriteLiveCalls(code, { silent = false } = {}) {
  const fn = silent ? '_liveSilent' : 'live';
  let out = String(code ?? '').replace(LIVE_CALL_RE, (match, before, literal) => {
    // A template literal with interpolation can't be decoded statically; leave
    // the argument as written and let the name rename below handle it.
    if (literal && literal[0] === '`' && literal.includes('${')) return match;
    if (!literal) return `${before}${fn}()`;
    return `${before}${fn}(${singleQuote(decodeLiteral(literal))})`;
  });
  // Any live( form the first pass didn't match — live(someVar), interpolated
  // template names — still needs silencing for remote peers.
  if (silent) out = out.replace(LIVE_NAME_RE, `$1${fn}(`);
  return out;
}

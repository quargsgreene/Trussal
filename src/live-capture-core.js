// Pure logic for the liveCapture() Strudel source: the rolling capture buffers
// (audio ring, discrete-event log, cursor path), source-name matching, and the
// call rewrite. No DOM, no WebAudio, no timers — runs identically in the
// browser bundle and under node:test. The browser glue lives in live-capture.js.
//
//   liveCapture(medium, name, detectLocalDevices)
//
// records a rolling window of one MEDIUM from one source and returns a
// Strudel-patternable handle; every pattern event replays / refires / retraces
// the freshest captured slice — the same "struct gates the live signal"
// model live() had for audio, generalised to six mediums.

// The mediums, in the order the feature spec lists them.
export const MEDIA = ['audio', 'video', 'text', 'css', 'gesture', 'cursor'];

// Mono ring buffer of float frames (audio). write() appends (overwriting the
// oldest audio once full); snapshot(n) returns the most recent n frames in
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

// A bounded, time-ordered log of discrete events — the text/css deltas a peer
// produces, and the gestures the local performer fires. push() appends; entries
// past `capacity`, or older than `windowMs` behind the newest, are dropped.
//
//   latest()      the freshest { t, value }, or null
//   nextAfter(t)  the first entry strictly newer than t, wrapping to the oldest
//                 once the end is passed — that wrap is what makes a finite
//                 recording "refire in sequence when the time comes" forever.
export class EventLog {
  constructor({ capacity = 256, windowMs = 30000 } = {}) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.windowMs = Math.max(0, windowMs);
    this.entries = [];
  }

  _trim(now) {
    if (this.windowMs && this.entries.length) {
      const floor = now - this.windowMs;
      while (this.entries.length > 1 && this.entries[0].t < floor) this.entries.shift();
    }
    while (this.entries.length > this.capacity) this.entries.shift();
  }

  push(value, t = Date.now()) {
    this.entries.push({ t, value });
    this._trim(t);
  }

  get length() { return this.entries.length; }

  latest() {
    return this.entries.length ? this.entries[this.entries.length - 1] : null;
  }

  nextAfter(t) {
    if (!this.entries.length) return null;
    for (const e of this.entries) if (e.t > t) return e;
    return this.entries[0];
  }

  reset() { this.entries = []; }
}

// A path of { x, y, t } samples with linear interpolation by elapsed
// milliseconds across the recorded span, wrapping once the end is passed. A
// pattern event of any duration can therefore walk the retrace at its own
// rate: the browser advances a head by each event's duration and reads at().
export class CursorPath {
  constructor(capacity = 4096) {
    this.capacity = Math.max(2, Math.floor(capacity));
    this.points = [];
  }

  push(x, y, t = Date.now()) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    this.points.push({ x, y, t });
    if (this.points.length > this.capacity) this.points.shift();
  }

  get length() { return this.points.length; }

  // Milliseconds between the first and last recorded sample.
  get span() {
    if (this.points.length < 2) return 0;
    return this.points[this.points.length - 1].t - this.points[0].t;
  }

  reset() { this.points = []; }

  // Interpolated { x, y } at `offsetMs` past the first sample, wrapped modulo
  // the span. null while nothing is recorded.
  at(offsetMs) {
    const p = this.points;
    if (!p.length) return null;
    if (p.length === 1) return { x: p[0].x, y: p[0].y };
    const span = this.span;
    if (span <= 0) return { x: p[p.length - 1].x, y: p[p.length - 1].y };
    const off = ((offsetMs % span) + span) % span;
    const target = p[0].t + off;
    for (let i = 1; i < p.length; i++) {
      if (p[i].t >= target) {
        const a = p[i - 1], b = p[i];
        const dt = b.t - a.t || 1;
        const f = Math.max(0, Math.min(1, (target - a.t) / dt));
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
      }
    }
    return { x: p[p.length - 1].x, y: p[p.length - 1].y };
  }
}

// The transpiler wraps double-quoted strings in mini patterns, so
// liveCapture("audio", "MOTU M4") can receive a Pattern of the words rather
// than a plain string; single-quoted strings arrive verbatim. Recover the
// original text either way.
export function patternWordsToString(arg) {
  if (typeof arg === 'string') return arg;
  if (arg && typeof arg.firstCycle === 'function') {
    try {
      return arg.firstCycle()
        .sort((a, b) => a.part.begin - b.part.begin)
        .map(h => `${h.value}`)
        .join(' ');
    } catch (e) {
      // fall through to String()
    }
  }
  return arg == null ? '' : String(arg);
}

// Normalise the three call arguments. `error` is a human-readable string when
// the medium is not one of MEDIA, else null.
export function parseLiveCaptureArgs(mediumArg, nameArg, detectArg) {
  const medium = patternWordsToString(mediumArg).trim().toLowerCase();
  const name = patternWordsToString(nameArg).trim();
  const detectLocalDevices = detectArg === true || detectArg === 'true' || detectArg === 1;
  const error = MEDIA.includes(medium)
    ? null
    : `unknown medium "${medium || '(none)'}" — expected one of: ${MEDIA.join(', ')}`;
  return { medium, name, detectLocalDevices, error };
}

// Superdough sound key for a capture: s("livecap_audio_motu_m4"),
// s("livecap_cursor_self"), … Must stay mini-notation safe (letters, digits,
// underscores only).
export function captureSlug(medium, name) {
  const m = String(medium || 'audio').toLowerCase().replace(/[^a-z]+/g, '') || 'audio';
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `livecap_${m}_${base || 'self'}`;
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

// --- liveCapture() call rewriting ----------------------------------------
//
// Two source transforms applied to every peer's code before evaluation, the
// same reasoning as the live() rewrite this replaces.
//
// 1. The medium and source-name strings must not be mini-parsed. Strudel's
//    transpiler rewrites EVERY double-quoted (and backtick) string into
//    mini(...), and real device labels routinely contain characters the krill
//    grammar rejects — "Scarlett 2i2 USB (Focusrite)" throws, and one throw
//    kills the whole combined program, not just that voice. Single-quoted
//    strings are the only literal the transpiler leaves alone, so every string
//    argument is re-emitted single-quoted. A trailing boolean / identifier /
//    number argument passes through untouched.
//
// 2. `silent` renames the call to _liveCaptureSilent, the stub used for remote
//    peers' voices — capture (a mic, the local head-cursor path, this browser's
//    gesture log) belongs to the authoring browser; the pattern SHAPE (struct,
//    chained ops) must still survive on every other browser.
//
// Deliberately textual: this runs on peer code that is only ever a string here,
// and matches the surrounding buildPeerBlock transforms.

// liveCapture( <args> ) where an argument may be a quoted string containing any
// character (parentheses included), or a run of bare identifier/number/boolean
// characters. No lookbehind — a leading-boundary capture group keeps the bundle
// parseable on older Safari.
const CALL_RE = /(^|[^\w.$])liveCapture\s*\(\s*((?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|[^()'"`])*?)\s*\)/g;
const NAME_RE = /(^|[^\w.$])liveCapture\s*\(/g;

// Split a raw argument list on top-level commas, respecting quotes. There are
// no nested parentheses to worry about — CALL_RE only matches when every paren
// sits inside a string.
function splitArgs(raw) {
  const args = [];
  let cur = '';
  let q = null;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (q) {
      cur += c;
      if (c === '\\') { cur += raw[++i] ?? ''; continue; }
      if (c === q) q = null;
    } else if (c === '"' || c === "'" || c === '`') {
      q = c; cur += c;
    } else if (c === ',') {
      args.push(cur); cur = '';
    } else {
      cur += c;
    }
  }
  args.push(cur);
  const trimmed = args.map(s => s.trim());
  // `liveCapture()` → [''] → no args.
  if (trimmed.length === 1 && trimmed[0] === '') return [];
  return trimmed;
}

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

function isPlainStringLiteral(part) {
  if (part.length < 2) return false;
  const q = part[0];
  if ((q !== '"' && q !== "'" && q !== '`') || part[part.length - 1] !== q) return false;
  // A template literal with interpolation can't be decoded statically.
  if (q === '`' && part.includes('${')) return false;
  return true;
}

export function rewriteLiveCaptureCalls(code, { silent = false } = {}) {
  const fn = silent ? '_liveCaptureSilent' : 'liveCapture';
  let out = String(code ?? '').replace(CALL_RE, (match, before, rawArgs) => {
    const parts = splitArgs(rawArgs).map((p) =>
      isPlainStringLiteral(p) ? singleQuote(decodeLiteral(p)) : p
    );
    return `${before}${fn}(${parts.join(', ')})`;
  });
  // Any liveCapture( form the first pass didn't fully match — a non-literal
  // argument expression — still needs silencing for remote peers.
  if (silent) out = out.replace(NAME_RE, `$1${fn}(`);
  return out;
}

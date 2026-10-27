// Pure logic for `.out("device")` — routing a voice's output, as the
// Aggregator streams it, to a named peripheral on some participant's machine:
// a monitor for video / text / css, a speaker system (optionally a set of its
// channels) for audio. No DOM, no WebAudio — runs in the bundle, in bots, and
// under node:test. The browser glue lives in output-route.js.
//
//   vid: osc(100).out("some monitor")              // Hydra voice → a monitor
//   drums: s("bd*4").out("MOTU M4", [3, 4])        // Strudel voice → channels 3+4
//   $: word("hello").out("lobby screen")           // text voice → a monitor
//
// and in the Metaprogram, for the Aggregator's whole output:
//
//   # out "lobby screen" ["video" "text"]
//   # out "MOTU M4" 3 4 ["audio"]
//
// A string first argument is what makes it a route. Hydra's own `.out()`,
// `.out(o0)` … `.out(o3)` are untouched, so a program with no routes is
// byte-for-byte what it was before this existed — output "stays as is".
//
// Device names are matched the way liveCapture matches inputs: exact label
// first, then substring, case-insensitive. Only the browser whose machine
// owns a matching device acts on a route, and only after its user allows it.

// The four output media, in EffectMedia.js's canonical order.
export const OUT_MEDIA = Object.freeze(['audio', 'css', 'text', 'video']);

// Which kind of local device each medium lands on.
export function deviceKindFor(medium) {
  return medium === 'audio' ? 'audiooutput' : 'screen';
}

// --- the call ----------------------------------------------------------------

const STRING_LIT = String.raw`"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'`;
const CHANNELS = String.raw`\[\s*\d+(?:\s*,\s*\d+)*\s*\]|\d+`;
// `.out("name")` / `.out("name", 3)` / `.out("name", [3, 4])`. No lookbehind —
// keeps the bundle parseable on older Safari, same as live-capture-core.js.
const OUT_ROUTE_SRC = String.raw`\.out\s*\(\s*(${STRING_LIT})\s*(?:,\s*(${CHANNELS})\s*)?\)`;

// Non-global single-test form, for "does this code route anything".
export const OUT_ROUTE_RE = new RegExp(OUT_ROUTE_SRC);

// A chain whose head is one of these is Hydra: none of them is a Strudel
// function. `img` is Trussal's uploaded-image source inside a Hydra preamble.
const HYDRA_HEAD_RE = /^(?:osc|noise|voronoi|shape|gradient|solid|src|img)\s*\(/;
// The head of a statement may carry a label (`vid:`) or the anonymous `$:`.
const LABEL_RE = /^(\s*)(?:([A-Za-z_$][\w$]*)|\$)\s*:(?!:)\s*/;

function decodeLiteral(raw) {
  if (raw[0] === '"') {
    try { return JSON.parse(raw); } catch (e) { /* fall through to manual unescape */ }
  }
  return raw.slice(1, -1).replace(/\\(.)/g, '$1');
}

// "3" / "[3, 4]" → [3, 4]; 1-based speaker channels, deduped, ascending.
export function parseChannels(raw) {
  if (raw == null || raw === '') return null;
  const nums = String(raw).match(/\d+/g) || [];
  const out = [...new Set(nums.map(Number).filter((n) => Number.isInteger(n) && n >= 1))];
  return out.length ? out.sort((a, b) => a - b) : null;
}

// Line index of the statement that owns offset `pos`: walk back over
// `.method(` continuation lines and lines that close a call left open above.
function statementStartLine(lines, lineIdx) {
  let i = lineIdx;
  while (i > 0) {
    const line = lines[i];
    if (/^\s*\./.test(line)) { i--; continue; }
    // A line inside an open call (`osc(10,\n  0.1)`) belongs to the line above.
    const above = lines.slice(0, i).join('\n');
    const depth = (above.match(/\(/g) || []).length - (above.match(/\)/g) || []).length;
    if (depth > 0 && !/^\s*$/.test(lines[i - 1])) { i--; continue; }
    break;
  }
  return i;
}

// The medium a statement produces, read from its head (and, for Strudel, the
// text/css call shapes in its body).
export function statementMedium(statement) {
  const body = String(statement).replace(LABEL_RE, '').trimStart();
  if (HYDRA_HEAD_RE.test(body)) return 'video';
  if (/(?:^|[^\w$.])css\s*\(/.test(statement)) return 'css';
  if (/(?:^|[^\w$.])word\s*\(/.test(statement)) return 'text';
  return 'audio';
}

// Pull every route out of one peer's code.
//
//   code    the code with each route rewritten away: a Hydra statement's
//           `.out("x")` becomes `.out()` (it still renders, as before) and its
//           label is dropped — Strudel's transpiler turns `name: expr` into
//           `expr.p('name')`, and a Hydra chain's `.out()` returns nothing to
//           call `.p` on. A Strudel statement's `.out("x")` is removed
//           outright; the label stays, since Strudel voices want it.
//   routes  [{ voice, medium, target, channels }] in source order. `voice`
//           is the statement's label, or `$<n>` for the n-th unlabelled one.
//
// Only string-literal targets are routes: `.out(o1)` and `.out()` pass
// through untouched.
export function extractOutRoutes(code) {
  const src = String(code ?? '');
  if (!OUT_ROUTE_RE.test(src)) return { code: src, routes: [] };
  const lines = src.split('\n');
  const lineStarts = [];
  for (let i = 0, off = 0; i < lines.length; i++) { lineStarts.push(off); off += lines[i].length + 1; }
  const lineOf = (pos) => {
    let i = 0;
    while (i + 1 < lineStarts.length && lineStarts[i + 1] <= pos) i++;
    return i;
  };

  const re = new RegExp(OUT_ROUTE_SRC, 'g');
  const found = [];
  let m;
  while ((m = re.exec(src))) {
    const startLine = statementStartLine(lines, lineOf(m.index));
    const statementEnd = m.index + m[0].length;
    const statement = src.slice(lineStarts[startLine], statementEnd);
    const label = statement.match(LABEL_RE);
    found.push({
      index: m.index,
      length: m[0].length,
      line: m[0].includes('\n') ? -1 : lineOf(m.index),
      startLine,
      label: label ? (label[2] || '$') : null,
      medium: statementMedium(statement),
      target: decodeLiteral(m[1]).trim(),
      channels: parseChannels(m[2]),
    });
  }

  // Rewrite back to front so earlier offsets stay valid.
  let out = src;
  const relabel = new Set();
  for (let k = found.length - 1; k >= 0; k--) {
    const f = found[k];
    const replacement = f.medium === 'video' ? '.out()' : '';
    out = out.slice(0, f.index) + replacement + out.slice(f.index + f.length);
    if (f.medium === 'video' && f.label && f.label !== '$') relabel.add(f.startLine);
  }
  // A route written on its own continuation line (`  .out("x")`, or mondo's
  // `# out "x"` once lowered) leaves that line blank — and a blank line is a
  // paragraph break to the Hydra/silent preamble split, which would cut the
  // chain below it off from its voice. Drop such a line outright.
  const emptied = new Set(found.filter((f) => f.medium !== 'video' && f.line >= 0).map((f) => f.line));
  if (relabel.size || emptied.size) {
    const outLines = out.split('\n');
    for (const i of relabel) outLines[i] = outLines[i].replace(LABEL_RE, '$1');
    out = outLines.filter((l, i) => !(emptied.has(i) && !l.trim() && lines[i].trim())).join('\n');
  }

  let anon = 0;
  const routes = [];
  for (const f of found) {
    if (!f.target) continue; // `.out("")` routes nowhere — rewritten, not kept
    const voice = f.label && f.label !== '$' ? f.label : `$${++anon}`;
    routes.push({ voice, medium: f.medium, target: f.target, channels: f.channels });
  }
  return { code: out, routes };
}

export function stripOutRoutes(code) {
  return extractOutRoutes(code).code;
}

// --- the Metaprogram's `# out` -----------------------------------------------

// The `# out` entries of a parsed Metaprogram chain, as routes. `media` is the
// resolved medium set (all four when unwritten); the device kind each medium
// needs then decides which of them a matched device can actually carry.
export function metaprogramRoutes(chain, resolveMedia) {
  const routes = [];
  for (const entry of chain || []) {
    if (!entry || entry.fn !== 'out' || !entry.target) continue;
    const media = typeof resolveMedia === 'function' ? resolveMedia(entry.media) : (entry.media || OUT_MEDIA);
    for (const medium of media) {
      routes.push({ voice: 'metaprogram', medium, target: entry.target, channels: entry.channels || null });
    }
  }
  return routes;
}

// --- devices -----------------------------------------------------------------

// Resolve a typed name against enumerated audio outputs ([{deviceId, label}]),
// exactly as liveCapture's matchAudioDevice does for inputs: exact label, then
// substring, then a raw deviceId. Case-insensitive. Empty name → null.
export function matchOutputDevice(devices, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  const list = (devices || []).filter((d) => d && d.kind !== 'audioinput' && d.kind !== 'videoinput');
  const labeled = list.filter((d) => d.label);
  return labeled.find((d) => d.label.toLowerCase() === wanted)
      || labeled.find((d) => d.label.toLowerCase().includes(wanted))
      || list.find((d) => d.deviceId === name)
      || null;
}

// Resolve a typed name against the Window Management API's screens
// ([{label, ...}]): exact label, then substring. `"screen 2"` / `"monitor 2"`
// also picks the second screen by position, for displays whose label the OS
// leaves generic.
export function matchScreen(screens, name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  const list = screens || [];
  const labeled = list.filter((s) => s && s.label);
  const byLabel = labeled.find((s) => s.label.toLowerCase() === wanted)
      || labeled.find((s) => s.label.toLowerCase().includes(wanted));
  if (byLabel) return byLabel;
  const idx = wanted.match(/^(?:screen|monitor|display)\s*(\d+)$/);
  if (idx) return list[Number(idx[1]) - 1] || null;
  return null;
}

// Which destination channel each input feeds. 1-based channels past what the
// device has are dropped; null (no channels written) means "the device's own
// default layout", i.e. connect straight through.
export function channelMap(channels, maxChannels) {
  if (!channels || !channels.length) return null;
  const max = Math.max(1, Math.floor(maxChannels || 2));
  const keep = channels.filter((c) => c >= 1 && c <= max);
  return keep.length ? keep.map((c) => c - 1) : null;
}

// --- identity & permission ---------------------------------------------------

// One active route on this machine: who asked, for which medium, on which of
// our devices. Two voices of one author routing the same medium to the same
// device share one sink — the Aggregator streams that author's medium as one.
export function sinkKey({ author, medium, deviceId }) {
  return `${author}|${medium}|${deviceId}`;
}

// What the owner is asked to allow: an author reaching one of their devices.
// The decision covers every medium that author sends there, so a voice added
// mid-set does not re-prompt for a device the owner already opened to them.
export function permissionKey({ author, deviceId }) {
  return `${author}|${deviceId}`;
}

// The sentence the owner reads before anything of theirs is touched.
export function permissionPrompt({ authorName, voices, medium, deviceLabel, channels }) {
  const who = authorName || 'Someone';
  const what = voices && voices.length
    ? `${voices.length > 1 ? 'voices' : 'voice'} ${voices.map((v) => `'${v}'`).join(', ')} (${medium})`
    : medium;
  const ch = channels && channels.length ? ` on channel${channels.length > 1 ? 's' : ''} ${channels.join(', ')}` : '';
  return `${who} wants to stream ${what} to your device "${deviceLabel}"${ch}.`;
}

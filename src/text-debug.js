// Text Cycles tracing — the words, printed at every point they are held.
//
// Between a performer typing word("hello") and a span landing in the chat log
// the text is held in six different places, and EVERY one of them can drop it
// without raising anything:
//
//   1. the peer record          — did the pattern reach peer-state at all?
//   2. the per-peer block       — was a preamble split off, was the peer
//                                 playing, were the statements kept?
//   3. the rewrite              — were the atoms minted and ._tcRender()
//                                 attached? (without it there is no renderer)
//   4. the atom table           — does the token resolve back to characters?
//   5. the evaluated program    — did evaluate() throw?
//   6. the chat container       — is it in the document, or detached?
//
// "No words appear" looked identical in all six cases, which is why this
// module exists: each stage prints what it is holding and keeps its last value
// for interrogation afterwards.
//
//   __trussalText.state()   // last record from every stage + live probes
//   __trussalText.off()     // stop printing; state() keeps recording
//   __trussalText.on()      // print again
//
// Hap-rate stages are rate limited. A fast pattern paints several words a
// second per performer, and a console that scrolls faster than it can be read
// is worth about as much as no console at all.

const PREFIX = '[text-cycles]';
// Long code/programs are clipped in the printed line; the recorded stage keeps
// the whole thing, so state() can still show it.
const MAX_INLINE = 500;
const HAP_LOGS_PER_SEC = 12;

const stages = new Map();   // stage → { at, count, detail }
const probes = new Map();   // name → () => detail

// Default ON: this exists because the pipeline was silent, so it has to say
// something without being switched on first.
function printing() {
  return typeof window === 'undefined' || window.__trussalTextDebug !== false;
}

export function clip(text, max = MAX_INLINE) {
  const s = String(text ?? '');
  return s.length <= max ? s : `${s.slice(0, max)}… (+${s.length - max} more chars)`;
}

function record(stage, detail) {
  const previous = stages.get(stage);
  stages.set(stage, { at: Date.now(), count: (previous?.count ?? 0) + 1, detail });
  return previous;
}

// One line per event. For things that happen at edit rate or once.
export function textLog(stage, detail) {
  record(stage, detail);
  if (printing()) console.log(`${PREFIX} ${stage}`, detail);
}

// Record, and say whether this is a repeat of what the stage last held. The
// program is rebuilt on every peer-state event — metrics arrive about once a
// second — so a stage that has not changed would otherwise repeat an identical
// line forever and bury the one that is different.
function recordAndDiff(stage, detail) {
  let key;
  try {
    key = JSON.stringify(detail);
  } catch (e) {
    // A detail carrying a DOM node or a cycle is still worth printing; it just
    // cannot be compared, so treat it as always-changed.
    key = null;
  }
  const previous = stages.get(stage);
  record(stage, detail);
  stages.get(stage).key = key;
  return key !== null && previous && previous.key === key;
}

// Same as textLog, but only prints when the detail actually changed.
export function textLogChanged(stage, detail) {
  if (recordAndDiff(stage, detail)) return;
  if (printing()) console.log(`${PREFIX} ${stage}`, detail);
}

let hapWindowStart = 0;
let hapPrinted = 0;
let hapSuppressed = 0;

// One line per hap, capped per second so a fast pattern cannot flood the log.
export function textHapLog(stage, detail) {
  record(stage, detail);
  if (!printing()) return;
  const now = Date.now();
  if (now - hapWindowStart >= 1000) {
    if (hapSuppressed) console.log(`${PREFIX} … ${hapSuppressed} more hap line(s) not printed`);
    hapWindowStart = now;
    hapPrinted = 0;
    hapSuppressed = 0;
  }
  if (hapPrinted++ >= HAP_LOGS_PER_SEC) { hapSuppressed++; return; }
  console.log(`${PREFIX} ${stage}`, detail);
}

// A stage that is holding something it should not be, or is not holding what
// it should. Loud — these are the states that produce silence — and printed
// whether or not tracing is on, but only once per distinct state: the program
// is rebuilt at metrics rate, so a warning that stays true would repeat every
// second without ever saying anything new.
export function textWarn(stage, message, detail) {
  if (recordAndDiff(stage, { message, ...detail })) return;
  console.warn(`${PREFIX} ${stage}: ${message}`, detail);
}

// Live state a stage can be asked for rather than having pushed — the atom
// table, the chat DOM. Registered by the module that owns it so this one
// imports nothing and can be pulled in from anywhere without a cycle.
export function registerTextProbe(name, fn) {
  probes.set(name, fn);
}

export function textState() {
  const out = { stages: {}, probes: {} };
  for (const [stage, rec] of stages) {
    out.stages[stage] = { at: new Date(rec.at).toISOString(), count: rec.count, detail: rec.detail };
  }
  for (const [name, fn] of probes) {
    try {
      out.probes[name] = fn();
    } catch (e) {
      out.probes[name] = { error: String(e && e.message || e) };
    }
  }
  return out;
}

if (typeof window !== 'undefined') {
  window.__trussalText = {
    state: textState,
    on() { window.__trussalTextDebug = true; return 'text-cycles tracing ON'; },
    off() { window.__trussalTextDebug = false; return 'text-cycles tracing OFF (state() still records)'; },
  };
}

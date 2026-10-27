// Personal editor languages — pure core.
//
// The personal editor speaks JPattern by default, but its language dropdown
// can switch it to another live coding language. Each language runs in one of
// four places, and that is the only thing the studio needs to know about it:
//
//   'room'   — JPattern, and the two languages it is a superset of (pure
//              Strudel, pure Hydra). The buffer is translated into a JPattern
//              program (toRoomPattern) and travels to the room exactly like a
//              JPattern buffer, so every browser plays it.
//   'page'   — Punctual: evaluated in this browser only, by its own engine.
//   'bridge' — a language that runs in the performer's own terminal (Tidal,
//              Sonic Pi, sclang, Renardo, zwirn, Sardine). The buffer goes to
//              scripts/live-bridge.mjs over a localhost WebSocket, which hands
//              it to the interpreter. The room hears it through the performer's
//              microphone input (see the docs for routing the audio).
//   'none'   — textmode: plain text, never evaluated.
//
// Everything here is pure so it runs under node:test; scripts/live-bridge.mjs
// imports the bridge framing (bridgeFrames) from here too, so the browser and
// the bridge never disagree about how a buffer is delivered.

import { ensureDirective, stripDirective } from './program-directive.js';

export const DEFAULT_LANGUAGE = 'jpattern';
export const DEFAULT_BRIDGE_URL = 'ws://127.0.0.1:7171';

export const LANGUAGES = [
  {
    id: 'jpattern',
    label: 'JPattern',
    runs: 'room',
    starter: null, // JPattern keeps the editor's own seed (DEFAULT_PATTERN)
  },
  {
    id: 'strudel',
    label: 'Strudel (pure)',
    runs: 'room',
    starter: `// Plain Strudel, as on strudel.cc — no directive needed
$: n("<0 2 4 7>*4").scale("C:minor").s("sawtooth").lpf(800)
$: s("bd*2, ~ hh*2")
`,
  },
  {
    id: 'hydra',
    label: 'Hydra (pure)',
    runs: 'room',
    starter: `// Plain Hydra, as on hydra.ojack.xyz
osc(10, 0.1, 1.2)
  .kaleid(4)
  .modulate(noise(3))
  .out()
`,
  },
  {
    id: 'punctual',
    label: 'Punctual',
    runs: 'page',
    starter: `-- Punctual (runs in this browser only)
circle [0, 0] 0.25 * [1, 0.5, 0.2] >> add;
sin [220, 330] * 0.1 >> audio
`,
  },
  {
    id: 'tidal',
    label: 'TidalCycles',
    runs: 'bridge',
    starter: `-- TidalCycles (needs the live bridge + SuperDirt)
d1 $ sound "bd*2 [~ sn] hh*4"
`,
  },
  {
    id: 'sonicpi',
    label: 'Sonic Pi',
    runs: 'bridge',
    starter: `# Sonic Pi (needs the live bridge + the Sonic Pi receiver buffer)
live_loop :beat do
  sample :bd_haus
  sleep 0.5
end
`,
  },
  {
    id: 'sclang',
    label: 'SuperCollider (sclang)',
    runs: 'bridge',
    starter: `// SuperCollider (needs the live bridge)
s.waitForBoot {
  Ndef(\\pad, { SinOsc.ar([220, 221], 0, 0.1) }).play;
};
`,
  },
  {
    id: 'renardo',
    label: 'Renardo',
    runs: 'bridge',
    starter: `# Renardo (needs the live bridge + SuperCollider)
p1 >> pluck([0, 2, 4], dur=1/2)
d1 >> play("x-o-")
`,
  },
  {
    id: 'zwirn',
    label: 'zwirn',
    runs: 'bridge',
    starter: `-- zwirn (needs the live bridge)
1 $: s "kick"
`,
  },
  {
    id: 'sardine',
    label: 'Sardine',
    runs: 'bridge',
    starter: `# Sardine (needs the live bridge + SuperDirt)
Pa >> d('bd cp')
`,
  },
  {
    id: 'textmode',
    label: 'Text mode (no code)',
    runs: 'none',
    starter: '',
  },
];

const BY_ID = new Map(LANGUAGES.map((l) => [l.id, l]));

export function getLanguage(id) {
  return BY_ID.get(id) || BY_ID.get(DEFAULT_LANGUAGE);
}

export function isLanguage(id) {
  return BY_ID.has(id);
}

// The JPattern program a 'room' language buffer travels to the room as.
// JPattern itself goes unchanged — its directive is the performer's to write,
// and onEvalAndPlay names a missing one rather than adding it silently.
//
// Pure Strudel only lacks the directive. Pure Hydra becomes a Hydra-only
// JPattern block: `await initHydra()` opens the capability preamble, which
// runs to the first blank line, so the performer's blank lines are dropped to
// keep the whole sketch inside it (splitHydraCode would otherwise hand the
// remainder to Strudel as a pattern). Returns null for any other language.
export function toRoomPattern(languageId, code) {
  const text = String(code ?? '');
  switch (languageId) {
    case 'jpattern':
      return text;
    case 'strudel':
      return ensureDirective(stripDirective(text), 'personal');
    case 'hydra': {
      const body = stripDirective(text)
        .split('\n')
        .filter((line) => line.trim() !== '')
        .filter((line) => !/^\s*await\s+initHydra\s*\(/.test(line))
        .join('\n');
      return ensureDirective(`await initHydra()${body ? `\n${body}` : ''}`, 'personal');
    }
    default:
      return null;
  }
}

// Ctrl+/ comments with the language's own line comment. Languages missing
// here (JPattern, Strudel, Hydra, sclang, textmode) use `//`.
const LINE_COMMENT = {
  punctual: '--',
  tidal: '--',
  zwirn: '--',
  sonicpi: '#',
  renardo: '#',
  sardine: '#',
};

export function lineCommentFor(languageId) {
  return LINE_COMMENT[languageId] || '//';
}

// ── bridge framing ──────────────────────────────────────────────────────────
//
// What each interpreter has to be sent on stdin to evaluate one buffer, and
// the statement that silences it. Kept beside the language list so the
// browser's Stop and the bridge's interpreter agree.

// GHCi-style multi-line block: Tidal's ghci and zwirn's zwirnzi both read
// `:{` … `:}` as one evaluation.
function ghciBlock(code) {
  const body = code.split('\n').filter((l) => l.trim() !== ':{' && l.trim() !== ':}').join('\n');
  return `:{\n${body}\n:}\n`;
}

// A Python REPL (Sardine's console) treats a blank line as the end of an
// indented block, and a top-level line straight after an indented one is a
// syntax error. Drop the performer's blank lines, put one back wherever
// indentation returns to the margin, and close the buffer with one.
function pythonReplBlock(code) {
  const lines = code.split('\n').filter((l) => l.trim() !== '');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const indented = /^\s/.test(lines[i]);
    if (i > 0 && !indented && /^\s/.test(lines[i - 1])) out.push('');
    out.push(lines[i]);
  }
  return `${out.join('\n')}\n\n`;
}

export const BRIDGE_LANGUAGES = {
  tidal: {
    frame: ghciBlock,
    stop: 'hush\n',
  },
  zwirn: {
    frame: ghciBlock,
    stop: 'hush\n',
  },
  // sclang evaluates everything up to a form feed (the convention scnvim and
  // scel use); CmdPeriod.run is Ctrl+. in the IDE.
  sclang: {
    frame: (code) => `${code}\n\x0c`,
    stop: 'CmdPeriod.run;\n\x0c',
  },
  // renardo --pipe executes its buffer at each blank line, so the
  // performer's own blank lines would split one statement into several runs.
  renardo: {
    frame: (code) => `${code.split('\n').filter((l) => l.trim() !== '').join('\n')}\n\n`,
    stop: 'Clock.clear()\n\n',
  },
  sardine: {
    frame: pythonReplBlock,
    stop: 'silence()\n\n',
  },
  // Sonic Pi has no stdin: the bridge sends the buffer as an OSC cue that the
  // receiver buffer (SONIC_PI_RECEIVER) passes to run_code, and Stop is sent
  // the same way (sonicPiStopCode).
  sonicpi: {
    frame: (code) => code,
    stop: null,
  },
};

export function bridgeFrames(languageId, code) {
  const spec = BRIDGE_LANGUAGES[languageId];
  if (!spec) return null;
  return spec.frame(String(code ?? '').replace(/\r\n?/g, '\n').replace(/\s+$/, ''));
}

// `lastCode` is the buffer last sent, for a language whose stop has to name
// what it started (Sonic Pi). null when the language has no stop statement.
export function bridgeStopFrame(languageId, lastCode = '') {
  if (languageId === 'sonicpi') return sonicPiStopCode(lastCode);
  return BRIDGE_LANGUAGES[languageId]?.stop ?? null;
}

// Sonic Pi stops a live_loop by redefining it with a body that calls `stop`,
// so Stop names every loop the last buffer started. A buffer with no
// live_loop has nothing still running to stop (one-shot sounds just end).
export function sonicPiStopCode(code) {
  const names = [...new Set([...String(code ?? '').matchAll(/^\s*live_loop\s+:([A-Za-z_]\w*)/gm)].map((m) => m[1]))];
  if (!names.length) return null;
  return names.map((n) => `live_loop :${n} do\n  stop\nend`).join('\n');
}

// The Sonic Pi receiver the performer runs once in a Sonic Pi buffer of its
// own. Code arrives as the /trussal/run cue and plays as a new Run, as if it
// had been typed into a buffer and Run pressed.
export const SONIC_PI_RECEIVER = `# Trussal live bridge receiver — run this once in its own Sonic Pi buffer
live_loop :trussal_run do
  use_real_time
  code = sync "/osc*/trussal/run"
  run_code code[0]
end
`;

// Minimal OSC 1.0 encoder for the Sonic Pi cue: an address and string
// arguments only. Each field is NUL-terminated and padded to 4 bytes.
export function encodeOscMessage(address, args = []) {
  const pad = (bytes) => {
    const len = bytes.length + 1;
    const padded = new Uint8Array(Math.ceil(len / 4) * 4);
    padded.set(bytes);
    return padded;
  };
  const enc = new TextEncoder();
  const parts = [pad(enc.encode(address)), pad(enc.encode(`,${'s'.repeat(args.length)}`))];
  for (const a of args) parts.push(pad(enc.encode(String(a))));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

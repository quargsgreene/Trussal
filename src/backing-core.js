// backing-core.js — pure logic for backing voices:
//
//   $: backing("example.wav", true, false)
//
// A backing voice streams one uploaded audio or video file while its author
// is playing, independent of the JPattern ring. The second argument is
// whether it loops (default true), the third whether it streams ONLY during
// its author's own turn (default false), the fourth whether pressing Play
// restarts it from the beginning (default false). A turn-only backing pauses
// when the turn passes and picks up where it left off on the author's next
// turn; likewise, stopping pauses a backing and starting again resumes it,
// unless the fourth argument asks for a restart.
//
// A backing is a declaration, not a pattern. The aggregator plays it: the
// aggregator's master carries exactly one participant at a time, so a
// participant's own published track can never reach the room off-turn — the
// file has to be mixed in AFTER the turn gate, on the aggregator's master bus
// (and drawn into its mosaic, for a video). So every browser strips these
// statements from the program it evaluates (strudel.js), the author's browser
// ships the file to the aggregator once (backing.js), and the aggregator
// reads each peer's declarations straight off the roster's `pattern`
// (backingsForPeers) — the same way its mosaic reads Hydra preambles.
//
// No DOM, no Strudel, no network — runs identically in the browser bundle,
// the aggregator (Node) and under node:test.

import { splitStatements } from './text-cycles-core.js';
import { kindOfFilename } from './file-cycles-core.js';
import { readDirective } from './program-directive.js';
import { normalizePeerCode } from './hydra-code.js';

// Any backing( call, in any position.
export const BACKING_CALL_RE = /(?:^|[^\w$.])backing\s*\(/;

const STRING_LITERAL = '"(?:[^"\\\\]|\\\\.)*"|\'(?:[^\'\\\\]|\\\\.)*\'|`(?:[^`\\\\$]|\\\\.)*`';
const BOOL_ARG = '\\s*,\\s*(true|false)';
const CALL_RE = new RegExp(
  `(?:^|[^\\w$.])backing\\s*\\(\\s*(${STRING_LITERAL})(?:${BOOL_ARG})?(?:${BOOL_ARG})?(?:${BOOL_ARG})?\\s*,?\\s*\\)`,
  'g',
);

function unquote(raw) {
  return raw.slice(1, -1).replace(/\\(.)/g, '$1');
}

// The medium a backing file streams as, or null for a file backing() cannot
// play. Uploads are the Studio Files picker's (file-cycles-core.js), so the
// extension rules are the same ones image()/video()/soundFile() use.
export function backingKindOf(name) {
  const kind = kindOfFilename(name);
  if (kind === 'soundFile') return 'audio';
  if (kind === 'video') return 'video';
  return null;
}

// Every backing("file", loop?, turnOnly?, restart?) in `code`, in order, one per
// filename (a later declaration of the same file wins). Only literal
// arguments count — the declaration is read without evaluating anything, so
// a filename or flag computed at runtime is not one this can see.
export function parseBackingCalls(code) {
  const byName = new Map();
  for (const { text } of splitStatements(String(code ?? ''))) {
    if (!BACKING_CALL_RE.test(text)) continue;
    for (const m of text.matchAll(CALL_RE)) {
      const name = unquote(m[1]).trim();
      const kind = backingKindOf(name);
      if (!name || !kind) continue;
      byName.delete(name);
      byName.set(name, {
        name,
        kind,
        loop: m[2] !== 'false',
        turnOnly: m[3] === 'true',
        restart: m[4] === 'true',
      });
    }
  }
  return [...byName.values()];
}

// `code` without its backing() statements. Removed outright rather than
// blanked (silent-voice-core.js's stripCalls leaves an empty line), because a
// blank line is what ends a capability preamble — blanking a declaration
// between two statements would split the program somewhere new.
export function stripBackingCalls(code) {
  return splitStatements(String(code ?? ''))
    .filter(({ text }) => !BACKING_CALL_RE.test(text))
    .map(({ text }) => text)
    .join('\n');
}

// The backings a peer's personal-editor buffer declares — the same directive
// rule buildPeerBlock applies, so a buffer that contributes nothing to the
// program declares no backing either.
export function peerBackings(pattern) {
  if (!pattern || readDirective(pattern).kind !== 'personal') return [];
  return parseBackingCalls(normalizePeerCode(pattern));
}

// Every backing declared in the room right now, from the roster the
// aggregator holds, each with whether its author is playing. A stopped
// author's backings stay listed (paused, not dropped) so pressing Play again
// resumes them where they left off. Bots are
// excluded (their files are not theirs to upload — cluster-source.js strips
// the statement from what a bot runs), as are peers with no room index (the
// ring cannot address them, so a turn-only backing could never sound).
export function backingsForPeers(peers) {
  // Any iterable of peers, or a Map of them (the aggregator's roster).
  const list = peers instanceof Map ? [...peers.values()] : [...(peers ?? [])];
  const out = [];
  for (const peer of list) {
    if (!peer || peer.isAggregator || peer.isBot) continue;
    if (peer.roomIndex == null) continue;
    const token = String(peer.roomIndex);
    const playing = !!peer.playing;
    for (const b of peerBackings(peer.pattern)) out.push({ token, ...b, playing });
  }
  return out;
}

// The key a backing is stored and played under: one file per author.
export function backingKey(token, name) {
  return `${token}\u0000${name}`;
}

export function backingsEqual(a, b) {
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.token === b[i].token && x.name === b[i].name &&
    x.kind === b[i].kind && x.loop === b[i].loop && x.turnOnly === b[i].turnOnly &&
    x.restart === b[i].restart && x.playing === b[i].playing);
}

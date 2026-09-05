// silent-voice-core.js — shared statement splitting and renderer-attachment
// for silent Strudel voices whose arguments are already grammar-legal
// mini-notation atoms (a reaction abbreviation, an uploaded filename) and so
// need none of the literal-text escaping/minting text-cycles-core.js and
// css-cycles-core.js exist for. Used by reactions-core.js, panel-bg-core.js
// and file-cycles-core.js.
//
// No DOM, no Strudel — runs identically in the browser bundle and under
// node:test.

import { splitStatements } from './text-cycles-core.js';

// Append `rendererCall` (e.g. "._rxRender()") on its own line to every
// statement matching `callRe`, so a voice built from a call the performer
// never explicitly renders (reaction(...), panel(...), image(...), …) is
// wired to its silent renderer automatically — the same shape as
// rewriteTextCalls' renderer attachment, minus the atom minting.
export function appendRendererCalls(code, callRe, rendererCall) {
  return splitStatements(String(code ?? ''))
    .map(({ text }) => (callRe.test(text)
      ? `${text.replace(/[\s;]+$/, '')}\n${rendererCall}`
      : text))
    .join('\n');
}

// Drop every statement matching `callRe` outright, replacing it with nothing.
// Used for a capability that only the AUTHORING peer's own browser may act
// on (reaction, panel): every OTHER browser also evaluates that peer's
// pattern (buildPeerBlock stacks every peer into the combined program), and
// without this a remote peer's reaction()/panel() would either throw trying
// to reach superdough with no renderer attached, or — worse, if it were
// rendered instead of stripped — fire from every viewer's own Jitsi
// connection at once rather than just the author's.
export function stripCalls(code, callRe) {
  return splitStatements(String(code ?? ''))
    .map(({ text }) => (callRe.test(text) ? '' : text))
    .filter((line, i, arr) => !(line === '' && arr[i - 1] === ''))
    .join('\n');
}

// The inverse of stripCalls: keep only the statements matching `callRe` (plus
// a bare `await initX()` declaration matching `initRe`, so a capability
// declared alone in its own paragraph survives too). Mirrors
// css-cycles-core.js's keepSilentStatements, generalized for a capability
// that isn't word()/css() — used alongside it (not instead of it) when a
// remote peer's audio is excluded from the combined program (aggregator
// mode) but their silent voices, this one included, must still reach every
// viewer's own page. A statement that mixes two capabilities in one chain
// (rare) may then be kept by both passes and so render twice under that
// specific combination — an accepted, narrow edge case rather than a fully
// unified single-pass filter across every silent capability.
export function keepMatchingStatements(code, callRe, initRe) {
  return String(code ?? '').split(/\n\n+/).map((paragraph) => {
    if (!paragraph.trim()) return null;
    const survivors = splitStatements(paragraph)
      .filter(({ text }) => callRe.test(text) || (initRe && initRe.test(text.trim())))
      .map(({ text }) => text);
    return survivors.length ? survivors.join('\n') : null;
  }).filter((p) => p !== null).join('\n\n').trim();
}

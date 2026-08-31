// Test helper: parseMetaprogram with the required 'metaprogram editor'
// directive supplied automatically.
//
// The parser now demands a leading 'metaprogram editor' directive line, with no
// heuristic fallback (see src/program-directive.js). The parser's own
// fixtures are bodies — `$ participants <…>` plus `#` directives — so this
// wrapper prepends the directive when a fixture does not already carry one,
// leaving every other export untouched. Tests that exercise the directive
// requirement itself import the real module directly.

import { parseMetaprogram as realParseMetaprogram } from '../../src/audio-net/MetaprogrammerParser.js';

export * from '../../src/audio-net/MetaprogrammerParser.js';

// Already declares itself? (a single- or double-quoted 'metaprogram editor' —
// or the legacy 'metaprogram' alias — on the first non-blank, non-comment
// line, the same shape program-directive.js recognises).
const ALREADY_DECLARED = /^(?:\s*(?:\/\/[^\n]*)?\n)*\s*(['"])metaprogram(?: editor)?\1/;

export function parseMetaprogram(text) {
  const s = typeof text === 'string' ? text : '';
  return realParseMetaprogram(ALREADY_DECLARED.test(s) ? s : `'metaprogram editor'\n${s}`);
}

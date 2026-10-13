// Test helper: parseMetaprogram with the required 'metaprogram editor'
// directive supplied automatically.

import { parseMetaprogram as realParseMetaprogram } from '../../src/audio-net/MetaprogrammerParser.js';

export * from '../../src/audio-net/MetaprogrammerParser.js';
const ALREADY_DECLARED = /^(?:\s*(?:\/\/[^\n]*)?\n)*\s*(['"])metaprogram(?: editor)?\1/;

export function parseMetaprogram(text) {
  const s = typeof text === 'string' ? text : '';
  return realParseMetaprogram(ALREADY_DECLARED.test(s) ? s : `'metaprogram editor'\n${s}`);
}

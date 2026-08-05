// SCSS compilation for CSS Cycles.
//
// The browser cannot compile SCSS without shipping a compiler in the bundle
// Jitsi loads on every join, so the authoring client sends its SCSS here, we
// compile once, and the CSS is mirrored to the whole room over the peer bus.
//
// NOTHING HERE IS A SECURITY BOUNDARY FOR THE ROOM. The guardrails that decide
// what a performer may do to the UI run in the browser — on the way out, and
// again on the way in when a peer's compiled sheet arrives. This module only
// defends the SIDECAR: a compiler that resolves `@use` reads the container's
// filesystem, and an unbounded source blocks the event loop for every room on
// the process.

// A generous ceiling for a live-coded stylesheet; well past this the input is
// no longer something a performer typed.
const MAX_SOURCE_BYTES = 64 * 1024;

// At-rules that reach outside the string we were handed. Sass resolves these
// against the filesystem, so they are refused before the compiler sees them
// rather than relying on an empty importer list to fail them.
const REACHING_AT_RULES = /@(use|import|forward)\b/i;
const LOAD_CSS = /\bmeta\.load-css\b|\bload-css\s*\(/i;

// Reasons this source may not be compiled, or null if it may.
function checkScssSource(source) {
  const src = String(source ?? '');
  if (src.length > MAX_SOURCE_BYTES) {
    return `stylesheet is larger than ${MAX_SOURCE_BYTES} bytes`;
  }
  if (REACHING_AT_RULES.test(src)) {
    return '@use, @import and @forward are not available';
  }
  if (LOAD_CSS.test(src)) {
    return 'meta.load-css is not available';
  }
  return null;
}

let sassMod;
let sassMissing = false;

function loadSass() {
  if (sassMod || sassMissing) return sassMod;
  try {
    // Required lazily so the sidecar still boots (and every other message type
    // keeps working) on a deployment where the dependency is not installed.
    sassMod = require('sass');
  } catch (e) {
    sassMissing = true;
    console.error('[scss] the sass package is not installed; CSS Cycles will not compile', e.message);
  }
  return sassMod;
}

// Compile one peer's SCSS. Returns { css } or { error } — never throws, since
// a malformed stylesheet is an ordinary thing for a performer to type.
function compileScss(source) {
  const refusal = checkScssSource(source);
  if (refusal) return { error: refusal };

  const sass = loadSass();
  if (!sass) return { error: 'the SCSS compiler is unavailable on this server' };

  try {
    const result = sass.compileString(String(source), {
      // No filesystem, no network: the source is the whole world.
      loadPaths: [],
      importers: [],
      style: 'compressed',
      logger: { warn: () => {}, debug: () => {} },
    });
    return { css: result.css };
  } catch (e) {
    // sass errors carry the line and column the performer needs.
    return { error: String(e && e.message ? e.message : e).split('\n').slice(0, 4).join(' ') };
  }
}

module.exports = { compileScss, checkScssSource, MAX_SOURCE_BYTES };

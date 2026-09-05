// panel-bg-core.js — pure logic for panel() (video-tile virtual background)
// patterns: the call-detection regex only. No DOM, no Strudel — runs
// identically in the browser bundle and under node:test. Resolving a name to
// an actual image source (an uploaded file, or one of Jitsi's own defaults)
// and dispatching to Jitsi's virtual-background feature both need window.APP
// and the upload store, so they live in panel-bg.js instead.

// A panel() call in any position, including chained — the same shape as
// text-cycles-core.js's WORD_CALL_RE and reactions-core.js's REACTION_CALL_RE.
export const PANEL_CALL_RE = /(?:^|[^\w$])panel\s*\(/;

/**
 * Resolving a sample manifest against the address a bot uses for the fleet.
 *
 * The fleet hands out PATHS (`/samples/<room>/<owner>/<bank>/<file>`) because it
 * cannot know how any given container addresses it — "localhost:7700" from a
 * host-networked bot, something else from anywhere else. CONDUCTOR_URL is the
 * bot's own answer to that, so the join happens here.
 *
 * Its own module rather than a helper inside bot/index.js: that file is an
 * entry point which starts a bot on import (and pulls in puppeteer), so nothing
 * can import it to test a pure function.
 */
export function absoluteSampleUrls(manifest, baseUrl) {
  if (!manifest || typeof manifest !== 'object') return {};
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  const out = {};
  for (const [bank, paths] of Object.entries(manifest)) {
    if (!Array.isArray(paths)) continue;
    // An absolute URL is passed through: only the fleet's own relative paths
    // need a base, and rewriting anything else would silently redirect a bank.
    out[bank] = paths.map((p) => (/^https?:\/\//i.test(p) ? p : `${base}${p}`));
  }
  return out;
}

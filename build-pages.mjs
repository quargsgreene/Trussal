// build-pages.mjs — generates the standalone Documentation and About pages.
//
// Both pages are static: they load no JS at all, and reuse the exact content
// builders (src/docs-about-content.js) and stylesheets (src/docs-about.css +
// src/docs-page.css) that the welcome page's corner links out to, so they show
// the same content the old modal panels had. Serving them at /documentation
// and /about (custom-config/web/nginx/custom-routes.conf) also keeps those
// paths out of the room catch-all — without it, "documentation" would be a
// perfectly valid meeting-room name and the URL would join it.
//
// build.mjs calls buildPages('dist') on every (re)build; its deploy step then
// copies the pages into docker-jitsi-meet/jitsi-web/ (the jitsi-web image
// build context and runtime bind mount).

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ABOUT_HTML, ABOUT_TITLE, DOCS_TITLE, buildDocsBody } from './src/docs-about-content.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The page filenames this module writes (into the output dir it is given).
// They are served at the extensionless /documentation and /about.
export const PAGE_FILES = ['documentation.html', 'about.html'];

function pageCss() {
	return [
		readFileSync(join(__dirname, 'src/docs-about.css'), 'utf8'),
		readFileSync(join(__dirname, 'src/docs-page.css'), 'utf8'),
	].join('\n');
}

// Dev-only (Vite serves these pages with hotReload: true; the build always
// passes false): poll the dev server's docs version and reload when any docs
// source or image changes. Plain fetch + reload — no EventSource, no module
// client involvement, so a missing/failing endpoint (e.g. the page was opened
// straight from the container on :8443) is silently ignored instead of
// becoming a reload loop.
function hotReloadScript() {
	return `
<script>
(function() {
  var last = null;
  function poll() {
    fetch('/__docs-version', { cache: 'no-store' })
      .then(function(r) { return r.ok ? r.text() : null; })
      .then(function(v) {
        if (v === null) return;
        if (last === null) { last = v; return; }
        if (v !== last) location.reload();
      })
      .catch(function() {});
  }
  setInterval(poll, 1500);
  poll();
})();
</script>`;
}

function renderPage({ title, heading, body, css, hotReload }) {
	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <!-- docs-about.css (the panel styles) and docs-page.css inlined by
         build-pages.mjs. Inline, so a page is one cache-friendly file with no
         separate asset to version. -->
    <style>
${css}
    </style>
  </head>
  <body>
    <!-- The same corner the welcome page injects (src/docs-about.js). -->
    <div id="trussal-da-corner">
      <a href="/documentation">Documentation</a>
      <a href="/about">About</a>
    </div>
    <!-- The same .trussal-da-panel markup the modal panels used; the ✕ leaves
         the page for the lobby. -->
    <div class="trussal-da-panel">
      <div class="da-head">
        <h2>${heading}</h2>
        <a class="da-close" href="/" title="Back to the lobby">✕</a>
      </div>
      <div class="da-body">
${body}
      </div>
    </div>
${hotReload ? hotReloadScript() : ''}
  </body>
</html>
`;
}

// Write both pages into `outDir` (created if missing).
export function buildPages(outDir, { hotReload = false } = {}) {
	mkdirSync(outDir, { recursive: true });
	const css = pageCss();
	const pages = [
		{
			file: 'documentation.html',
			html: renderPage({ title: `${DOCS_TITLE} — Trussal`, heading: DOCS_TITLE, body: buildDocsBody(), css, hotReload }),
		},
		{
			file: 'about.html',
			html: renderPage({ title: 'About — Trussal', heading: ABOUT_TITLE, body: ABOUT_HTML, css, hotReload }),
		},
	];
	for (const { file, html } of pages) writeFileSync(join(outDir, file), html);
	return pages.map(({ file }) => file);
}

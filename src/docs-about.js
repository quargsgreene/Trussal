// docs-about.js — the welcome page's bottom-right "Documentation" / "About"
// corner. The two entries are plain links to the standalone pages at
// /documentation and /about, which build-pages.mjs generates at build time from
// src/docs-about-content.js (see build-pages.mjs); those pages inline this
// module's docs-about.css, so they keep the exact panel look and content the
// modal panels used to have.
//
// The corner only exists on the welcome page — a fixed position, deliberately
// with no JS repositioning: an earlier top-right version tracked Jitsi's own
// settings gear and ended up covering it.

const CORNER_ID = 'trussal-da-corner';

// Live handle for the boot poll, so repeated boots replace the previous one.
let bootTimer = null;

// ---------------------------------------------------------------------------
// DOM.
// ---------------------------------------------------------------------------
function _ensureDOM() {
  if (document.getElementById(CORNER_ID)) return;
  if (!document.body) return;

  const corner = document.createElement('div');
  corner.id = CORNER_ID;
  // Real anchors, not buttons: these are full navigations to static pages, so
  // they can also be middle-clicked / opened in a new tab / copied as URLs.
  corner.innerHTML = `
    <a id="trussal-da-docs-btn" href="/documentation">Documentation</a>
    <a id="trussal-da-about-btn" href="/about">About</a>
  `;
  corner.addEventListener('mousedown', (e) => e.stopPropagation());
  corner.addEventListener('click', (e) => e.stopPropagation());
  document.body.appendChild(corner);
}

function _onWelcomePage() {
  return !!(document.body && document.body.classList.contains('welcome-page'));
}

function _boot() {
  let tries = 0;
  const maxTries = 40;

  // Replace the previous poll, if any.
  if (bootTimer) clearInterval(bootTimer);

  // Try once immediately (also makes the HMR rerender synchronous after the
  // dispose hook removes the old corner); the interval below keeps retrying
  // while the welcome page is still rendering.
  if (_onWelcomePage()) _ensureDOM();

  const timer = setInterval(() => {
    tries += 1;
    if (_onWelcomePage()) _ensureDOM();
    if (document.getElementById(CORNER_ID) || tries >= maxTries) clearInterval(timer);
  }, 250);
  bootTimer = timer;
}

function init() {
  if (window.__trussalIsBot || window.__trussalIsAggregator) return;
  if (document.readyState === 'complete' || document.readyState === 'interactive') _boot();
  else window.addEventListener('DOMContentLoaded', _boot);
}

init();

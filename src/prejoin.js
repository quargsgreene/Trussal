// prejoin.js — Trussal's own prejoin screen: the DOM half of prejoin-core.js.
//
// Trussal renders and owns the prejoin. lib-jitsi-bootstrap.js starts the
// conference on this screen's Join, with the chosen display name — rather than
// connecting at load. The Jitsi web app shell that serves the page never joins,
// so nothing else can start a conference here.
//
// While the screen is up, Jitsi's own prejoin (present because the shell is)
// is hidden by prejoin-core.js's suppression rule, so there is exactly one Join
// on the page and Jitsi is not started behind Trussal's back.
//
// The screen reuses the contract the rest of the bundle already keys off the
// Jitsi prejoin — the #premeeting-name-input id and a .premeeting-screen
// container — so on-screen-keyboard.js, facial-gesture.js and studio.js keep
// working without knowing where the screen came from.

import {
  PREJOIN_SCREEN_ID,
  PREJOIN_NAME_INPUT_ID,
  PREJOIN_SCREEN_CLASS,
  normaliseDisplayName,
  readStoredDisplayName,
  writeStoredDisplayName,
  prejoinMarkup,
  prejoinSuppressionCss,
} from './prejoin-core.js';

const SUPPRESSION_STYLE_ID = PREJOIN_SCREEN_ID + '-style';

function safeStorage() {
  try { return (typeof window !== 'undefined' && window.localStorage) || null; }
  catch (e) { return null; } // storage can throw when disabled by the browser
}

// The display name last chosen, from this browser's storage ('' if none).
export function getPrejoinDisplayName() {
  return readStoredDisplayName(safeStorage());
}

export function hasRenderedPrejoin() {
  try { return typeof document !== 'undefined' && !!document.getElementById(PREJOIN_SCREEN_ID); }
  catch (e) { return false; }
}

export function removePrejoin() {
  try {
    if (typeof document === 'undefined') return;
    const screen = document.getElementById(PREJOIN_SCREEN_ID);
    if (screen && screen.remove) screen.remove();
    const style = document.getElementById(SUPPRESSION_STYLE_ID);
    if (style && style.remove) style.remove();
  } catch (e) { /* nothing rendered to remove */ }
}

// Render the prejoin and resolve with the display name when the user submits —
// possibly empty, since the name is optional. Where there is no DOM (or no body
// yet) it resolves immediately with whatever was stored, so a non-browser caller
// gets a usable value instead of a promise that never settles.
export function renderPrejoin({ initialName, buttonLabel = 'Join meeting' } = {}) {
  return new Promise((resolve) => {
    const stored = initialName !== undefined
      ? normaliseDisplayName(initialName)
      : readStoredDisplayName(safeStorage());

    if (typeof document === 'undefined' || !document.body) {
      resolve(stored);
      return;
    }

    const doc = document;
    try {
      removePrejoin(); // never two Trussal prejoins

      const style = doc.createElement('style');
      style.id = SUPPRESSION_STYLE_ID;
      style.textContent = prejoinSuppressionCss();
      (doc.head || doc.body).appendChild(style);

      const screen = doc.createElement('div');
      screen.id = PREJOIN_SCREEN_ID;
      screen.className = PREJOIN_SCREEN_CLASS;
      screen.innerHTML = prejoinMarkup({ initialName: stored, buttonLabel });
      doc.body.appendChild(screen);

      const input = screen.querySelector('#' + PREJOIN_NAME_INPUT_ID);
      const submit = () => {
        const name = writeStoredDisplayName(safeStorage(), input ? input.value : '');
        removePrejoin();
        resolve(name);
      };

      const form = screen.querySelector('form');
      if (form) form.addEventListener('submit', (e) => { if (e && e.preventDefault) e.preventDefault(); submit(); });
      else screen.addEventListener('click', submit); // no form: any click joins

      // The Jitsi prejoin autofocuses this field, and landmark-gesture-mode.js
      // relies on that to know where the caret is; keep parity.
      try { if (input && input.focus) input.focus(); } catch (e) { /* focus is best-effort */ }
    } catch (e) {
      // A broken DOM must not strand the join: resolve with whatever we have.
      console.warn('[prejoin] could not render the prejoin; joining without it', e);
      resolve(stored);
    }
  });
}

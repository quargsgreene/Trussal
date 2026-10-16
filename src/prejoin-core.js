// prejoin-core.js — pure logic for Trussal's own prejoin screen.
//
// Trussal owns the page now: the Jitsi web app shell no longer hosts the
// meeting, so there is no native prejoin to relabel, suppress or otherwise
// reach into. Trussal draws its own screen, collects the display name, and only
// then starts the conference (lib-jitsi-bootstrap.js) — the "join" moment.
//
// No DOM, no storage, no network here — the storage key, the name
// normalisation, the decision to own the screen, and the overlay markup all run
// under node:test. prejoin.js does the wiring.
//
// The screen presents the CONTRACT the rest of the bundle keys off: the
// display-name input id that on-screen-keyboard, facial-gesture and studio.js
// look for, and a root class that marks the page as "not yet in a meeting".
// Those features keep working without knowing where the screen came from.

export const DISPLAY_NAME_STORAGE_KEY = 'trussal.displayName.v1';

export const PREJOIN_SCREEN_ID = 'trussal-prejoin-screen';
export const PREJOIN_NAME_INPUT_ID = 'premeeting-name-input';
export const PREJOIN_SCREEN_CLASS = 'premeeting-screen';

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// A display name is optional and free-form (docs: "any characters"), so the only
// reshaping is trimming the surrounding whitespace — enough to tell "left blank"
// from "typed spaces", and nothing more presumptuous.
export function normaliseDisplayName(raw) {
  return typeof raw === 'string' ? raw.trim() : '';
}

export function readStoredDisplayName(storage) {
  try {
    if (!storage) return '';
    return storage.getItem(DISPLAY_NAME_STORAGE_KEY) || '';
  } catch (e) {
    return '';
  }
}

// Persist the name (empty clears it), returning the normalised value actually
// stored so the caller joins with exactly what was saved.
export function writeStoredDisplayName(storage, name) {
  const clean = normaliseDisplayName(name);
  try {
    if (!storage) return clean;
    if (clean) storage.setItem(DISPLAY_NAME_STORAGE_KEY, clean);
    else storage.removeItem(DISPLAY_NAME_STORAGE_KEY);
  } catch (e) { /* storage can be disabled; the join still proceeds with clean */ }
  return clean;
}

// Whether Trussal owns the prejoin. lib-jitsi-meet is the only backend, so the
// sole question is whether the client is one that can submit a form: bots and
// the aggregator must join unattended rather than wait on a human.
export function shouldOwnPrejoin({ isBot = false, isAggregator = false } = {}) {
  return !isBot && !isAggregator;
}

// The overlay's inner markup. Styling lives in prejoin.css (imported as raw
// text by prejoin.js) — no inline style attributes.
//
// The room name is deliberately NOT rendered, for the same reason the welcome
// overlay never renders it (see welcome-page.js): nothing here should have to
// reason about a 1023-character room name, and the performer already typed it
// one screen ago.
export function prejoinMarkup({ initialName = '', buttonLabel = 'Join meeting' } = {}) {
  const value = escapeHtml(normaliseDisplayName(initialName));
  const label = escapeHtml(buttonLabel);
  return `
    <div class="trussal-join-panel">
      <form class="trussal-join-form">
        <label class="trussal-join-label" for="${PREJOIN_NAME_INPUT_ID}">
          Display name (optional):
        </label>
        <input id="${PREJOIN_NAME_INPUT_ID}"
               class="trussal-join-input"
               name="displayName"
               type="text"
               autocomplete="off"
               autocapitalize="words"
               autocorrect="off"
               spellcheck="false"
               placeholder="Display name"
               value="${value}"/>
        <button class="trussal-join-button" type="submit">
          ${label}
        </button>
      </form>
    </div>
  `;
}

// prejoin-core.js — pure logic for Trussal's own prejoin screen.
//
// The Jitsi shell may draw its own prejoin (name field, device preview, a Join
// button Trussal relabels in welcome-page.js), but it never joins a conference.
// Trussal collects the display name itself and only then starts the conference
// (lib-jitsi-bootstrap.js) — the "join" moment.
//
// No DOM, no storage, no network here — the storage key, the name
// normalisation, the decision to own the screen, and the overlay markup all run
// under node:test. prejoin.js does the wiring.
//
// The screen deliberately presents the CONTRACT the rest of the bundle already
// keys off the Jitsi prejoin: the display-name input id that on-screen-keyboard,
// facial-gesture and studio.js look for, and a class that makes them treat the
// page as "not yet in a meeting". Reusing them means those features keep working
// without knowing where the screen came from.

export const DISPLAY_NAME_STORAGE_KEY = 'trussal.displayName.v1';

export const PREJOIN_SCREEN_ID = 'trussal-prejoin-screen';
export const PREJOIN_NAME_INPUT_ID = 'premeeting-name-input';
export const PREJOIN_SCREEN_CLASS = 'premeeting-screen';

// Every selector that marks a pre-meeting screen: Jitsi's own prejoin, the lobby
// knock screen, or Trussal's own prejoin. Two consumers share this one list —
// the suppression rule below (which hides Jitsi's copies while Trussal's is up)
// and meeting-adapter.js's isInMeeting() (a page showing one of these is not yet
// in the meeting). Keeping it in one place stops the two from drifting.
export const PREMEETING_SCREEN_SELECTORS = [
  '.prejoin-screen',
  '.premeeting-screen',
  '[class*="premeeting"]',
  '[class*="prejoin"]',
];
export const PREMEETING_SCREEN_SELECTOR = PREMEETING_SCREEN_SELECTORS.join(', ');

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

// While Trussal's prejoin is up, Jitsi's must not be: two prejoins invite the
// user to click the wrong Join, and Jitsi's would start its own conference. Our
// own root carries the same class as Jitsi's, so it is excluded by id.
export function prejoinSuppressionCss() {
  const not = `:not(#${PREJOIN_SCREEN_ID})`;
  return `${PREMEETING_SCREEN_SELECTORS.map((s) => `${s}${not}`).join(',\n')} { display: none !important; }`;
}

// The overlay's inner markup. The room name is deliberately NOT rendered, for
// the same reason the welcome overlay never renders it (see welcome-page.js):
// nothing here should have to reason about a 1023-character room name, and the
// performer already typed it one screen ago.
//
// Note the inner class names avoid the substrings "prejoin"/"premeeting": the
// suppression rule hides `[class*="prejoin"]`, and the only thing it must spare
// is our root (excluded by id) — an inner class carrying the substring would be
// hidden along with Jitsi's screen.
export function prejoinMarkup({ initialName = '', buttonLabel = 'Join meeting' } = {}) {
  const value = escapeHtml(normaliseDisplayName(initialName));
  const label = escapeHtml(buttonLabel);
  const fieldStyle =
    'padding:0.5rem 0.75rem;border-radius:0.5rem;border:1px solid var(--trussal-secondary, #111111);'
    + 'background:var(--trussal-primary, #eeeeee);color:var(--trussal-secondary, #111111);font:inherit;';
  return `
    <div class="trussal-join-panel" style="
      position: fixed;
      left: 50%;
      top: 40%;
      transform: translate(-50%, -50%);
      background: var(--trussal-primary, #eeeeee);
      padding: 1.5rem 2rem;
      border: 1px solid var(--trussal-secondary, #111111);
      border-radius: 1rem;
      max-width: 480px;
      width: 90%;
      z-index: 9999;
      font-family: var(--trussal-font, Arial, Helvetica, sans-serif);
    ">
      <form class="trussal-join-form" style="display:flex;flex-direction:column;gap:0.75rem;">
        <label for="${PREJOIN_NAME_INPUT_ID}" style="color:var(--trussal-secondary, #111111);font-size:1rem;">
          Display name (optional):
        </label>
        <input id="${PREJOIN_NAME_INPUT_ID}"
               name="displayName"
               type="text"
               autocomplete="off"
               autocapitalize="words"
               autocorrect="off"
               spellcheck="false"
               placeholder="Display name"
               value="${value}"
               style="${fieldStyle}"/>
        <button type="submit" style="
          padding:0.6rem 0.9rem;border-radius:0.5rem;
          border:1px solid var(--trussal-secondary, #111111);
          background:var(--trussal-primary, #eeeeee);color:var(--trussal-secondary, #111111);
          font:inherit;font-weight:600;cursor:pointer;">
          ${label}
        </button>
      </form>
    </div>
  `;
}

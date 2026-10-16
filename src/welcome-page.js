// A typed room name travels three places that each punish a different
// character class: the URL path (`/<room>`), an XMPP MUC localpart (nodeprep
// forbids `"&'/:<>@` and whitespace), and the sidecar's `?room=` query. Rather
// than encode separately for each, accept only characters that are literal in
// all three. The security benefit is that same restriction read from the other
// side: a name that clears this carries neither markup nor a `javascript:`
// scheme, so it stays inert wherever it lands.
//
// 1023 is the XMPP localpart ceiling (RFC 6122/7622 nodeprep), which prosody
// enforces once the room becomes <room>@conference.meet.jitsi. The allowlist is
// ASCII, so one character is one octet. It is NOT a UI limit — nothing in the
// Trussal overlay renders the room name — so don't shorten it thinking it is.
//
// This validates and rejects rather than normalising: silently reshaping
// "My Jam Session!" into "my-jam-session" would land two people who typed
// visibly different names in the same room without telling either of them.
//
// Trussal owns the page: this overlay is the room picker at the site root,
// rendered when the URL names no room. Once a room is chosen the browser
// navigates to `/<room>`, where prejoin.js takes over. Styling lives in
// welcome.css (imported as raw text, injected once) — no inline style
// attributes and nothing injected over native Jitsi.

import { getRoomNameFromUrl } from './get-room-name-from-url.js';
import welcomeStyles from './welcome.css';

export const MAX_ROOM_NAME_LENGTH = 1023;
const ROOM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

const WELCOME_OVERLAY_ID = 'trussal-welcome-overlay';
const STYLE_ID = 'trussal-welcome-style';

export function isValidRoomName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > MAX_ROOM_NAME_LENGTH) return false;
  return ROOM_NAME_RE.test(name);
}

function ensureWelcomeStyle(doc) {
  if (doc.getElementById(STYLE_ID)) return;
  const style = doc.createElement('style');
  style.id = STYLE_ID;
  style.textContent = welcomeStyles;
  (doc.head || doc.body).appendChild(style);
}

function renderTrussalWelcomeOverlay() {
    console.log('[Trussal] renderTrussalWelcomeOverlay() called');

    const body = document.body;
    if (!body) {
      console.log('[Trussal] body missing, aborting');
      return;
    }

    // If we've already inserted our overlay, don't add another one
    if (document.getElementById(WELCOME_OVERLAY_ID)) {
      return;
    }

    ensureWelcomeStyle(document);

    const overlay = document.createElement('div');
    overlay.id = WELCOME_OVERLAY_ID;

    overlay.innerHTML = `
      <div class="trussal-room-panel">
        <form class="trussal-room-form">
          <label class="trussal-room-label" for="trussal-room-input">
            Room name:
          </label>
          <input id="trussal-room-input"
                 type="text"
                 required
                 autocomplete="off"
                 autocapitalize="none"
                 autocorrect="off"
                 spellcheck="false"
                 placeholder="Room name with 1023 characters or fewer"/>
          <button class="trussal-room-button" type="submit">
            Join session
          </button>
          <div id="trussal-room-error"></div>
        </form>
      </div>
    `;

    body.appendChild(overlay);
    console.log('[Trussal] custom welcome overlay injected');

    const form  = overlay.querySelector('form');
    const input = overlay.querySelector('#trussal-room-input');
    const error = overlay.querySelector('#trussal-room-error');

    // Deliberately no input.maxLength: the attribute silently truncates a
    // pasted name, which would send the user to a room named after the first
    // 1023 characters of what they pasted without telling them. Reject long
    // names below instead, for the same reason we reject rather than normalise.
    form.addEventListener('submit', function (e) {
      e.preventDefault();

      const roomName = input.value.trim();

      // Length and character-set failures get distinct messages — a single
      // combined message would blame the character set for a length problem
      // and leave a valid-looking long name unexplained. Both are constants or
      // a number set via textContent, so no typed input reaches markup.
      if (roomName.length > MAX_ROOM_NAME_LENGTH) {
        error.textContent =
          `Room name must be ${MAX_ROOM_NAME_LENGTH} characters or fewer.`;
        error.classList.add('is-visible');
        return;
      }

      if (!isValidRoomName(roomName)) {
        error.textContent =
          'Use letters, numbers, - or _, starting with a letter or number.';
        error.classList.add('is-visible');
        return;
      }

      error.classList.remove('is-visible');

      // Structural, not filtering: origin comes from the browser and the name
      // is percent-encoded into a single path segment, so the target is always
      // same-origin. A "javascript:" scheme cannot be smuggled into a path, and
      // an encoded "/" cannot forge extra segments or an open redirect.
      const url = window.location.origin + '/' + encodeURIComponent(roomName);
      console.log('[Trussal] navigating to room', roomName, '→', url);
      window.location.href = url;
    });
}

// Mount the room picker. It belongs at the site root: once the URL names a room
// the browser is on the prejoin/meeting screen, not here. Bots and the
// aggregator are always pointed straight at a room, so they never see it.
export function renderWelcomeOverlay() {
  const mount = () => {
    if (typeof document === 'undefined' || !document.body) return;
    if (typeof window !== 'undefined' && (window.__trussalIsBot || window.__trussalIsAggregator)) return;
    if (getRoomNameFromUrl()) return; // a room is chosen: prejoin.js owns the screen
    renderTrussalWelcomeOverlay();
  };
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    mount();
  } else {
    window.addEventListener('DOMContentLoaded', mount);
  }
}

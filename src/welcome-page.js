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

// Single source for the join button label: the welcome overlay renders it,
// and patchPrejoinButton renames Jitsi's own "Join meeting" lobby button to
// match. Change it here and both follow.
const JOIN_LABEL = 'Join meeting';

// Live handles for the observers/poll installed below, so a repeated render
// replaces the previous instance instead of stacking duplicates.
let overlayPoll = null;
let prejoinObserver = null;
let recentObserver = null;
let hideObserver = null;

export const MAX_ROOM_NAME_LENGTH = 1023;
const ROOM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isValidRoomName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > MAX_ROOM_NAME_LENGTH) return false;
  return ROOM_NAME_RE.test(name);
}

// welcome-page.css is installed by src/styles.css at boot. The Jitsi patch
// classes at its bottom are needed on the prejoin screen (patchPrejoinButton)
// and the welcome page's Start meeting button (hideStartMeetingButton), not
// only by the overlay.

function renderTrussalWelcomeOverlay() {
    console.log('[Trussal] renderTrussalWelcomeOverlay() called');

    const body = document.body;
    if (!body || !body.classList || !body.classList.contains('welcome-page')) {
      console.log('[Trussal] not on welcome page or body missing, aborting');
      return;
    }

    // If we've already inserted our overlay, don't add another one — but keep
    // its label in sync so a changed JOIN_LABEL shows without clearing a
    // half-typed room name.
    const existing = document.getElementById('trussal-welcome-overlay');
    if (existing) {
      const submit = existing.querySelector('.trw-submit');
      // Only write when the label actually changed. A textContent write is a
      // DOM mutation, and the observer in renderHideStartMeetingButton reacts
      // to any mutation of the document.
      if (submit && submit.textContent !== JOIN_LABEL) submit.textContent = JOIN_LABEL;
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'trussal-welcome-overlay';

    // Simple centered panel; flat grey on the flat-grey welcome page. All
    // styling lives in welcome-page.css (.trw-panel etc).
    overlay.innerHTML = `
      <div class="trw-panel">
        <form class="trussal-room-form">
          <label class="trw-label" for="trussal-room-input">
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
          <button class="trw-submit" type="submit">
            ${JOIN_LABEL}
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
        error.classList.add('trw-visible');
        return;
      }

      if (!isValidRoomName(roomName)) {
        error.textContent =
          'Use letters, numbers, - or _, starting with a letter or number.';
        error.classList.add('trw-visible');
        return;
      }

      error.classList.remove('trw-visible');

      // Structural, not filtering: origin comes from the browser and the name
      // is percent-encoded into a single path segment, so the target is always
      // same-origin. A "javascript:" scheme cannot be smuggled into a path, and
      // an encoded "/" cannot forge extra segments or an open redirect.
      const url = window.location.origin + '/' + encodeURIComponent(roomName);
      console.log('[Trussal] navigating to room', roomName, '→', url);
      window.location.href = url;
    });
}

function startWelcomeOverlayPoll() {
    let tries = 0;
    const maxTries = 40; // ~10 seconds at 250ms

    // Stop the previous poll, if any.
    if (overlayPoll) clearInterval(overlayPoll);

    // Try once immediately. On a hot update the old overlay was just removed
    // and the accept callback calls this synchronously, so the panel comes back
    // without a 250ms gap. On boot this is just the first attempt.
    renderTrussalWelcomeOverlay();

    const timer = setInterval(function () {
      renderTrussalWelcomeOverlay();
      tries += 1;
      if (document.getElementById('trussal-welcome-overlay') || tries >= maxTries) {
        clearInterval(timer);
        console.log('[Trussal] stop polling for welcome overlay, tries =', tries);
      }
    }, 250);
    overlayPoll = timer;
  }

function patchPrejoinButton() {
    // Scope to Jitsi's own prejoin screen. Scanning the whole document used
    // to rename our welcome overlay's button too, and when the lobby hasn't
    // rendered yet there is nothing to patch in the first place.
    const screen = document.querySelector('.premeeting-screen');
    if (!screen) return;

    // Look for any element that currently says "Join meeting" — the prejoin
    // title (h1) and the lobby's Join button ([role="button"]).
    const candidates = Array.from(
      screen.querySelectorAll('h1, button, [role="button"]')
    );

    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      const aria = (el.getAttribute('aria-label') || '').trim();
      // The label this module last applied to this element. Keeping it on the
      // DOM lets a re-render with a new JOIN_LABEL recognise its own previous
      // output and replace it. Without it, an element already reading the old
      // "Join session" would no longer match "Join meeting" and would keep
      // the stale label.
      const applied = el.dataset.trussalJoinLabel;

      // No "already patched" guard: React can re-render the label back to
      // "Join meeting" while the element (and its dataset) survives. Matching
      // Jitsi's text, or our own previous label, is enough.
      if (
        text === 'Join meeting' ||
        aria === 'Join meeting' ||
        // Only a *different* previously-applied label is ours to replace;
        // matching the current JOIN_LABEL here would rewrite the same text
        // forever (a textContent write is itself a mutation).
        (applied && applied !== JOIN_LABEL && (text === applied || aria === applied))
      ) {
        // Write only values that actually change. Assigning textContent
        // replaces the text node and is itself a DOM mutation, so writing
        // the same label re-triggers this observer forever. That is exactly
        // what happens when JOIN_LABEL is Jitsi's own "Join meeting": every
        // candidate matches on every tick, and the callback spins the main
        // thread instead of patching once.
        if (text !== JOIN_LABEL) el.textContent = JOIN_LABEL;
        if (aria !== JOIN_LABEL) el.setAttribute('aria-label', JOIN_LABEL);
        if (applied !== JOIN_LABEL) el.dataset.trussalJoinLabel = JOIN_LABEL;
      }
    }

    // Force the prejoin Join button flat #111. This Jitsi build renders it
    // as `<div class="css-<hash>-actionButton primary" role="button">`
    // (Emotion CSS-in-JS) — NOT the legacy `.action-btn` — and its blue
    // fill comes from an injected <style>, so the appended all.css rule
    // never matched it. The marker class carries the rules with !important
    // (welcome-page.css — the one place Emotion's class styles can't win),
    // re-applied every observer tick (no dataset guard) so a React re-render
    // can't undo it. The `actionButton` label substring is stable across
    // builds.
    const joinBtns = screen.querySelectorAll(
      '[class*="actionButton"], .action-btn'
    );
    for (const btn of joinBtns) {
      // No guard — classList.add is idempotent and this must survive a React
      // re-render that clears the marker class.
      btn.classList.add('trussal-flat-join');
    }

    // The amber "you need to enable microphone and camera access" pill
    // (`css-<hash>-deviceStatus device-status-error`) — flatten it too.
    for (const el of screen.querySelectorAll('[class*="deviceStatus"]')) {
      el.classList.add('trussal-flat-status');
    }
  }

function startPrejoinRender() {
    patchPrejoinButton();

    // React re-renders a lot, so keep re-patching while the lobby is up. The
    // stop signal is the prejoin screen itself: `#largeVideoContainer` is
    // already in the DOM on the prejoin screen, so using it stopped the
    // observer before the lobby had rendered (or after its first re-render)
    // and the "Join meeting" button was left unpatched. Only stop once the
    // screen has been seen and then goes away.
    // Replace the previous observer, if any, so repeated renders don't stack
    // closures that patch the same DOM.
    if (prejoinObserver) prejoinObserver.disconnect();

    let sawPrejoin = false;
    const obs = new MutationObserver(() => {
      const screen = document.querySelector('.premeeting-screen');
      if (screen) {
        sawPrejoin = true;
        patchPrejoinButton();
      } else if (sawPrejoin) {
        obs.disconnect();
      }
    });
    obs.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true,
      characterData: true
    });
    prejoinObserver = obs;
}

function replaceRecentListText() {
    const OLD_TEXT = 'Your recent list is currently empty. Chat with your team and you will find all your recent meetings here.';
    const NEW_TEXT = 'At the moment, your recent list is empty. Organize some sound and your recent sessions will appear here.';

    const body = document.body;
    if (!body || !body.classList.contains('welcome-page')) {
      return;
    }
 
    // Walk all text nodes and replace the string wherever it appears
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
    let node;
 
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.includes(OLD_TEXT)) {
        node.nodeValue = node.nodeValue.replace(OLD_TEXT, NEW_TEXT);
      }
    }
  }
 
function startRecentListTextRender() {
    replaceRecentListText();
 
    // React re-renders the welcome page a lot, so patch on mutations too
    const target = document.documentElement || document.body;
    if (!target) return;
 
    // Replace the previous observer, if any.
    if (recentObserver) recentObserver.disconnect();

    const obs = new MutationObserver(replaceRecentListText);
    obs.observe(target, { childList: true, subtree: true });
    recentObserver = obs;
  }

export function renderPrejoinScreen() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        startPrejoinRender();
      } else {
        window.addEventListener('DOMContentLoaded', startPrejoinRender);
      }
}

export function renderRecentListText() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        startRecentListTextRender();
      } else {
        window.addEventListener('DOMContentLoaded', startRecentListTextRender);
      }
}

export function renderWelcomeOverlay() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        startWelcomeOverlayPoll();
      } else {
        window.addEventListener('DOMContentLoaded', startWelcomeOverlayPoll);
      }
}

function hideStartMeetingButton() {
    // Only touch the welcome page
    if (!document.body.classList.contains('welcome-page')) return;

    const buttons = Array.from(document.querySelectorAll('button'));
    for (const btn of buttons) {
      const txt = (btn.textContent || '').trim().toLowerCase();
      if (txt === 'start meeting') {
        // Hide and disable it so it can't be clicked
        btn.classList.add('trussal-jitsi-hidden');
        btn.disabled = true;
        btn.dataset.trussalHidden = '1';
      }
    }
  }

export function renderHideStartMeetingButton() {
    // Run once on load
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
      hideStartMeetingButton();
    } else {
      window.addEventListener('DOMContentLoaded', hideStartMeetingButton);
    }

    // Replace the previous observer, if any.
    if (hideObserver) hideObserver.disconnect();

    // And again whenever React re-renders the welcome page
    const obs = new MutationObserver(hideStartMeetingButton);
    obs.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });
    hideObserver = obs;
}

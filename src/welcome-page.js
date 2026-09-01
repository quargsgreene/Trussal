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
export const MAX_ROOM_NAME_LENGTH = 1023;
const ROOM_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function isValidRoomName(name) {
  if (typeof name !== 'string') return false;
  if (name.length === 0 || name.length > MAX_ROOM_NAME_LENGTH) return false;
  return ROOM_NAME_RE.test(name);
}

function renderTrussalWelcomeOverlay() {
    console.log('[Trussal] renderTrussalWelcomeOverlay() called');

    const body = document.body;
    if (!body || !body.classList || !body.classList.contains('welcome-page')) {
      console.log('[Trussal] not on welcome page or body missing, aborting');
      return;
    }

    // If we've already inserted our overlay, don't add another one
    if (document.getElementById('trussal-welcome-overlay')) {
      return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'trussal-welcome-overlay';

    // Simple centered panel; flat grey on the flat-grey welcome page.
    overlay.innerHTML = `
      <style>
        /* Placeholder text is #111 like the rest of the palette — browsers
           otherwise render it at a reduced default opacity. custom.css
           carries the same rule for a rebuilt web image. */
        #trussal-welcome-overlay #trussal-room-input::placeholder {
          color: #111111;
          opacity: 1;
        }
      </style>
      <div style="
        position: fixed;
        left: 50%;
        top: 40%;
        transform: translate(-50%, -50%);
        background: #eeeeee;
        padding: 1.5rem 2rem;
        border: 1px solid #111111;
        border-radius: 1rem;
        max-width: 480px;
        width: 90%;
        z-index: 9999;
        font-family: Arial, Helvetica, sans-serif;
      ">
        <form class="trussal-room-form"
              style="display:flex;flex-direction:column;gap:0.75rem;">
          <label for="trussal-room-input"
                 style="color:#111111;font-size:1rem;">
            Room name:
          </label>
          <input id="trussal-room-input"
                 type="text"
                 required
                 autocomplete="off"
                 autocapitalize="none"
                 autocorrect="off"
                 spellcheck="false"
                 placeholder="Room name with 1023 characters or fewer"
                 style="padding:0.5rem 0.75rem;border-radius:0.5rem;
                        border:1px solid #111111;
                        background:#eeeeee;
                        color:#111111;"/>
          <button type="submit"
                  style="padding:0.6rem 0.9rem;border-radius:0.5rem;
                         border:1px solid #111111;background:#eeeeee;color:#111111;
                         font-weight:600;cursor:pointer;">
            Join session
          </button>
          <div id="trussal-room-error"
               style="display:none;color:#111111;font-size:0.85rem;"></div>
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
        error.style.display = 'block';
        return;
      }

      if (!isValidRoomName(roomName)) {
        error.textContent =
          'Use letters, numbers, - or _, starting with a letter or number.';
        error.style.display = 'block';
        return;
      }

      error.style.display = 'none';

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

    const timer = setInterval(function () {
      renderTrussalWelcomeOverlay();
      tries += 1;
      if (document.getElementById('trussal-welcome-overlay') || tries >= maxTries) {
        clearInterval(timer);
        console.log('[Trussal] stop polling for welcome overlay, tries =', tries);
      }
    }, 250);
  }

function patchPrejoinButton() {
    // Look for any button that currently says "Join meeting"
    const candidates = Array.from(
      document.querySelectorAll('button, [role="button"]')
    );

    let allCandidates = Array.from(
      document.querySelectorAll('h1')
   );

    allCandidates.push(...candidates);


    for (const el of allCandidates) {
      if (el.dataset.trussalJoinPatched === '1') continue;

      const text = (el.textContent || '').trim();
      const aria = (el.getAttribute('aria-label') || '').trim();

      if (text === 'Join meeting' || aria === 'Join meeting') {
        const newLabel = 'Join session'; // <- put your text here
        el.textContent = newLabel;
        el.setAttribute('aria-label', newLabel);
        el.dataset.trussalJoinPatched = '1';
      }
    }

    // Force the prejoin Join button flat #111. This Jitsi build renders it
    // as `<div class="css-<hash>-actionButton primary" role="button">`
    // (Emotion CSS-in-JS) — NOT the legacy `.action-btn` — and its blue
    // fill comes from an injected <style>, so the appended all.css rule
    // never matched it. Set it inline with !important (the one place
    // Emotion's class styles can't win), re-applied every observer tick
    // (no dataset guard) so a React re-render can't undo it. The
    // `actionButton` label substring is stable across builds.
    const joinBtns = document.querySelectorAll(
      '[class*="actionButton"], .action-btn, .premeeting-screen [class*="actionButton"]'
    );
    for (const btn of joinBtns) {
      // No guard — setProperty is idempotent and this must survive a React
      // re-render that clears the inline style.
      btn.style.setProperty('background', '#111111', 'important');
      btn.style.setProperty('background-color', '#111111', 'important');
      btn.style.setProperty('color', '#eeeeee', 'important');
      btn.style.setProperty('border', '1px solid #111111', 'important');
      btn.querySelectorAll('*').forEach((c) => c.style.setProperty('color', '#eeeeee', 'important'));
      btn.querySelectorAll('svg').forEach((svg) =>
        svg.style.setProperty('fill', '#eeeeee', 'important')
      );
    }

    // The amber "you need to enable microphone and camera access" pill
    // (`css-<hash>-deviceStatus device-status-error`) — flatten it too.
    for (const el of document.querySelectorAll('[class*="deviceStatus"]')) {
      el.style.setProperty('background', '#eeeeee', 'important');
      el.style.setProperty('background-color', '#eeeeee', 'important');
      el.style.setProperty('color', '#111111', 'important');
      el.style.setProperty('border', '1px solid #111111', 'important');
    }
  }

function startPrejoinRender() {
    patchPrejoinButton();

    // React re-renders a lot, so keep re-patching when DOM changes. The prejoin
    // screen can never come back once the meeting itself has mounted, so stop
    // scanning the whole document on every mutation the moment that happens —
    // otherwise this runs for the rest of the session for no purpose.
    const obs = new MutationObserver(() => {
      if (document.getElementById('largeVideoContainer')) { obs.disconnect(); return; }
      patchPrejoinButton();
    });
    obs.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });

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
 
    const obs = new MutationObserver(replaceRecentListText);
    obs.observe(target, { childList: true, subtree: true });
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
        btn.style.display = 'none';
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

    // And again whenever React re-renders the welcome page
    const obs = new MutationObserver(hideStartMeetingButton);
    obs.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });
}

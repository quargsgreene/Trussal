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

    // Simple centered panel; background transparent so your themed page shows through
    overlay.innerHTML = `
      <div style="
        position: fixed;
        left: 50%;
        top: 40%;
        transform: translate(-50%, -50%);
        background: rgba(0, 0, 0, 0.75);
        padding: 1.5rem 2rem;
        border-radius: 1rem;
        max-width: 480px;
        width: 90%;
        z-index: 9999;
        box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      ">
        <form class="trussal-room-form"
              style="display:flex;flex-direction:column;gap:0.75rem;">
          <label for="trussal-room-input"
                 style="color:#ffffff;font-size:1rem;">
            Choose a room:
          </label>
          <input id="trussal-room-input"
                 type="number"
                 min="0"
                 max="10"
                 required
                 placeholder="0"
                 style="padding:0.5rem 0.75rem;border-radius:0.5rem;
                        border:1px solid rgba(255,255,255,0.4);
                        background:rgba(0,0,0,0.35);
                        color:#ffffff;"/>
          <button type="submit"
                  style="padding:0.6rem 0.9rem;border-radius:0.5rem;
                         border:none;background:#0f5132;color:#ffffff;
                         font-weight:600;cursor:pointer;">
            Join session
          </button>
          <div id="trussal-room-error"
               style="display:none;color:#ffb3b3;font-size:0.85rem;"></div>
        </form>
      </div>
    `;

    body.appendChild(overlay);
    console.log('[Trussal] custom welcome overlay injected');

    const form  = overlay.querySelector('form');
    const input = overlay.querySelector('#trussal-room-input');
    const error = overlay.querySelector('#trussal-room-error');

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      const value = input.value.trim();
      const n = Number(value);

      if (!Number.isInteger(n) || n < 0 || n > 10) {
        error.textContent = 'Please enter a whole number between 0 and 10.';
        error.style.display = 'block';
        return;
      }

      error.style.display = 'none';
      const roomName = String(n);

      const url = window.location.origin + '/' + encodeURIComponent(roomName);
      console.log('[Trussal] navigating to room', roomName, '→', url);
      window.location.href = url;
    });
}

function startWelcomeOverlayPoll() {
    let tries = 0;
    const maxTries = 40; // ~10 seconds at 250ms

    const timer = setInterval(function () {
      // renderTrussalWelcomeOverlay();
      tries += 1;
      if (document.getElementById('trussal-welcome-overlay') || tries >= maxTries) {
        clearInterval(timer);
        console.log('[Trussal] stop polling for welcome overlay, tries =', tries);
      }
    }, 250);
  }

export default function renderAndPollWelcomePage() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        // startWelcomeOverlayPoll();
      } else {
        window.addEventListener('DOMContentLoaded', startWelcomeOverlayPoll);
      }
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
  }

function startPrejoinRender() {
    patchPrejoinButton();

    // React re-renders a lot, so keep re-patching when DOM changes
    const obs = new MutationObserver(patchPrejoinButton);
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

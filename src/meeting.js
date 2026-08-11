import { subscribeParticipants } from './participants.js';

function removeNoAudioToast() {
    const TITLE_SNIPPET = 'You joined with no audio output';
    const candidates = document.querySelectorAll(
      '.notification, [class*="notification"], [role="alert"]'
    );

    candidates.forEach(el => {
      if (el.dataset.trussalToastKilled === '1') return;

      const txt = (el.textContent || '').trim();
      if (txt.includes(TITLE_SNIPPET)) {
        el.dataset.trussalToastKilled = '1';
        el.remove();
      }
    });
  }

  // The toast is a one-shot warning tied to having just joined with no audio
  // output device — nothing shows it again later in the session, so bound how
  // long the observer scans the whole document on every mutation rather than
  // running the [class*="notification"] wildcard match for the rest of the call.
  const NO_AUDIO_TOAST_WINDOW_MS = 20_000;

  function startNoAudioToastRender() {
    // One immediate pass
    removeNoAudioToast();

    // Watch for future notifications (React re-renders, etc.)
    const obs = new MutationObserver(removeNoAudioToast);
    obs.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => obs.disconnect(), NO_AUDIO_TOAST_WINDOW_MS);
  }

  export function renderNoAudioToast() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        startNoAudioToastRender();
      } else {
        window.addEventListener('DOMContentLoaded', startNoAudioToastRender);
      }
  }

// A personal "Leave" and the moderator's "End meeting for all" both funnel
// through the same Jitsi-level local departure participants.js already
// detects (readLocal() failing once APP.conference is torn down) — there is
// no reliable, stable way to tell the two apart from the client's polling
// vantage point (see CLAUDE.md: Jitsi's internal event API is unstable,
// which is why this codebase polls instead of listening for it directly).
// Jitsi's own default post-call screen would otherwise leave the tab
// stranded there; send it straight back to the Trussal lobby (the
// welcome-page overlay lives at the site root) so the same room can be
// rejoined fresh. Bots and the aggregator don't need this — their container
// is torn down right along with the departure, so there's no page left to
// navigate.
export function renderReturnToLobbyOnMeetingEnd() {
  if (window.__trussalIsBot || window.__trussalIsAggregator) return;
  subscribeParticipants((event) => {
    if (event === 'local-leave') window.location.href = `${window.location.origin}/`;
  });
}


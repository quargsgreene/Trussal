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

  function startNoAudioToastRender() {
    // One immediate pass
    removeNoAudioToast();

    // Watch for future notifications (React re-renders, etc.)
    const obs = new MutationObserver(removeNoAudioToast);
    obs.observe(document.body, { childList: true, subtree: true });
  }

  export function renderNoAudioToast() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        startNoAudioToastRender();
      } else {
        window.addEventListener('DOMContentLoaded', startNoAudioToastRender);
      }
  }


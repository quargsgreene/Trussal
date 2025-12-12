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

export function renderPrejoinScreen() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        startPrejoinRender();
      } else {
        window.addEventListener('DOMContentLoaded', startPrejoinRender);
      }
}

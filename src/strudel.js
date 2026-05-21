/*export const STRUDEL_URL = 'https://strudel.cc/#c2V0Y3BzKDEpCm4oIjwwIDEgMiAzIDQ%2BKjgiKS5zY2FsZSgnRzQgbWlub3InKQoucygiZ21fbGVhZF82X3ZvaWNlIikKLmNsaXAoc2luZS5yYW5nZSguMiwuOCkuc2xvdyg4KSkKLmp1eChyZXYpCi5yb29tKDIpCi5zb21ldGltZXMoYWRkKG5vdGUoIjEyIikpKQoubHBmKHBlcmxpbi5yYW5nZSgyMDAsMjAwMDApLnNsb3coNCkp';
*/
export const STRUDEL_URL = "https://strudel.cc/?xwWRfuCE8TAR";
export const  TILE_SELECTORS = [
    '#largeVideoContainer',
    '.videocontainer',
    '[id^="participant_"]',
    '#localVideoContainer'
  ];

  function initTrussalUI() {
    console.log("🚀 [Trussal Engine] Jitsi DOM detected. Mounting custom UI layers...");
      
      const styleOverride = document.createElement('style');
      styleOverride.textContent = `      
	.strudel-overlay-container, #strudel-grid, .custom-trussal-ui {
		width: 25vw;
		height: 25vh;
		opacity: 1 !important;
		top: 0 !important;
		left: 0 !important;
		right: 0 !important;
		bottom: 0 ! important;
		visibility: visible !important;
		display: block !important;
		position: fixed !important;
		z-index: 999999 !important;
		background-color: rgba(255, 0, 0, 0.3) !important;
	}

	.strudel-overlay-contaier button,
	.strudel-overlay-container textarea,
	.strudel-overlay-container input,
	.strudel-overlay-container .strudel-repl,
	.strudel-overlay-container a,
	.custom-trussal-ui-element {
	   pointer-events: auto !important;
	}
      `;
	
      document.head.appendChild(styleOverride);      

     /* const myOverlay = document.createElement('div');
      myOverlay.className = 'strudel-overlay-container';
      document.body.appendChild(myOverlay);
     */
      const myIframeOverlay = document.createElement('iframe');
      myIframeOverlay.src = STRUDEL_URL;
      myIframeOverlay.className = 'strudel-overlay-container';
      document.body.appendChild(myIframeOverlay);

      function isVideoTile(el) {
        if (!el) return false;
        // must contain a <video> element to count
        return !!el.querySelector('video');
      }
    
        function attachStrudelToTile(tile) {
        const rect = tile.getBoundingClientRect();
        if (rect.width < 200 || rect.height < 150) return; // skip tiny tiles
        if (!tile || tile.dataset.trussalStrudel === '1') return;
        if (!isVideoTile(tile)) return;

        tile.dataset.trussalStrudel = '1';

        // Give it a class so our CSS can make it a positioning context
        tile.classList.add('trussal-video-host');

        // Create iframe
        const iframe = document.createElement('iframe');
        iframe.src = STRUDEL_URL;
        iframe.className = 'trussal-strudel-frame';
        iframe.title = 'Strudel live-coding editor';
        iframe.setAttribute('allow', 'autoplay; clipboard-write');

        // Append as last child so it sits on top of the video
        tile.appendChild(iframe);
      }

      function scanAndAttach() {
        const selector = TILE_SELECTORS.join(',');
        const tiles = document.querySelectorAll(selector);
        tiles.forEach(attachStrudelToTile);

      }

      function startStrudelOverlayRender() {
        console.log('[Trussal] Strudel overlay init');
        scanAndAttach();

        // 1) Periodic scan to catch layout changes
        setInterval(scanAndAttach, 2000);

        // 2) React/DOM re-render watcher for new tiles
        const target = document.body || document.documentElement;
        if (!target) return;

        const obs = new MutationObserver(scanAndAttach);
        obs.observe(target, { childList: true, subtree: true });
      }

      function renderStrudelOverlay() {
            if (document.readyState === 'complete' || document.readyState === 'interactive') {
                startStrudelOverlayRender();
            } else {
                window.addEventListener('DOMContentLoaded', startStrudelOverlayRender);
            }
  }

      
}

const waitForJitsiUI = setInterval(() => {
    // Check if Jitsi's video interface layout has loaded on screen yet
    const jitsiContainer = document.getElementById('videospace') || document.querySelector('.videoconference-layout');
	
    const isPrejoinActive = document.getElementById('preview');
    if (jitsiContainer && !isPrejoinActive) {
        clearInterval(waitForJitsiUI);
        initTrussalUI(); // Safe to fire now!
    }
}, 200);

// 4. Keep all your exports at the very bottom, out in the open (completely fine)
export default { initTrussalUI };

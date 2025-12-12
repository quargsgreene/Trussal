export const STRUDEL_URL = 'https://strudel.cc/#c2V0Y3BzKDEpCm4oIjwwIDEgMiAzIDQ%2BKjgiKS5zY2FsZSgnRzQgbWlub3InKQoucygiZ21fbGVhZF82X3ZvaWNlIikKLmNsaXAoc2luZS5yYW5nZSguMiwuOCkuc2xvdyg4KSkKLmp1eChyZXYpCi5yb29tKDIpCi5zb21ldGltZXMoYWRkKG5vdGUoIjEyIikpKQoubHBmKHBlcmxpbi5yYW5nZSgyMDAsMjAwMDApLnNsb3coNCkp';

export const  TILE_SELECTORS = [
    '#largeVideoContainer',
    '.videocontainer',
    '[id^="participant_"]',
    '#localVideoContainer'
  ];

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

  export default function renderStrudelOverlay() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        startStrudelOverlayRender();
      } else {
        window.addEventListener('DOMContentLoaded', startStrudelOverlayRender);
      }
  }

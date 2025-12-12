export const JAMULUS_ROOM_MAP = {
  "0":  { host: "jamulus.trussal.com", port: 22000 },
  "1":  { host: "jamulus.trussal.com", port: 22001 },
  "2":  { host: "jamulus.trussal.com", port: 22002 },
  "3":  { host: "jamulus.trussal.com", port: 22003 },
  "4":  { host: "jamulus.trussal.com", port: 22004 },
  "5":  { host: "jamulus.trussal.com", port: 22005 },
  "6":  { host: "jamulus.trussal.com", port: 22006 },
  "7":  { host: "jamulus.trussal.com", port: 22007 },
  "8":  { host: "jamulus.trussal.com", port: 22008 },
  "9":  { host: "jamulus.trussal.com", port: 22009 },
  "10": { host: "jamulus.trussal.com", port: 22010 }
};

function addJamulusWelcomePanel() {
    const body = document.body;
    if (!body || !body.classList || !body.classList.contains('welcome-page')) {
      return;
    }

    if (document.getElementById('jamulus-welcome-panel')) return;

    const container =
      document.querySelector('#welcome_page .welcome-page-content') ||
      document.querySelector('.welcome-page-content');

    if (!container) return;

    const panel = document.createElement('div');
    panel.id = 'jamulus-welcome-panel';
    panel.className = 'jamulus-panel';

    const items = Object.entries(JAMULUS_ROOM_MAP)
      .map(([room, info]) =>
        `<li><strong>${room}</strong> → ${info.host}:${info.port}</li>`
      )
      .join('');

    panel.innerHTML = `
      <h3>Jamulus rooms</h3>
      <p>These meeting links have dedicated Jamulus servers:</p>
      <ul>${items}</ul>
    `;

    container.prepend(panel);
}

function startJamulusBannerPolling() {
    attachJamulusBanner();
    setInterval(attachJamulusBanner, 3000);
  }

function attachJamulusBanner() {
    const room = getRoomNameFromUrl();
    if (!room) return;

    const mapping = window.JAMULUS_ROOM_MAP || {};
    const entry = mapping[room];

    if (!entry) return;
    if (document.getElementById('jamulus-info-banner')) return;

    const banner = document.createElement('div');
    banner.id = 'jamulus-info-banner';
    banner.textContent =
      `Jamulus: ${entry.host}:${entry.port} (for low-latency audio)`;

    Object.assign(banner.style, {
      position: 'absolute',
      bottom: '10px',
      right: '10px',
      zIndex: 9999,
      background: 'rgba(0, 0, 0, 0.7)',
      color: '#fff',
      padding: '8px 12px',
      borderRadius: '4px',
      fontFamily: 'sans-serif',
      fontSize: '12px'
    }); 
    document.body.appendChild(banner);
  }

function startJamulusWelcomePanel() {
  addJamulusWelcomePanel();
  }

export function getRoomNameFromUrl() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    const roomName = parts.length ? parts[parts.length - 1] : null;
    return roomName;
  }

export function renderJamulusWelcomePanelAndBanner() {
  const mapping = window.JAMULUS_ROOM_MAP || {};
  if (!Object.keys(mapping).length) {
    return;
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    startJamulusWelcomePanel();
    startJamulusBannerPolling();
  } else {
    window.addEventListener('DOMContentLoaded', startJamulusWelcomePanel);
    window.addEventListener('DOMContentLoaded', startJamulusBannerPolling);
  }
}

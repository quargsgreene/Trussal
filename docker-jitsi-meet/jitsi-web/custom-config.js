console.log('TRUSSAL custom-config.js loaded on', window.location.href);
// Static Jamulus mapping: Jitsi room -> Jamulus host/port
window.JAMULUS_ROOM_MAP = {
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
}

// Patch the "recent list is currently empty" text and styling on the welcome page
(function () {
  function patchRecentEmpty() {
    if (!document.body.classList.contains('welcome-page')) return;

    const candidates = document.querySelectorAll('.welcome-page-content *');
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      if (!text) continue;

      if (text.indexOf('Your recent list is currently empty') !== -1) {
        // Change the message
        el.textContent = 'Organize some sound. Your recent sessions will show up here.';

        // Style it
        el.style.color = '#00ff5a';
        el.style.background = '#0f5132';
        el.style.padding = '0.3rem 0.6rem';
        el.style.borderRadius = '0.25rem';
        el.style.display = 'inline-block';

        break;
      }
    }
  }

  // Run a few times to catch React rendering
  let tries = 0;
  const timer = setInterval(function () {
    patchRecentEmpty();
    tries++;
    if (tries > 20) clearInterval(timer);
  }, 250);
})();

// Turn off generator at the source, if these globals exist
if (typeof interfaceConfig !== 'undefined') {
  interfaceConfig.GENERATE_ROOMNAMES_ON_WELCOME_PAGE = false;
  interfaceConfig.ENABLE_WELCOME_PAGE_RANDOM_ROOM_NAME = false;
}
if (typeof config !== 'undefined') {
  config.enableWelcomePageRandomRoomName = false;
}
// ./jitsi-web/custom-config.js

(function () {
  function installTrussalRoomField() {
    // Find the real (now hidden) field
    var original = document.querySelector('#enter_room_field');
    if (!original) return;

    // Avoid installing twice
    if (document.getElementById('trussal-room-field')) return;

    // Find a parent we can append our field into
    var container = original.closest('form') || original.parentElement || document.body;

    // Create our visible input
    var input = document.createElement('input');
    input.id = 'trussal-room-field';
    input.type = 'text';
    input.autocomplete = 'off';
    input.placeholder = 'Enter a number between 0 and 10 inclusive.';
    input.className = original.className; // reuse Jitsi styles

    // Copy what the user types into the real hidden field
    input.addEventListener('input', function () {
      original.value = input.value;
      var ev = new Event('input', { bubbles: true });
      original.dispatchEvent(ev);
    });

    // Pressing Enter on our field should behave like Jitsi's original
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') {
        e.preventDefault();
        original.form && original.form.dispatchEvent(
          new Event('submit', { bubbles: true, cancelable: true })
        );
      }
    });

    // Insert our field where the original was visually
    container.appendChild(input);
  }

  function onReady() {
    installTrussalRoomField();
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    onReady();
  } else {
    window.addEventListener('DOMContentLoaded', onReady);
  }
})();

// ---- Keep welcome room input empty until user types ----
(function () {
  function findRoomInput() {
    var candidates = Array.from(document.querySelectorAll('input'));
    return candidates.find(function (el) {
      var ph = (el.getAttribute('placeholder') || '').toLowerCase();
      var aria = (el.getAttribute('aria-label') || '').toLowerCase();
      return (
        ph.includes('meeting') ||
        ph.includes('room') ||
        aria.includes('meeting') ||
        aria.includes('room')
      );
    }) || null;
  }

  function patchRoomInput(input) {
    if (!input || input.dataset.trussalPatched === '1') return;
    input.dataset.trussalPatched = '1';

    input.addEventListener('input', function () {
      input.dataset.trussalUserTyped = '1';
    });

    function clearIfAuto() {
      if (!input) return;
      if (input.dataset.trussalUserTyped === '1') return; // user has typed

      if (input.value && input.value.length > 0) {
        input.value = '';
        var ev = new Event('input', { bubbles: true });
        input.dispatchEvent(ev);
      }
    }

    var tries = 0;
    var timer = setInterval(function () {
      clearIfAuto();
      tries++;
      if (tries > 60) { // ~9 seconds
        clearInterval(timer);
      }
    }, 150);
  }

  function scanAndPatch() {
    var input = findRoomInput();
    if (input) patchRoomInput(input);
  }

  // On load
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    scanAndPatch();
  } else {
    window.addEventListener('DOMContentLoaded', scanAndPatch);
  }

  // And on any DOM changes (React re-renders)
  var obs = new MutationObserver(scanAndPatch);
  obs.observe(document.documentElement || document.body, {
    childList: true,
    subtree: true
  });
})();

console.log("[Jamulus] custom-config.js loaded");
console.log("[Jamulus] map keys:", Object.keys(window.JAMULUS_ROOM_MAP || {}));
(function () {
  const mapping = window.JAMULUS_ROOM_MAP || {};
  if (!Object.keys(mapping).length) {
    return;
  }

  function addJamulusWelcomePanel() {
    if (!document.body.classList.contains('welcome-page')) return;
    if (document.getElementById('jamulus-welcome-panel')) return;

    const container = document.querySelector('#welcome_page .welcome-page-content');
    if (!container) return;

    const panel = document.createElement('div');
    panel.id = 'jamulus-welcome-panel';
    panel.className = 'jamulus-panel';

    const items = Object.entries(mapping)
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

  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    addJamulusWelcomePanel();
  } else {
    window.addEventListener('DOMContentLoaded', addJamulusWelcomePanel);
  }
})();

// Banner logic
(function () {
  function getRoomName() {
    const parts = window.location.pathname.split("/").filter(Boolean);
    const roomName = parts.length ? parts[parts.length - 1] : null;
    console.log("[Jamulus] roomName from URL:", roomName);
    return roomName;
  }

  function attachJamulusBanner() {
    const room = getRoomName();
    if (!room) return;

    const mapping = window.JAMULUS_ROOM_MAP || {};
    const entry = mapping[room];
    console.log("[Jamulus] mapping lookup:", room, "=>", entry);

    if (!entry) return;

    if (document.getElementById("jamulus-info-banner")) return;

    const banner = document.createElement("div");
    banner.id = "jamulus-info-banner";
    banner.textContent =
      `Jamulus: ${entry.host}:${entry.port} (for low-latency audio)`;

    Object.assign(banner.style, {
      position: "absolute",
      bottom: "10px",
      right: "10px",
      zIndex: 9999,
      background: "rgba(0, 0, 0, 0.7)",
      color: "#fff",
      padding: "8px 12px",
      borderRadius: "4px",
      fontFamily: "sans-serif",
      fontSize: "12px",
    });

    console.log("[Jamulus] attaching banner");
    document.body.appendChild(banner);
  }

  // Jitsi is a SPA and can re-render the DOM; poll a bit to be safe
  function startPolling() {
    attachJamulusBanner();
    setInterval(attachJamulusBanner, 3000);
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    startPolling();
  } else {
    window.addEventListener("DOMContentLoaded", startPolling);
  }
})();

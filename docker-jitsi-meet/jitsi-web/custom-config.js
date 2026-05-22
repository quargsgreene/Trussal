(() => {
  // src/jamulus.js
  var JAMULUS_ROOM_MAP = {
    "0": { host: "jamulus.trussal.com", port: 22e3 },
    "1": { host: "jamulus.trussal.com", port: 22001 },
    "2": { host: "jamulus.trussal.com", port: 22002 },
    "3": { host: "jamulus.trussal.com", port: 22003 },
    "4": { host: "jamulus.trussal.com", port: 22004 },
    "5": { host: "jamulus.trussal.com", port: 22005 },
    "6": { host: "jamulus.trussal.com", port: 22006 },
    "7": { host: "jamulus.trussal.com", port: 22007 },
    "8": { host: "jamulus.trussal.com", port: 22008 },
    "9": { host: "jamulus.trussal.com", port: 22009 },
    "10": { host: "jamulus.trussal.com", port: 22010 }
  };
  function addJamulusWelcomePanel() {
    const body = document.body;
    if (!body || !body.classList || !body.classList.contains("welcome-page")) {
      return;
    }
    if (document.getElementById("jamulus-welcome-panel")) return;
    const container = document.querySelector("#welcome_page .welcome-page-content") || document.querySelector(".welcome-page-content");
    if (!container) return;
    const panel = document.createElement("div");
    panel.id = "jamulus-welcome-panel";
    panel.className = "jamulus-panel";
    const items = Object.entries(JAMULUS_ROOM_MAP).map(
      ([room, info]) => `<li><strong>${room}</strong> \u2192 ${info.host}:${info.port}</li>`
    ).join("");
    panel.innerHTML = `
      <h3>Jamulus rooms</h3>
      <p>These meeting links have dedicated Jamulus servers:</p>
      <ul>${items}</ul>
    `;
    container.prepend(panel);
  }
  function startJamulusBannerPolling() {
    attachJamulusBanner();
    setInterval(attachJamulusBanner, 3e3);
  }
  function attachJamulusBanner() {
    const room = getRoomNameFromUrl();
    if (!room) return;
    const mapping = window.JAMULUS_ROOM_MAP || {};
    const entry = mapping[room];
    if (!entry) return;
    if (document.getElementById("jamulus-info-banner")) return;
    const banner = document.createElement("div");
    banner.id = "jamulus-info-banner";
    banner.textContent = `Jamulus: ${entry.host}:${entry.port} (for low-latency audio)`;
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
      fontSize: "12px"
    });
    document.body.appendChild(banner);
  }
  function startJamulusWelcomePanel() {
    addJamulusWelcomePanel();
  }
  function getRoomNameFromUrl() {
    const parts = window.location.pathname.split("/").filter(Boolean);
    const roomName = parts.length ? parts[parts.length - 1] : null;
    return roomName;
  }
  function renderJamulusWelcomePanelAndBanner() {
    const mapping = window.JAMULUS_ROOM_MAP || {};
    if (!Object.keys(mapping).length) {
      return;
    }
    if (document.readyState === "complete" || document.readyState === "interactive") {
      startJamulusWelcomePanel();
      startJamulusBannerPolling();
    } else {
      window.addEventListener("DOMContentLoaded", startJamulusWelcomePanel);
      window.addEventListener("DOMContentLoaded", startJamulusBannerPolling);
    }
  }

  // src/welcome-page.js
  function renderTrussalWelcomeOverlay() {
    console.log("[Trussal] renderTrussalWelcomeOverlay() called");
    const body = document.body;
    if (!body || !body.classList || !body.classList.contains("welcome-page")) {
      console.log("[Trussal] not on welcome page or body missing, aborting");
      return;
    }
    if (document.getElementById("trussal-welcome-overlay")) {
      return;
    }
    const overlay = document.createElement("div");
    overlay.id = "trussal-welcome-overlay";
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
    console.log("[Trussal] custom welcome overlay injected");
    const form = overlay.querySelector("form");
    const input = overlay.querySelector("#trussal-room-input");
    const error = overlay.querySelector("#trussal-room-error");
    form.addEventListener("submit", function(e) {
      e.preventDefault();
      const value = input.value.trim();
      const n = Number(value);
      if (!Number.isInteger(n) || n < 0 || n > 10) {
        error.textContent = "Please enter a whole number between 0 and 10.";
        error.style.display = "block";
        return;
      }
      error.style.display = "none";
      const roomName = String(n);
      const url = window.location.origin + "/" + encodeURIComponent(roomName);
      console.log("[Trussal] navigating to room", roomName, "\u2192", url);
      window.location.href = url;
    });
  }
  function startWelcomeOverlayPoll() {
    let tries = 0;
    const maxTries = 40;
    const timer = setInterval(function() {
      renderTrussalWelcomeOverlay();
      tries += 1;
      if (document.getElementById("trussal-welcome-overlay") || tries >= maxTries) {
        clearInterval(timer);
        console.log("[Trussal] stop polling for welcome overlay, tries =", tries);
      }
    }, 250);
  }
  function patchPrejoinButton() {
    const candidates = Array.from(
      document.querySelectorAll('button, [role="button"]')
    );
    let allCandidates = Array.from(
      document.querySelectorAll("h1")
    );
    allCandidates.push(...candidates);
    for (const el of allCandidates) {
      if (el.dataset.trussalJoinPatched === "1") continue;
      const text = (el.textContent || "").trim();
      const aria = (el.getAttribute("aria-label") || "").trim();
      if (text === "Join meeting" || aria === "Join meeting") {
        const newLabel = "Join session";
        el.textContent = newLabel;
        el.setAttribute("aria-label", newLabel);
        el.dataset.trussalJoinPatched = "1";
      }
    }
  }
  function startPrejoinRender() {
    patchPrejoinButton();
    const obs = new MutationObserver(patchPrejoinButton);
    obs.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });
  }
  function replaceRecentListText() {
    const OLD_TEXT = "Your recent list is currently empty. Chat with your team and you will find all your recent meetings here.";
    const NEW_TEXT = "At the moment, your recent list is empty. Organize some sound and your recent sessions will appear here.";
    const body = document.body;
    if (!body || !body.classList.contains("welcome-page")) {
      return;
    }
    const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
    let node;
    while (node = walker.nextNode()) {
      if (node.nodeValue && node.nodeValue.includes(OLD_TEXT)) {
        node.nodeValue = node.nodeValue.replace(OLD_TEXT, NEW_TEXT);
      }
    }
  }
  function startRecentListTextRender() {
    replaceRecentListText();
    const target = document.documentElement || document.body;
    if (!target) return;
    const obs = new MutationObserver(replaceRecentListText);
    obs.observe(target, { childList: true, subtree: true });
  }
  function renderPrejoinScreen() {
    if (document.readyState === "complete" || document.readyState === "interactive") {
      startPrejoinRender();
    } else {
      window.addEventListener("DOMContentLoaded", startPrejoinRender);
    }
  }
  function renderRecentListText() {
    if (document.readyState === "complete" || document.readyState === "interactive") {
      startRecentListTextRender();
    } else {
      window.addEventListener("DOMContentLoaded", startRecentListTextRender);
    }
  }
  function renderWelcomeOverlay() {
    if (document.readyState === "complete" || document.readyState === "interactive") {
      startWelcomeOverlayPoll();
    } else {
      window.addEventListener("DOMContentLoaded", startWelcomeOverlayPoll);
    }
  }
  function hideStartMeetingButton() {
    if (!document.body.classList.contains("welcome-page")) return;
    const buttons = Array.from(document.querySelectorAll("button"));
    for (const btn of buttons) {
      const txt = (btn.textContent || "").trim().toLowerCase();
      if (txt === "start meeting") {
        btn.style.display = "none";
        btn.disabled = true;
        btn.dataset.trussalHidden = "1";
      }
    }
  }
  function renderHideStartMeetingButton() {
    if (document.readyState === "complete" || document.readyState === "interactive") {
      hideStartMeetingButton();
    } else {
      window.addEventListener("DOMContentLoaded", hideStartMeetingButton);
    }
    const obs = new MutationObserver(hideStartMeetingButton);
    obs.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });
  }

  // src/meeting.js
  function removeNoAudioToast() {
    const TITLE_SNIPPET = "You joined with no audio output";
    const candidates = document.querySelectorAll(
      '.notification, [class*="notification"], [role="alert"]'
    );
    candidates.forEach((el) => {
      if (el.dataset.trussalToastKilled === "1") return;
      const txt = (el.textContent || "").trim();
      if (txt.includes(TITLE_SNIPPET)) {
        el.dataset.trussalToastKilled = "1";
        el.remove();
      }
    });
  }
  function startNoAudioToastRender() {
    removeNoAudioToast();
    const obs = new MutationObserver(removeNoAudioToast);
    obs.observe(document.body, { childList: true, subtree: true });
  }
  function renderNoAudioToast() {
    if (document.readyState === "complete" || document.readyState === "interactive") {
      startNoAudioToastRender();
    } else {
      window.addEventListener("DOMContentLoaded", startNoAudioToastRender);
    }
  }

  // src/strudel.js
  var STRUDEL_URL = "https://strudel.cc/?xwWRfuCE8TAR";
  var TILE_SELECTORS = [
    "#largeVideoContainer",
    ".videocontainer",
    '[id^="participant_"]',
    "#localVideoContainer"
  ];
  function initTrussalUI() {
    console.log("\u{1F680} [Trussal Engine] Jitsi DOM detected. Mounting custom UI layers...");
    const styleOverride = document.createElement("style");
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
    const myIframeOverlay = document.createElement("iframe");
    myIframeOverlay.src = STRUDEL_URL;
    myIframeOverlay.className = "strudel-overlay-container";
    document.body.appendChild(myIframeOverlay);
    function isVideoTile(el) {
      if (!el) return false;
      return !!el.querySelector("video");
    }
    function attachStrudelToTile(tile) {
      const rect = tile.getBoundingClientRect();
      if (rect.width < 200 || rect.height < 150) return;
      if (!tile || tile.dataset.trussalStrudel === "1") return;
      if (!isVideoTile(tile)) return;
      tile.dataset.trussalStrudel = "1";
      tile.classList.add("trussal-video-host");
      const iframe = document.createElement("iframe");
      iframe.src = STRUDEL_URL;
      iframe.className = "trussal-strudel-frame";
      iframe.title = "Strudel live-coding editor";
      iframe.setAttribute("allow", "autoplay; clipboard-write");
      tile.appendChild(iframe);
    }
    function scanAndAttach() {
      const selector = TILE_SELECTORS.join(",");
      const tiles = document.querySelectorAll(selector);
      tiles.forEach(attachStrudelToTile);
    }
    function startStrudelOverlayRender() {
      console.log("[Trussal] Strudel overlay init");
      scanAndAttach();
      setInterval(scanAndAttach, 2e3);
      const target = document.body || document.documentElement;
      if (!target) return;
      const obs = new MutationObserver(scanAndAttach);
      obs.observe(target, { childList: true, subtree: true });
    }
    function renderStrudelOverlay() {
      if (document.readyState === "complete" || document.readyState === "interactive") {
        startStrudelOverlayRender();
      } else {
        window.addEventListener("DOMContentLoaded", startStrudelOverlayRender);
      }
    }
  }
  var waitForJitsiUI = setInterval(() => {
    const jitsiContainer = document.getElementById("videospace") || document.querySelector(".videoconference-layout");
    const isPrejoinActive = document.getElementById("preview");
    if (jitsiContainer && !isPrejoinActive) {
      clearInterval(waitForJitsiUI);
      initTrussalUI();
    }
  }, 200);

  // src/latency-instrument.js
  var BUTTON_ID = "trussal-latency-toggle";
  var OVERLAY_ID = "trussal-latency-overlay";
  var client = null;
  var initedRoom = null;
  var audioCtx = null;
  var ws = null;
  var pingTimer = null;
  var workletNode = null;
  var limiter = null;
  var workletLoaded = null;
  var isAudioRunning = false;
  var reverb = null;
  var oscillator = null;
  var oscGain = null;
  var testToneEnabled = false;
  var reverbSelected = false;
  var distortionSelected = false;
  var noiseSelected = false;
  var remoteSources = /* @__PURE__ */ new Map();
  var audioTagObserver = null;
  var samples = [];
  var jitter = 0;
  var currentRoomName = null;
  var statusEl = null;
  function logStatus(text) {
    if (statusEl) statusEl.textContent = text;
    console.log("[LatencyInstrument Status]", text);
  }
  function isPreMeeting() {
    const body = document.body;
    if (!body) return true;
    if (body.classList.contains("welcome-page")) return true;
    if (document.querySelector(".prejoin-screen")) return true;
    if (document.getElementById("trussal-welcome-overlay")) return true;
    const meetingContainer = document.getElementById("largeVideoContainer") || document.querySelector(".videocontainer");
    return !meetingContainer;
  }
  function updateStatusText() {
    if (!isAudioRunning) {
      logStatus("Audio Disabled");
      return;
    }
    let sources = [];
    if (remoteSources.size > 0) sources.push(`Listening to ${remoteSources.size} peers`);
    if (testToneEnabled) sources.push("Test Tone");
    if (sources.length === 0) logStatus("Audio Active (Waiting for input...)");
    else logStatus(`Audio Active (${sources.join(" + ")})`);
  }
  function updateOscillator() {
    if (!audioCtx) return;
    if (testToneEnabled && audioCtx.state === "suspended") {
      audioCtx.resume();
    }
    if (testToneEnabled) {
      if (!oscillator && workletNode) {
        try {
          oscillator = audioCtx.createOscillator();
          oscillator.type = "sine";
          oscillator.frequency.setValueAtTime(440, audioCtx.currentTime);
          oscGain = audioCtx.createGain();
          oscGain.gain.value = 0.1;
          oscillator.connect(oscGain);
          oscGain.connect(workletNode);
          oscillator.start();
          console.log("[LatencyInstrument] Test Tone Started");
        } catch (e) {
          console.error("[LatencyInstrument] Failed to start oscillator", e);
        }
      }
    } else {
      if (oscillator) {
        try {
          oscillator.stop();
          oscillator.disconnect();
          if (oscGain) oscGain.disconnect();
        } catch (e) {
        }
        oscillator = null;
        oscGain = null;
        console.log("[LatencyInstrument] Test Tone Stopped");
      }
    }
    updateStatusText();
  }
  async function createReverb(audioCtx2) {
    if (!audioCtx2) return null;
    try {
      let convolver = audioCtx2.createConvolver();
      let response = await fetch("trussal-impulse.wav");
      const contentType = response.headers.get("content-type");
      if (contentType && contentType.includes("text/html")) {
        console.error("[LatencyInstrument] Server returned HTML instead of Audio");
        return null;
      }
      let arrayBuffer = await response.arrayBuffer();
      convolver.buffer = await audioCtx2.decodeAudioData(arrayBuffer);
      return convolver;
    } catch (e) {
      console.error("[LatencyInstrument] Failed to create reverb:", e);
      return null;
    }
  }
  function ensureAudioContext() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return Promise.reject(new Error("WebAudio not supported"));
    if (!audioCtx) audioCtx = new Ctor();
    if (!audioCtx.audioWorklet) return Promise.reject(new Error("AudioWorklet not supported"));
    if (!workletLoaded) {
      workletLoaded = audioCtx.audioWorklet.addModule("/latency-worklet-v2.js");
    }
    const resumePromise = audioCtx.state === "suspended" ? audioCtx.resume() : Promise.resolve();
    return resumePromise.then(() => workletLoaded);
  }
  function captureJitsiAudio() {
    if (!audioCtx || !workletNode) return;
    const audioTags = document.querySelectorAll("audio");
    audioTags.forEach((tag) => {
      if (remoteSources.has(tag)) return;
      if (!tag.srcObject) return;
      if (tag.id === "userAudio") return;
      try {
        const source = audioCtx.createMediaStreamSource(tag.srcObject);
        source.connect(workletNode);
        tag.muted = true;
        tag.volume = 0;
        remoteSources.set(tag, source);
        updateStatusText();
      } catch (e) {
        console.warn("[LatencyInstrument] Failed to capture audio tag", e);
      }
    });
  }
  function startAudioTagsObserver() {
    audioTagObserver = new MutationObserver(() => {
      captureJitsiAudio();
    });
    audioTagObserver.observe(document.body, { childList: true, subtree: true });
    captureJitsiAudio();
  }
  function stopAudio() {
    if (!isAudioRunning) return;
    if (ws) {
      ws.close();
      ws = null;
    }
    if (pingTimer) {
      clearInterval(pingTimer);
      pingTimer = null;
    }
    if (audioTagObserver) {
      audioTagObserver.disconnect();
      audioTagObserver = null;
    }
    remoteSources.forEach((source, tag) => {
      try {
        source.disconnect();
      } catch (e) {
      }
      tag.muted = false;
      tag.volume = 1;
    });
    remoteSources.clear();
    testToneEnabled = false;
    updateOscillator();
    if (workletNode) {
      workletNode.disconnect();
      workletNode = null;
    }
    if (limiter) {
      limiter.disconnect();
      limiter = null;
    }
    if (reverb) {
      reverb.disconnect();
      reverb = null;
    }
    isAudioRunning = false;
    updateStatusText();
  }
  function updateEffectStates() {
    const noiseCheckbox = document.getElementById("spumoni-noise");
    const reverbCheckbox = document.getElementById("backwash-reverb");
    const distortionCheckbox = document.getElementById("abcdeefg-distortion");
    const toneCheckbox = document.getElementById("test-tone-toggle");
    noiseSelected = noiseCheckbox ? noiseCheckbox.checked : false;
    reverbSelected = reverbCheckbox ? reverbCheckbox.checked : false;
    distortionSelected = distortionCheckbox ? distortionCheckbox.checked : false;
    const wantTone = toneCheckbox ? toneCheckbox.checked : false;
    if (wantTone !== testToneEnabled) {
      testToneEnabled = wantTone;
      if (testToneEnabled && !isAudioRunning) {
        startAudio().then(() => {
          updateOscillator();
        }).catch((e) => {
          console.error("[LatencyInstrument] Failed to start audio for test tone:", e);
          testToneEnabled = false;
          if (toneCheckbox) toneCheckbox.checked = false;
        });
      } else {
        updateOscillator();
      }
    }
    if (audioCtx && workletNode) {
      if (!distortionSelected) {
        const glitchParam = workletNode.parameters.get("glitchIntensity");
        if (glitchParam) glitchParam.setValueAtTime(0, audioCtx.currentTime);
      }
      if (!noiseSelected) {
        const noiseParam = workletNode.parameters.get("noiseType");
        if (noiseParam) noiseParam.setValueAtTime(0, audioCtx.currentTime);
      }
    }
  }
  function updateReverbConnection() {
    if (!audioCtx || !limiter) return;
    updateEffectStates();
    limiter.disconnect();
    if (reverbSelected) {
      limiter.connect(reverb);
      reverb.connect(audioCtx.destination);
    } else {
      limiter.connect(audioCtx.destination);
    }
  }
  async function startAudio() {
    if (isAudioRunning) return;
    try {
      await ensureAudioContext();
      if (!workletNode) {
        workletNode = new AudioWorkletNode(audioCtx, "latency-processor-v2", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1
        });
      }
      workletNode.port.onmessage = (event) => {
        console.log("[Latency Worklet Debug]", event.data);
      };
      if (!limiter) {
        limiter = audioCtx.createDynamicsCompressor();
        limiter.threshold.value = -3;
      }
      if (!reverb) {
        reverb = await createReverb(audioCtx);
      }
      workletNode.connect(limiter);
      reverb.connect(audioCtx.destination);
      updateReverbConnection();
      updateOscillator();
      startAudioTagsObserver();
      if (!ws || ws.readyState === WebSocket.CLOSED) connectWs();
      isAudioRunning = true;
      updateStatusText();
    } catch (e) {
      console.error("[LatencyInstrument] Audio init failed", e);
      logStatus("Audio failed: " + e.message);
    }
  }
  function connectWs() {
    if (ws) {
      ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      ws = null;
    }
    if (!currentRoomName) return;
    const loc = window.location;
    const wsProto = loc.protocol === "https:" ? "wss:" : "ws:";
    const wsUrl = `${wsProto}//${loc.host}/ws?room=${encodeURIComponent(currentRoomName)}&role=player`;
    console.log("[LatencyInstrument] Connecting to WebSocket:", wsUrl);
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: "ping", sentAt: Date.now() }));
        }
      }, 2e3);
    };
    ws.onclose = () => {
      if (pingTimer) clearInterval(pingTimer);
      ws = null;
    };
    ws.onmessage = (evt) => {
      let msg;
      try {
        msg = JSON.parse(evt.data);
      } catch (e) {
        return;
      }
      if (msg.type === "pong" && typeof msg.rtt === "number") {
        samples.push(msg.rtt);
        if (samples.length > 5) samples.shift();
        const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
        const variance = samples.map((x) => (x - mean) ** 2).reduce((a, b) => a + b, 0) / samples.length;
        jitter = Math.sqrt(variance);
        if (audioCtx && workletNode) {
          updateEffectStates();
          const cleanThreshold = 10;
          const maxGlitchThreshold = 100;
          let intensity = 0;
          let rawIntensity = 0;
          if (distortionSelected) {
            rawIntensity = jitter * (msg.rtt - cleanThreshold) / (maxGlitchThreshold - cleanThreshold);
            intensity = Math.max(0, Math.min(1, rawIntensity));
          }
          const glitchParam = workletNode.parameters.get("glitchIntensity");
          if (glitchParam) glitchParam.setValueAtTime(intensity, audioCtx.currentTime);
          let noiseType = 0;
          let noiseName = "None";
          if (noiseSelected) {
            if (jitter > 1 && jitter < 2) {
              noiseType = 1;
              noiseName = "White";
            } else if (jitter >= 2 && jitter < 3) {
              noiseType = 2;
              noiseName = "Brown";
            } else if (jitter >= 3) {
              noiseType = 3;
              noiseName = "Pink";
            }
          }
          const noiseParam = workletNode.parameters.get("noiseType");
          if (noiseParam) noiseParam.setValueAtTime(noiseType, audioCtx.currentTime);
          console.log(
            `[LatencyStats] RTT: ${msg.rtt.toFixed(1)}ms | Jitter: ${jitter.toFixed(2)} | Distortion: ${intensity.toFixed(3)} | Noise: ${noiseName}`
          );
        }
      }
    };
  }
  function onEffectChange() {
    if (!client) return;
    if (client.updateEffectStates) {
      client.updateEffectStates();
    }
    if (client.updateReverbConnection) {
      client.updateReverbConnection();
    }
  }
  function createLatencyClient(roomName, statusElement) {
    currentRoomName = roomName;
    statusEl = statusElement;
    return {
      updateEffectStates,
      updateReverbConnection,
      updateOscillator,
      enableAudio: startAudio,
      disableAudio: stopAudio
    };
  }
  function ensureOverlay(roomName) {
    let overlay = document.getElementById(OVERLAY_ID);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = OVERLAY_ID;
      Object.assign(overlay.style, {
        position: "fixed",
        left: "0",
        right: "16px",
        bottom: "32vh",
        height: "35vh",
        background: "rgba(0, 0, 0, 0.9)",
        zIndex: 9998,
        display: "none",
        borderTop: "1px solid rgba(255,255,255,0.2)",
        padding: "0.75rem 1rem",
        boxSizing: "border-box"
      });
      overlay.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
          <div style="color:#1ff466;font-weight:600;">
            Latency Instrument \u2013 room:
            <span id="lat-room-label"></span>
          </div>
          <button id="lat-close-btn"
                  style="border:none;background:transparent;color:#fff;
                         font-size:1.2rem;cursor:pointer;">
            \u2715
          </button>
        </div>
        <div style="display:flex;flex-direction:column; gap:1rem;">
         <fieldset style="border:1px solid #444; padding: 10px; border-radius:5px;">
                  <legend style="color:#ddd; font-size:0.9rem;">Latency and Jitter Dependent Effects:</legend>
                
                <div style="display:flex; gap: 15px; flex-wrap:wrap; color: #ccc;">
                    <div>
                     <input class="effects" type="checkbox" id="abcdeefg-distortion" name="abcdeefg-distortion" />
                            <label for="abcdeefg-distortion">Abcdeefg Distortion</label>
                    </div>
 
                    <div>
                            <input class="effects" type="checkbox" id="spumoni-noise" name="spumoni-noise" />
                            <label for="spumoni-noise">Spumoni Noise</label>
                    </div>
                    <div>
                            <input class="effects" type="checkbox" id="backwash-reverb" name="backwash-reverb" />
                            <label for="backwash-reverb">Backwash Reverb</label>
                    </div>
                </div>
        </fieldset>
        
        <fieldset style="border:1px solid #444; padding: 10px; border-radius:5px;">
            <legend style="color:#ddd; font-size:0.9rem;">Test Inputs:</legend>
            <div style="color: #ccc;">
                <input class="effects" type="checkbox" id="test-tone-toggle" name="test-tone-toggle" />
                <label for="test-tone-toggle">Test Tone (Sine 440Hz)</label>
            </div>
        </fieldset>
 
          <span id="lat-status" style="color:#1ff466; font-size:0.9rem; font-family: monospace;">
            Status: Idle
          </span>
        </div>
      `;
      if (document.body) document.body.appendChild(overlay);
      const labelEl = overlay.querySelector("#lat-room-label");
      const closeBtn = overlay.querySelector("#lat-close-btn");
      const statusEl2 = overlay.querySelector("#lat-status");
      if (labelEl) labelEl.textContent = roomName || "unknown";
      client = createLatencyClient(roomName, statusEl2);
      const noiseCheckbox = overlay.querySelector("#spumoni-noise");
      const reverbCheckbox = overlay.querySelector("#backwash-reverb");
      const distortionCheckbox = overlay.querySelector("#abcdeefg-distortion");
      const toneCheckbox = overlay.querySelector("#test-tone-toggle");
      if (noiseCheckbox) noiseCheckbox.addEventListener("change", onEffectChange);
      if (reverbCheckbox) reverbCheckbox.addEventListener("change", onEffectChange);
      if (distortionCheckbox) distortionCheckbox.addEventListener("change", onEffectChange);
      if (toneCheckbox) {
        toneCheckbox.addEventListener("change", () => {
          if (!client) return;
          if (client.updateEffectStates) client.updateEffectStates();
          if (client.updateReverbConnection) client.updateReverbConnection();
        });
      }
      if (closeBtn) {
        closeBtn.addEventListener("click", () => {
          overlay.style.display = "none";
        });
      }
      if (client) client.enableAudio();
    } else {
      const labelEl = overlay.querySelector("#lat-room-label");
      if (labelEl) labelEl.textContent = roomName || "unknown";
    }
    return overlay;
  }
  function ensureToggleButton(roomName) {
    let btn = document.getElementById(BUTTON_ID);
    if (!btn) {
      if (!document.body) return null;
      btn = document.createElement("button");
      btn.id = BUTTON_ID;
      btn.type = "button";
      btn.textContent = "Latency Instrument";
      Object.assign(btn.style, {
        position: "fixed",
        bottom: "80px",
        right: "20px",
        zIndex: 9999,
        padding: "0.5rem 0.9rem",
        borderRadius: "999px",
        border: "none",
        background: "#1ff466",
        color: "#050f0a",
        fontWeight: "600",
        cursor: "pointer",
        display: "none"
        // Hidden by default, shown only in meeting
      });
      btn.addEventListener("click", function(evt) {
        evt.preventDefault();
        evt.stopPropagation();
        const overlay = ensureOverlay(roomName);
        const visible = overlay && overlay.style.display !== "none";
        if (overlay) {
          overlay.style.display = visible ? "none" : "block";
        }
      });
      document.body.appendChild(btn);
    }
    return btn;
  }
  function maybeInitLatencyUi() {
    if (isPreMeeting()) {
      const btn2 = document.getElementById(BUTTON_ID);
      const overlay = document.getElementById(OVERLAY_ID);
      if (btn2) btn2.style.display = "none";
      if (overlay) overlay.style.display = "none";
      return;
    }
    const roomName = getRoomNameFromUrl();
    if (!roomName) {
      const btn2 = document.getElementById(BUTTON_ID);
      const overlay = document.getElementById(OVERLAY_ID);
      if (btn2) btn2.style.display = "none";
      if (overlay) overlay.style.display = "none";
      return;
    }
    if (initedRoom === roomName) {
      const btn2 = document.getElementById(BUTTON_ID);
      if (btn2) btn2.style.display = "block";
      return;
    }
    initedRoom = roomName;
    const btn = ensureToggleButton(roomName);
    if (btn) btn.style.display = "block";
  }
  function createLatencyInstrument() {
    if (document.readyState === "complete" || document.readyState === "interactive") {
      maybeInitLatencyUi();
    } else {
      window.addEventListener("DOMContentLoaded", maybeInitLatencyUi);
    }
    setInterval(maybeInitLatencyUi, 1e3);
  }

  // src/index.js
  window.JAMULUS_ROOM_MAP = JAMULUS_ROOM_MAP;
  renderJamulusWelcomePanelAndBanner();
  renderRecentListText();
  renderWelcomeOverlay();
  renderHideStartMeetingButton();
  renderPrejoinScreen();
  renderNoAudioToast();
  createLatencyInstrument();
})();

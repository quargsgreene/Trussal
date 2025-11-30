let audioCtx = null;
let ws = null;
let serverOffsetMs = 0; // if we decide to sync to server clock
let roomId = 'default';
let clientId = Math.random().toString(36).slice(2);
let lastRtt = null;

const statusEl = document.getElementById('status');
const rttLabel = document.getElementById('rttLabel');
const roomLabel = document.getElementById('roomLabel');
const startBtn = document.getElementById('startBtn');

// Parse ?room= from URL (Jitsi room number)
(function initRoomFromLocation() {
  const u = new URL(window.location.href);
  roomId = u.searchParams.get('room') || 'default';
  roomLabel.textContent = roomId;
})();

function ensureAudioContext() {
  if (!audioCtx) {
    audioCtx = new AudioContext();
  }
}

// Simple “ping” sound
function playPing(atTimeSec, pitchMidi) {
  const ctx = audioCtx;
  if (!ctx) return;

  const osc = ctx.createOscillator();
  const gain = ctx.createGain();

  const freq = 220 * Math.pow(2, (pitchMidi - 57) / 12);
  osc.frequency.value = freq;

  gain.gain.setValueAtTime(0.0, atTimeSec);
  gain.gain.linearRampToValueAtTime(0.3, atTimeSec + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, atTimeSec + 0.4);

  osc.connect(gain).connect(ctx.destination);
  osc.start(atTimeSec);
  osc.stop(atTimeSec + 0.5);
}

function scheduleFromServerEvent(msg) {
  if (!audioCtx) return;

  const nowClientMs = Date.now();
  const leadMs = msg.at - nowClientMs; // naive; improve with clock sync later
  const when = audioCtx.currentTime + Math.max(leadMs, 0) / 1000;

  playPing(when, msg.pitch || 60);
}

funnction connectWs() {
  const loc = window.location;
  const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
//  const wsUrl = `${wsProto}//${loc.host}/ws?room=${encodeURIComponent(roomId)}&client=${encodeURIComponent(clientId)}`;
  const wsUrl = `${wsProto}//${loc.host}/ws`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    statusEl.textContent = 'Connected. Waiting for latency beats…';
    startPingLoop();
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === 'pong') {
      lastRtt = msg.rtt;
      rttLabel.textContent = Math.round(lastRtt);
    } else if (msg.type === 'play') {
      scheduleFromServerEvent(msg);
    }
  };

  ws.onclose = () => {
    statusEl.textContent = 'Disconnected. Reload to reconnect.';
  };
}

function startPingLoop() {
  function pingOnce() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const now = Date.now();
    ws.send(JSON.stringify({ type: 'ping', sentAt: now }));
  }
  pingOnce();
  setInterval(pingOnce, 2000);
}

// User must click to start audio (browser autoplay policy)
startBtn.addEventListener('click', async () => {
  ensureAudioContext();

  if (audioCtx.state === 'suspended') {
    await audioCtx.resume();
  }

  statusEl.textContent = 'Audio enabled. Connecting…';
  connectWs();
});

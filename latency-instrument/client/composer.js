let ws = null;
let roomId = 'default';
let clientId = 'composer-' + Math.random().toString(36).slice(2);
let patternTimer = null;

const roomLabel = document.getElementById('roomLabel');
const baseDelayInput = document.getElementById('baseDelay');
const rttScaleInput = document.getElementById('rttScale');
const useRttInput = document.getElementById('useRtt');
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const logEl = document.getElementById('log');

(function initRoomFromLocation() {
  const u = new URL(window.location.href);
  roomId = u.searchParams.get('room') || 'default';
  roomLabel.textContent = roomId;
})();

function appendLog(text) {
  logEl.textContent += text + '\n';
  logEl.scrollTop = logEl.scrollHeight;
}

function connectWs() {
  const loc = window.location;
  const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
 // const wsUrl = `${wsProto}//${loc.host}/ws?room=${encodeURIComponent(roomId)}&client=${encodeURIComponent(clientId)}&role=composer`;
  const wsUrl = `${wsProto}//${loc.host}/ws`;
  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    appendLog('Connected as composer');
  };

  ws.onclose = () => {
    appendLog('Disconnected');
    ws = null;
  };
}

function startPattern() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    appendLog('WS not open yet');
    return;
  }
  if (patternTimer) return;

  appendLog('Pattern started');

  patternTimer = setInterval(() => {
    const baseDelay = Number(baseDelayInput.value || 0);
    const rttScale = Number(rttScaleInput.value || 0);
    const useRtt = useRttInput.checked;

    // You can add more musical logic here (step counters, different pitches, etc.)
    const msg = {
      type: 'patternEvent',
      delayMs: baseDelay,
      useRtt,
      rttScale,
      voice: 'click',
      pitch: 60 // or change per step
    };

    ws.send(JSON.stringify(msg));
  }, 600); // ~100BPM
}

function stopPattern() {
  if (patternTimer) {
    clearInterval(patternTimer);
    patternTimer = null;
    appendLog('Pattern stopped');
  }
}

startBtn.addEventListener('click', startPattern);
stopBtn.addEventListener('click', stopPattern);

connectWs();

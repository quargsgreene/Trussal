import { getRoomNameFromUrl } from './jamulus.js';
const BUTTON_ID  = 'trussal-latency-toggle';
const OVERLAY_ID = 'trussal-latency-overlay';
let client = null;       // holds WebSocket + audio chain
let initedRoom = null;   // remember which room we've initialised for

let audioCtx = null;
let ws = null;
let pingTimer = null;

let workletNode = null;
let limiter = null;
let workletLoaded = null;
let isAudioRunning = false;
let reverb = null;

// Oscillator State
let oscillator = null;
let oscGain = null;
let testToneEnabled = false;

// Effect State
let reverbSelected = false;
let distortionSelected = false;
let noiseSelected = false;

// Track audio sources
let remoteSources = new Map(); 
let audioTagObserver = null;

const samples = [];
let jitter = 0;

// Store room name and status element for use in functions
let currentRoomName = null;
let statusEl = null;

function logStatus(text) {
    if (statusEl) statusEl.textContent = text;
    console.log('[LatencyInstrument Status]', text);
}


function isPreMeeting() {
    const body = document.body;
    if (!body) return true;
    
    // 1. Check for Jitsi Welcome Page
    if (body.classList.contains('welcome-page')) return true;
 
    // 2. Check for standard Jitsi Pre-join screen
    if (document.querySelector('.prejoin-screen')) return true;
 
    // 3. Check for YOUR custom Trussal overlay (from screenshot)
    if (document.getElementById('trussal-welcome-overlay')) return true;
 
    // 4. Fallback: Check if the main meeting video container exists
    const meetingContainer = document.getElementById('largeVideoContainer') || 
                             document.querySelector('.videocontainer');
    
    return !meetingContainer;
  }

  function updateStatusText() {
    if (!isAudioRunning) {
        logStatus('Audio Disabled');
        return;
    }
    
    let sources = [];
    if (remoteSources.size > 0) sources.push(`Listening to ${remoteSources.size} peers`);
    if (testToneEnabled) sources.push("Test Tone");
    
    if (sources.length === 0) logStatus('Audio Active (Waiting for input...)');
    else logStatus(`Audio Active (${sources.join(' + ')})`);
}

function updateOscillator() {
    if (!audioCtx) return; 
    
    // Ensure context is running if we want to hear the tone
    if (testToneEnabled && audioCtx.state === 'suspended') {
        audioCtx.resume();
    }

    if (testToneEnabled) {
        if (!oscillator && workletNode) {
            try {
                oscillator = audioCtx.createOscillator();
                oscillator.type = 'sine';
                oscillator.frequency.setValueAtTime(440, audioCtx.currentTime);
                
                oscGain = audioCtx.createGain();
                oscGain.gain.value = 0.1; // Keep it quiet (-20dB)
            oscillator.connect(oscGain);
          //  workletNode.connect(oscGain);
            oscGain.connect(workletNode);
     //     workletNode.connect(limiter); 
                
                oscillator.start();
                console.log('[LatencyInstrument] Test Tone Started');
            } catch(e) {
                console.error('[LatencyInstrument] Failed to start oscillator', e);
            }
        }
    } else {
        if (oscillator) {
            try {
                oscillator.stop();
                oscillator.disconnect();
                if(oscGain) oscGain.disconnect();
            } catch(e){}
            oscillator = null;
            oscGain = null;
            console.log('[LatencyInstrument] Test Tone Stopped');
        }
    }
    updateStatusText();
}

async function createReverb(audioCtx) {
    if(!audioCtx) return null;
    try {
      let convolver = audioCtx.createConvolver();
      let response = await fetch("trussal-impulse.wav");
      
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('text/html')) {
          console.error('[LatencyInstrument] Server returned HTML instead of Audio');
          return null;
      }

      let arrayBuffer = await response.arrayBuffer();
      convolver.buffer = await audioCtx.decodeAudioData(arrayBuffer);
      return convolver;
    } catch (e) {
      console.error('[LatencyInstrument] Failed to create reverb:', e);
      return null;
    }
}

function ensureAudioContext() {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return Promise.reject(new Error('WebAudio not supported'));
    if (!audioCtx) audioCtx = new Ctor();
    if (!audioCtx.audioWorklet) return Promise.reject(new Error('AudioWorklet not supported'));

    if (!workletLoaded) {
      workletLoaded = audioCtx.audioWorklet.addModule('/latency-worklet-v2.js');
    }

    const resumePromise = audioCtx.state === 'suspended' ? audioCtx.resume() : Promise.resolve();
    return resumePromise.then(() => workletLoaded);
  }

  function captureJitsiAudio() {
    if (!audioCtx || !workletNode) return;
    const audioTags = document.querySelectorAll('audio');

    audioTags.forEach(tag => {
        if (remoteSources.has(tag)) return;
        if (!tag.srcObject) return;
        if (tag.id === 'userAudio') return; 

        try {
            const source = audioCtx.createMediaStreamSource(tag.srcObject);
            source.connect(workletNode);
            tag.muted = true;
            tag.volume = 0;
            remoteSources.set(tag, source);
            updateStatusText();
        } catch(e) {
            console.warn('[LatencyInstrument] Failed to capture audio tag', e);
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

    if (ws) { ws.close(); ws = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }

    if (audioTagObserver) {
        audioTagObserver.disconnect();
        audioTagObserver = null;
    }
    remoteSources.forEach((source, tag) => {
        try { source.disconnect(); } catch(e){}
        tag.muted = false; 
        tag.volume = 1;
    });
    remoteSources.clear();
    
    testToneEnabled = false; 
    updateOscillator();

    if (workletNode) { workletNode.disconnect(); workletNode = null; }
    if (limiter) { limiter.disconnect(); limiter = null; }
    if (reverb) { reverb.disconnect(); reverb = null; }

    isAudioRunning = false;
    updateStatusText();
   }

function updateEffectStates() {
    const noiseCheckbox = document.getElementById('spumoni-noise');
    const reverbCheckbox = document.getElementById('backwash-reverb');
    const distortionCheckbox = document.getElementById('abcdeefg-distortion');
    const toneCheckbox = document.getElementById('test-tone-toggle');
    
    noiseSelected = noiseCheckbox ? noiseCheckbox.checked : false;
    reverbSelected = reverbCheckbox ? reverbCheckbox.checked : false;
    distortionSelected = distortionCheckbox ? distortionCheckbox.checked : false;
    
    // Update oscillator state
    const wantTone = toneCheckbox ? toneCheckbox.checked : false;
    if (wantTone !== testToneEnabled) {
        testToneEnabled = wantTone;
        // Force audio start if checking the box and audio isn't running
        if (testToneEnabled && !isAudioRunning) {
           startAudio().then(() => {
               updateOscillator();
           }).catch(e => {
               console.error('[LatencyInstrument] Failed to start audio for test tone:', e);
               testToneEnabled = false; // Reset on failure
               if (toneCheckbox) toneCheckbox.checked = false;
           });
        } else {
           updateOscillator();
        }
    }

    // FORCE RESET parameters immediately when boxes are unchecked
    if (audioCtx && workletNode) {
        if (!distortionSelected) {
            const glitchParam = workletNode.parameters.get('glitchIntensity');
            if (glitchParam) glitchParam.setValueAtTime(0, audioCtx.currentTime);
        }
        if (!noiseSelected) {
            const noiseParam = workletNode.parameters.get('noiseType');
            if (noiseParam) noiseParam.setValueAtTime(0, audioCtx.currentTime);
        }
    }
  }

  function updateReverbConnection() {
    // Only require that the context and limiter exist
            if (!audioCtx || !limiter) return;
  
    // Make sure our checkbox state is in sync
          updateEffectStates();
          
    
    // Avoid duplicate connections
           limiter.disconnect();
    
           if (reverbSelected) {
         // Route through reverb when selected
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
        workletNode = new AudioWorkletNode(audioCtx, 'latency-processor-v2', {
          numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1
        });
      }

       workletNode.port.onmessage = (event) => {
          console.log('[Latency Worklet Debug]', event.data);
       };
      
      if (!limiter) {
        limiter = audioCtx.createDynamicsCompressor();
        limiter.threshold.value = -3.0;
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
      console.error('[LatencyInstrument] Audio init failed', e);
      logStatus('Audio failed: ' + e.message);
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
    const wsProto = loc.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${loc.host}/ws?room=${encodeURIComponent(currentRoomName)}&role=player`;

    console.log('[LatencyInstrument] Connecting to WebSocket:', wsUrl);
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      pingTimer = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping', sentAt: Date.now() }));
        }
      }, 2000);
    };

    ws.onclose = () => {
      if (pingTimer) clearInterval(pingTimer);
      ws = null;
    };

    ws.onmessage = (evt) => {
      let msg;
      try { msg = JSON.parse(evt.data); } catch (e) { return; }

      if (msg.type === 'pong' && typeof msg.rtt === 'number') {
        samples.push(msg.rtt);
        if (samples.length > 5) samples.shift();
        const mean = samples.reduce((a, b) => a + b, 0) / samples.length;
        const variance = samples.map(x => (x - mean) ** 2).reduce((a, b) => a + b, 0) / samples.length;
        jitter = Math.sqrt(variance);

        if (audioCtx && workletNode) {
          updateEffectStates(); // Sync checkbox state
          const cleanThreshold = 10;
          const maxGlitchThreshold = 100;

          // 1. Distortion
          let intensity =  0; 
          let rawIntensity = 0;
          if (distortionSelected) {
              rawIntensity = jitter * (msg.rtt - cleanThreshold) / (maxGlitchThreshold - cleanThreshold);
              intensity =  Math.max(0, Math.min(1, rawIntensity));
          }
          
          const glitchParam = workletNode.parameters.get('glitchIntensity');
          if (glitchParam) glitchParam.setValueAtTime(intensity, audioCtx.currentTime);

          // 2. Noise
          let noiseType = 0;
          let noiseName = "None";
          if (noiseSelected) {
              if (jitter > 1 && jitter < 2) { noiseType = 1; noiseName = "White"; }
              else if (jitter >= 2 && jitter < 3) { noiseType = 2; noiseName = "Brown"; }
              else if (jitter >= 3) { noiseType = 3; noiseName = "Pink"; }
          }
          const noiseParam = workletNode.parameters.get('noiseType');
          if (noiseParam) noiseParam.setValueAtTime(noiseType, audioCtx.currentTime);

          console.log(
              `[LatencyStats] RTT: ${msg.rtt.toFixed(1)}ms | Jitter: ${jitter.toFixed(2)} | ` +
              `Distortion: ${intensity.toFixed(3)} | Noise: ${noiseName}`
          );

        }
      }
    }
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

export function createLatencyClient(roomName, statusElement) {
    currentRoomName = roomName;
    statusEl = statusElement;
    
    return {
        updateEffectStates: updateEffectStates,
        updateReverbConnection: updateReverbConnection,
        updateOscillator: updateOscillator,
        enableAudio: startAudio,
        disableAudio: stopAudio
    }
}

function ensureOverlay(roomName) {
    let overlay = document.getElementById(OVERLAY_ID);
 
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = OVERLAY_ID;
      Object.assign(overlay.style, {
        position: 'fixed',
        left: '0',
        right: '16px',
        bottom: '32vh',
        height: '35vh',
        background: 'rgba(0, 0, 0, 0.9)',
        zIndex: 9998,
        display: 'none',
        borderTop: '1px solid rgba(255,255,255,0.2)',
        padding: '0.75rem 1rem',
        boxSizing: 'border-box'
      });
 
      overlay.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:0.5rem;">
          <div style="color:#1ff466;font-weight:600;">
            Latency Instrument – room:
            <span id="lat-room-label"></span>
          </div>
          <button id="lat-close-btn"
                  style="border:none;background:transparent;color:#fff;
                         font-size:1.2rem;cursor:pointer;">
            ✕
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
 
       const labelEl = overlay.querySelector('#lat-room-label');
       const closeBtn = overlay.querySelector('#lat-close-btn');
       const statusEl = overlay.querySelector('#lat-status');
       if (labelEl) labelEl.textContent = roomName || 'unknown';
 
       client = createLatencyClient(roomName, statusEl);
       
        const noiseCheckbox = overlay.querySelector('#spumoni-noise');
        const reverbCheckbox = overlay.querySelector('#backwash-reverb');
        const distortionCheckbox = overlay.querySelector('#abcdeefg-distortion');
        const toneCheckbox = overlay.querySelector('#test-tone-toggle');
 
        if (noiseCheckbox) noiseCheckbox.addEventListener('change', onEffectChange);
        if (reverbCheckbox) reverbCheckbox.addEventListener('change', onEffectChange);
        if (distortionCheckbox) distortionCheckbox.addEventListener('change', onEffectChange);
 
 // Tone checkbox still uses the same path; we can reuse onEffectChange too:
        if (toneCheckbox) {
                toneCheckbox.addEventListener('change', () => {
                if (!client) return;
                if (client.updateEffectStates) client.updateEffectStates();
                if (client.updateReverbConnection) client.updateReverbConnection();
                });
        }
 
 
      if (closeBtn) {
        closeBtn.addEventListener('click', () => {
          overlay.style.display = 'none';
        });
      }
      
      // Auto-start audio engine when the overlay is created (silently)
      if(client) client.enableAudio();
 
    } else {
      const labelEl = overlay.querySelector('#lat-room-label');
      if (labelEl) labelEl.textContent = roomName || 'unknown';
    }
 
    return overlay;
  }

  function ensureToggleButton(roomName) {
    let btn = document.getElementById(BUTTON_ID);
    if (!btn) {
      if (!document.body) return null;
 
      btn = document.createElement('button');
      btn.id = BUTTON_ID;
      btn.type = 'button';
      btn.textContent = 'Latency Instrument';
 
      Object.assign(btn.style, {
        position: 'fixed',
        bottom: '80px', 
        right: '20px',
        zIndex: 9999,
        padding: '0.5rem 0.9rem',
        borderRadius: '999px',
        border: 'none',
        background: '#1ff466',
        color: '#050f0a',
        fontWeight: '600',
        cursor: 'pointer',
        display: 'none' // Hidden by default, shown only in meeting
      });
 
      btn.addEventListener('click', function (evt) {
        evt.preventDefault();
        evt.stopPropagation();
 
        const overlay = ensureOverlay(roomName);
        const visible = overlay && overlay.style.display !== 'none';
        if (overlay) {
          overlay.style.display = visible ? 'none' : 'block';
        }
      });
 
      document.body.appendChild(btn);
    }
 
    return btn;
  }

  function maybeInitLatencyUi() {
    // 1. Check strict pre-meeting conditions
    if (isPreMeeting()) {
      const btn = document.getElementById(BUTTON_ID);
      const overlay = document.getElementById(OVERLAY_ID);
      // Hide if they exist
      if (btn) btn.style.display = 'none';
      if (overlay) overlay.style.display = 'none';
      return;
    }
 
    const roomName = getRoomNameFromUrl();
    if (!roomName) {
      // Hide if no room name
      const btn = document.getElementById(BUTTON_ID);
      const overlay = document.getElementById(OVERLAY_ID);
      if (btn) btn.style.display = 'none';
      if (overlay) overlay.style.display = 'none';
      return;
    }
 
    // Only initialize once per room
    if (initedRoom === roomName) {
      // Still ensure button is visible
      const btn = document.getElementById(BUTTON_ID);
      if (btn) btn.style.display = 'block';
      return;
    }
    
    initedRoom = roomName;
 
    const btn = ensureToggleButton(roomName);
    if (btn) btn.style.display = 'block';
  }

  export function createLatencyInstrument() {
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        maybeInitLatencyUi();
      } else {
        window.addEventListener('DOMContentLoaded', maybeInitLatencyUi);
      }
    setInterval(maybeInitLatencyUi, 1000);
  }

// stable-state.js — State that must survive HMR updates
//
// All modules with long-lived state (WebSocket, Yjs docs, Strudel instances)
// read/write here instead of holding their own module-level state.
//
// The state object below is a plain module-level singleton. In dev, the HMR
// plugin (vite-plugin-trussal-hmr.js) hands the same object to the re-executed
// module through Vite's import.meta.hot.data, so the live WebSocket, peer maps,
// Yjs docs and timers survive an edit to this file instead of being recreated
// (or lost to a full reload). Production has no such hand-off and just uses
// the singleton.

// ============ State container ============

function createState() {
  const localIsBot = !!(typeof window !== 'undefined' && window.__trussalIsBot);
  const localIsAggregator = !!(typeof window !== 'undefined' && window.__trussalIsAggregator);

  return {
    // WebSocket connection — must persist across HMR
    ws: null,
    wsConfig: null,

    // Peer state maps
    peersByPeerId: new Map(),
    peerIdByJitsiId: new Map(),

    localIsBot,
    localIsAggregator,

    localPeer: {
      peerId: null,
      roomIndex: null,
      jitsiId: null,
      displayName: null,
      isLocal: true,
      isBot: localIsBot,
      isAggregator: localIsAggregator,
      muted: false,
      pattern: '',
      compiledCss: '',
      dataPacks: [],
      customEmoji: [],
      effects: { distortion: false, noise: false, reverb: false },
      playing: false,
      rtt: null,
      jitter: null,
      packetLoss: null,
      rtcRtt: null,
      rtcJitter: null,
      jitterBufferMs: null,
      pipelineMs: null,
      canEditMetaprogram: !localIsBot,
      canWriteModulation: !localIsBot,
      videoOn: false,
    },

    subscribers: new Set(),
    aggregatorSlotTaken: false,
    activeJPatternToken: null,
    activeJPatternIndex: null,
    activeJPatternKind: null,
    myPeerId: null,
    lastAnnouncedPattern: null,
    helloSent: false,
    pingTimer: null,
    reconnectTimer: null,
    reconnectDelay: 1000,
    lastPongAt: 0,
    currentRoom: null,
    wantConnection: false,
    pendingSends: [],
    rttSamples: [],
    localRtt: null,
    localJitter: null,

    // ============ Yjs Documents (from MetaprogrammerCrdtSync.js) ============
    yjsDocs: new Map(),

    // ============ Strudel Instances ============
    strudelInstances: new Map(),
  };
}

const state = createState();

const MAX_RECONNECT_DELAY = 15000;
const PONG_TIMEOUT_MS = 8000;

// ============ Yjs Doc Registry ============

export function getYjsDoc(key) {
  if (!state.yjsDocs.has(key)) {
    import('yjs').then(({ Doc }) => {
      const doc = new Doc();
      state.yjsDocs.set(key, doc);
    });
  }
  return state.yjsDocs.get(key);
}

export function setYjsDoc(key, doc) {
  state.yjsDocs.set(key, doc);
}

// ============ Strudel Instance Registry ============

export function getStrudelInstance(key) {
  return state.strudelInstances.get(key);
}

export function setStrudelInstance(key, instance) {
  state.strudelInstances.set(key, instance);
}

// ============ WebSocket Management ============

export function getWs() { return state.ws; }
export function setWs(socket) { state.ws = socket; }
export function getWsConfig() { return state.wsConfig; }
export function setWsConfig(config) { state.wsConfig = config; }

// ============ Peer State Accessors ============

export function getPeersByPeerId() { return state.peersByPeerId; }
export function getPeerIdByJitsiId() { return state.peerIdByJitsiId; }
export function getLocalPeer() { return state.localPeer; }
export function getSubscribers() { return state.subscribers; }
export function getAggregatorSlotTaken() { return state.aggregatorSlotTaken; }
export function setAggregatorSlotTaken(val) { state.aggregatorSlotTaken = val; }
export function getActiveJPatternToken() { return state.activeJPatternToken; }
export function setActiveJPatternToken(val) { state.activeJPatternToken = val; }
export function getActiveJPatternIndex() { return state.activeJPatternIndex; }
export function setActiveJPatternIndex(val) { state.activeJPatternIndex = val; }
export function getActiveJPatternKind() { return state.activeJPatternKind; }
export function setActiveJPatternKind(val) { state.activeJPatternKind = val; }
export function getMyPeerId() { return state.myPeerId; }
export function setMyPeerId(val) { state.myPeerId = val; }
export function getLastAnnouncedPattern() { return state.lastAnnouncedPattern; }
export function setLastAnnouncedPattern(val) { state.lastAnnouncedPattern = val; }
export function getHelloSent() { return state.helloSent; }
export function setHelloSent(val) { state.helloSent = val; }
export function getPingTimer() { return state.pingTimer; }
export function setPingTimer(val) { state.pingTimer = val; }
export function getReconnectTimer() { return state.reconnectTimer; }
export function setReconnectTimer(val) { state.reconnectTimer = val; }
export function getReconnectDelay() { return state.reconnectDelay; }
export function setReconnectDelay(val) { state.reconnectDelay = val; }
export function getLastPongAt() { return state.lastPongAt; }
export function setLastPongAt(val) { state.lastPongAt = val; }
export function getCurrentRoom() { return state.currentRoom; }
export function setCurrentRoom(val) { state.currentRoom = val; }
export function getWantConnection() { return state.wantConnection; }
export function setWantConnection(val) { state.wantConnection = val; }
export function getPendingSends() { return state.pendingSends; }
export function getRttSamples() { return state.rttSamples; }
export function getLocalRtt() { return state.localRtt; }
export function setLocalRtt(val) { state.localRtt = val; }
export function getLocalJitter() { return state.localJitter; }
export function setLocalJitter(val) { state.localJitter = val; }

// Constants
export { MAX_RECONNECT_DELAY, PONG_TIMEOUT_MS };

// ============ Subscriber Management ============

export function subscribe(fn) {
  state.subscribers.add(fn);
  return () => state.subscribers.delete(fn);
}

export function emit(event, payload) {
  for (const fn of state.subscribers) {
    try { fn(event, payload); } catch (e) { console.warn('[stable-state] subscriber threw', e); }
  }
}

// ============ Helpers ============

function defaultPeer(peerId) {
  return {
    peerId,
    roomIndex: null,
    jitsiId: null,
    displayName: null,
    isBot: false,
    isAggregator: false,
    muted: false,
    videoOn: false,
    pattern: '',
    compiledCss: '',
    dataPacks: [],
    customEmoji: [],
    effects: { distortion: false, noise: false, reverb: false },
    playing: false,
    rtt: null,
    jitter: null,
    packetLoss: null,
    rtcRtt: null,
    rtcJitter: null,
    jitterBufferMs: null,
    pipelineMs: null,
    canEditMetaprogram: true,
    canWriteModulation: true,
  };
}

export { defaultPeer };

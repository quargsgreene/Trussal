// Room health — browser service.
//
// Samples local pressure (requestAnimationFrame-derived fps + navigator
// heuristics), applies the RoomHealth compression policy to a master-bus
// DynamicsCompressor, publishes the MediaPipe landmark-density scale
// (window._ncLandmarkScale — consumed by facial-gesture's detection loop),
// and exposes the current audio/video decoupling for the video pipeline.

import { compressionParams, landmarkDensityScale, avDecouplingSeconds, healthActions } from './RoomHealth.js';
import { getAudioContext, getMasterBus } from '../latency-instrument.js';
import { effectiveWorstCase, subscribeSlotEvents } from './Metaprogrammer.js';
import { sendResearchEvent } from '../peer-state.js';

const SAMPLE_MS = 5000;

let timer = null;
let compressor = null;
let frameCount = 0;
let fpsWindowStart = 0;
let lastFps = 60;
let rafRunning = false;
let lastCycleSeconds = 0;
let lastActionsJson = '';

function sampleFrame(t) {
  if (!rafRunning) return;
  frameCount++;
  if (t - fpsWindowStart >= 1000) {
    lastFps = frameCount * 1000 / (t - fpsWindowStart);
    frameCount = 0;
    fpsWindowStart = t;
  }
  requestAnimationFrame(sampleFrame);
}

function localLoad() {
  // deviceMemory/hardwareConcurrency are coarse but stable heuristics; a
  // busy machine shows up primarily through the fps pressure term anyway.
  const cores = navigator.hardwareConcurrency || 4;
  const mem = navigator.deviceMemory || 4;
  return {
    fps: lastFps,
    fpsMin: 24,
    cpuPressure: cores <= 2 ? 0.4 : 0,
    ramPressure: mem <= 2 ? 0.4 : 0,
    serverLoad: 0 // fleet-status could feed this later
  };
}

function ensureCompressor() {
  const ctx = getAudioContext();
  const bus = getMasterBus();
  if (!ctx || !bus || compressor) return;
  // Transparent by default; tick() drives it. Parallel insertion is wrong
  // for a compressor, so splice: bus → compressor → destination alongside
  // whatever else already hangs off the bus is NOT safe — instead we ride
  // the bus's own gain for the "compression" of last resort and use a real
  // compressor only on the direct destination edge.
  compressor = ctx.createDynamicsCompressor();
  compressor.ratio.value = 1;
  compressor.threshold.value = -1;
  try {
    bus.disconnect(ctx.destination);
    bus.connect(compressor);
    compressor.connect(ctx.destination);
  } catch (e) {
    compressor = null; // master chain (av-effects) owns that edge right now
  }
}

function tick() {
  const load = localLoad();
  const ctx = getAudioContext();
  ensureCompressor();
  const comp = compressionParams(load);
  if (compressor && ctx) {
    const now = ctx.currentTime;
    compressor.ratio.setTargetAtTime(comp.ratio, now, 0.5);
    compressor.threshold.setTargetAtTime(comp.thresholdDb, now, 0.5);
    compressor.knee.setTargetAtTime(comp.kneeDb, now, 0.5);
  }
  window._ncLandmarkScale = landmarkDensityScale(load);
  const metrics = effectiveWorstCase();
  window._ncAvDecouplingS = avDecouplingSeconds(lastCycleSeconds, metrics);

  const actions = healthActions(load, { cycleSeconds: lastCycleSeconds, metrics });
  const json = JSON.stringify(actions);
  if (json !== lastActionsJson) {
    lastActionsJson = json;
    if (actions.length) sendResearchEvent('health-actions', { actions, fps: Math.round(lastFps) });
  }
}

export function noteCycleSeconds(seconds) {
  if (seconds > 0) lastCycleSeconds = seconds;
}

export function startRoomHealth() {
  if (timer) return;
  rafRunning = true;
  fpsWindowStart = performance.now();
  requestAnimationFrame(sampleFrame);
  timer = setInterval(tick, SAMPLE_MS);
  // Track cycle length for the decoupling math and log a sampled scheduler
  // trace (every 4th cycle) into the research session log.
  subscribeSlotEvents((ev) => {
    if (ev.type !== 'cycle-start') return;
    noteCycleSeconds(ev.seconds);
    if (ev.cycle % 4 === 0) {
      sendResearchEvent('cycle-start', { cycle: ev.cycle, seconds: ev.seconds, beats: ev.beats });
    }
  });
}

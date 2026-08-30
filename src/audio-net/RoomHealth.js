// Room health for JPattern — pure policy functions.
//
// All prior conductor health behavior persists in the fleet service
// (shouldReplace / computeMaxBots, unchanged). This module adds the room-side
// policies the spec layers on top:
//   - audio/video buffer timing decoupling per user (default one cycle
//     length), auto-adjusted by network conditions;
//   - output compression scaled globally by server load and locally by a
//     client's CPU/RAM/GPU pressure;
//   - MediaPipe landmark-density scale-down under load.
// Deadlock prevention is structural and lives where the hazards are: empty
// AV queues dequeue null (slot = silence, cycle advances), queues are
// depth+byte bounded with oldest-first eviction, the scheduler never blocks
// on a boundary, and the sidecar's CRDT log is capped and snapshot-subsumed.
// This module only computes parameters; RoomHealthService applies them.

// Audio/video decoupling offset in seconds. Baseline one cycle; worst-case
// latency stretches it (worse timing certainty → wider decoupling) up to two
// cycles.
export function avDecouplingSeconds(cycleSeconds, metrics = {}) {
  const base = Math.max(0, cycleSeconds || 0);
  const wcl = Math.max(0, metrics.wcl || 0);
  // +1 cycle at 500 ms worst-case latency, saturating at 2 cycles total.
  const stretch = Math.min(2, 1 + wcl / 500);
  return base * stretch;
}

// Compressor parameters from load. `load` fields are optional and normalized:
//   serverLoad  0..1  (fleet/VM pressure, from fleet-status or metrics)
//   cpuPressure 0..1  (local heuristic)
//   ramPressure 0..1
//   fps, fpsMin       (local render rate vs. floor)
// Healthy → transparent (ratio 1); rising pressure drives ratio up to 12:1
// and threshold down to −30 dB. The binding constraint wins.
export function compressionParams(load = {}) {
  const clamp01 = (x) => Math.max(0, Math.min(1, Number(x) || 0));
  const fpsPressure = load.fps != null && load.fpsMin
    ? clamp01(1 - load.fps / load.fpsMin)
    : 0;
  const pressure = Math.max(
    clamp01(load.serverLoad),
    clamp01(load.cpuPressure),
    clamp01(load.ramPressure),
    fpsPressure
  );
  return {
    pressure,
    ratio: 1 + pressure * 11,          // 1:1 → 12:1
    thresholdDb: -1 - pressure * 29,   // −1 dB → −30 dB
    kneeDb: 6,
    engaged: pressure > 0.05
  };
}

// MediaPipe landmark-density scale: 1 (full), 0.5, 0.25 tiers so the face
// tracker degrades gracefully instead of starving the audio thread.
export function landmarkDensityScale(load = {}) {
  const { pressure } = compressionParams(load);
  if (pressure >= 0.66) return 0.25;
  if (pressure >= 0.33) return 0.5;
  return 1;
}

// Discrete health actions for the research log / integration tests: what a
// given load snapshot makes the room do.
export function healthActions(load = {}, { cycleSeconds = 0, metrics = {} } = {}) {
  const comp = compressionParams(load);
  const density = landmarkDensityScale(load);
  const actions = [];
  if (comp.engaged) {
    actions.push({
      type: load.serverLoad >= Math.max(load.cpuPressure || 0, load.ramPressure || 0)
        ? 'compress-global' : 'compress-local',
      ratio: comp.ratio,
      thresholdDb: comp.thresholdDb
    });
  }
  if (density < 1) actions.push({ type: 'reduce-landmark-density', scale: density });
  const decouple = avDecouplingSeconds(cycleSeconds, metrics);
  if (cycleSeconds > 0 && decouple > cycleSeconds) {
    actions.push({ type: 'widen-av-decoupling', seconds: decouple });
  }
  return actions;
}

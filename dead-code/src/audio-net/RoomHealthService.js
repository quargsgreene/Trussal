// ARCHIVED 2026-08-28 — moved out of src/audio-net/RoomHealthService.js as dead
// code.
//
// Teardown counterpart to startRoomHealth(). Room health runs for the whole
// page lifetime, so nothing ever called this.
//
// Module-private state (stayed in src/audio-net/RoomHealthService.js):
//   let timer = null;          // setInterval handle for the sampling tick
//   let rafRunning = false;    // guards the requestAnimationFrame loop

export function stopRoomHealth() {
  if (timer) { clearInterval(timer); timer = null; }
  rafRunning = false;
}

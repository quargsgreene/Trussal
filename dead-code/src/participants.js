// ARCHIVED 2026-08-28 — moved out of src/participants.js as dead code.
//
// Imported by src/studio.js but never called. Consumers read the roster through
// subscribeParticipants() (join/leave/local events), not a point-in-time list.
//
// Module-private state (stayed in src/participants.js):
//   const remotes = new Map();   // jitsiId -> participant record

export function getRemoteParticipants() { return Array.from(remotes.values()); }

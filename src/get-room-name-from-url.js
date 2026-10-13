// Lowercased because Jitsi's own XMPP layer lowercases the MUC room name
// regardless of URL casing — every sidecar/fleet consumer of this room string
// (peer-state.js's WS room param, studio.js's spawn requests) has to agree
// with the one Jitsi itself actually joins, or /sdA and /sda silently split
// into two rosters and two bot clusters fighting over the same meeting.
export function getRoomNameFromUrl() {
    const parts = window.location.pathname.split('/').filter(Boolean);
    const roomName = parts.length ? parts[parts.length - 1] : null;
    return roomName ? roomName.toLowerCase() : roomName;
  }

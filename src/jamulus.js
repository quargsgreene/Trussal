export const JAMULUS_ROOM_MAP = {
  "0":  { host: "jamulus.trussal.com", port: 22000 },
  "1":  { host: "jamulus.trussal.com", port: 22001 },
  "2":  { host: "jamulus.trussal.com", port: 22002 },
  "3":  { host: "jamulus.trussal.com", port: 22003 },
  "4":  { host: "jamulus.trussal.com", port: 22004 },
  "5":  { host: "jamulus.trussal.com", port: 22005 },
  "6":  { host: "jamulus.trussal.com", port: 22006 },
  "7":  { host: "jamulus.trussal.com", port: 22007 },
  "8":  { host: "jamulus.trussal.com", port: 22008 },
  "9":  { host: "jamulus.trussal.com", port: 22009 },
  "10": { host: "jamulus.trussal.com", port: 22010 }
};

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

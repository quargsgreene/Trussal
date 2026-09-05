// panic-button.js — the breakout-room "panic button": an unconditional,
// self-service escape back to the room a performer actually joined.
//
// Moving between the main room and a Jitsi breakout room is Jitsi's own
// native XMPP MUC switch — see audio-net/Breakout.js's header for why this
// bundle does not try to drive that switch directly for a non-moderator
// (Jitsi's sendParticipantToRoom requires moderator rights even to move
// yourself — see lib-jitsi-meet's BreakoutRooms.js). The one operation
// available to ANY participant regardless of role is rejoining the meeting
// fresh, so this module captures the URL a performer actually arrived on —
// before any breakout-room redirection — the first time the bundle runs on a
// given tab, and the panic button unconditionally reloads there. Crude (a
// full rejoin, not an in-place room switch) but reliable: it depends on no
// Jitsi internal API that might be wrong, only on the browser's own
// navigation — which is exactly what "caught in an adverse loop keeping
// them out of all rooms" calls for.
//
// sessionStorage, not localStorage: a genuinely new tab/window should
// capture its OWN entry URL rather than inherit a stale one left by a
// previous tab — the same reasoning landmark-gesture-mode.js's mode flag
// uses for its own sessionStorage key.

const KEY = 'trussal-main-room-url';

export function captureMainRoomUrl() {
  try {
    if (typeof sessionStorage !== 'undefined' && !sessionStorage.getItem(KEY)) {
      sessionStorage.setItem(KEY, window.location.href);
    }
  } catch (e) {
    // sessionStorage unavailable (private browsing, embedded iframe policy)
    // — panic() below falls back to the current URL, which is at least a
    // full rejoin of WHATEVER room the browser is currently in.
  }
}

export function panic() {
  let url = null;
  try {
    if (typeof sessionStorage !== 'undefined') url = sessionStorage.getItem(KEY);
  } catch (e) { /* ignore */ }
  // Assigning the SAME href a page is already on is a no-op in some browsers
  // rather than a reload, so the no-captured-URL fallback calls reload()
  // explicitly instead of re-assigning href to itself.
  if (url) window.location.href = url;
  else window.location.reload();
}

// Run as early as this module is first imported — see index.js, which
// imports this before anything else could plausibly redirect the page.
captureMainRoomUrl();

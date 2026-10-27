// panic-button.js — the breakout-room "panic button": an unconditional,
// self-service escape back to the room a performer actually joined.
//
// Moving between the main room and a Jitsi breakout room is Jitsi's own
// native XMPP MUC switch, and Jitsi's sendParticipantToRoom requires
// moderator rights even to move yourself (lib-jitsi-meet's BreakoutRooms.js).
// The one operation available to ANY participant regardless of role is
// rejoining the meeting fresh, so this module captures the URL a performer
// actually arrived on — before any breakout-room redirection — the first
// time the bundle runs on a given tab, and the panic button unconditionally
// reloads there. Crude (a full rejoin, not an in-place room switch) but
// reliable: it depends on no Jitsi internal API that might be wrong, only on
// the browser's own navigation — which is exactly what "caught in an adverse
// loop keeping them out of all rooms" calls for.
//
// The button only appears while the performer is themselves being moved
// around (breakout.js and meeting-move.js each decide that for their own
// moves and call setPanicVisible), floating at the bottom right. Pressing it
// runs the onPanic handlers first — breakout.js uses that to tell the whole
// room, and both use it to exempt the performer from further moves — then
// rejoins. A meeting() move is a navigation within the same tab, so the
// captured URL is still the meeting the performer first joined.
//
// sessionStorage, not localStorage: a genuinely new tab/window should
// capture its OWN entry URL rather than inherit a stale one left by a
// previous tab — the same reasoning landmark-gesture-mode.js's mode flag
// uses for its own sessionStorage key.
//
// The rejoin turns Jitsi's prejoin screen off (skip-prejoin.js): someone
// reaching for this button should land back in the meeting, not on a
// "Join meeting" click.
//
// Deliberately import-free apart from skip-prejoin.js, which has no side
// effects: index.js imports this before anything else, so the entry URL is
// captured before any other module could redirect the page.

import { skipPrejoin } from './skip-prejoin.js';

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

const BUTTON_ID = 'trussal-panic-button';
// Long enough for the notification to leave this socket before the page goes.
const NOTIFY_GRACE_MS = 300;

const panicHandlers = new Set();
const visibleFor = new Set(); // sources that currently want the button up
let button = null;
let pressed = false;

// fn() runs when the performer presses the button, before the rejoin.
export function onPanic(fn) {
  panicHandlers.add(fn);
  return () => panicHandlers.delete(fn);
}

function ensureButton() {
  if (button || typeof document === 'undefined' || !document.body) return button;
  button = document.createElement('button');
  button.id = BUTTON_ID;
  button.type = 'button';
  button.hidden = true;
  button.textContent = 'Panic: back to main room';
  button.title = 'Leave breakout rooms and other meetings, rejoin the main room, and let everyone know';
  button.addEventListener('click', pressPanic);
  document.body.appendChild(button);
  return button;
}

// `source` names who is asking ('breakout', 'meeting'): the button shows
// while any of them wants it.
export function setPanicVisible(visible, source = 'breakout') {
  if (visible) visibleFor.add(source);
  else visibleFor.delete(source);
  const el = ensureButton();
  if (el) el.hidden = visibleFor.size === 0;
}

export function pressPanic() {
  if (pressed) return;
  pressed = true;
  if (button) button.disabled = true;
  for (const fn of panicHandlers) {
    try { fn(); } catch (e) { console.warn('[panic] handler threw', e); }
  }
  setTimeout(panic, panicHandlers.size ? NOTIFY_GRACE_MS : 0);
}

export function panic() {
  let url = null;
  try {
    if (typeof sessionStorage !== 'undefined') url = sessionStorage.getItem(KEY);
  } catch (e) { /* ignore */ }
  // No captured URL: rejoin WHATEVER room the browser is currently in.
  const target = skipPrejoin(url || window.location.href);
  // A URL differing from the current one only in its hash — always the case
  // when rejoining the room the browser is already in — is a same-document
  // navigation, not a reload, so put it in place and reload explicitly.
  const here = new URL(window.location.href);
  const there = new URL(target);
  here.hash = there.hash = '';
  if (here.href === there.href) {
    window.history.replaceState(window.history.state, '', target);
    window.location.reload();
  } else {
    window.location.href = target;
  }
}

// Run as early as this module is first imported — see index.js, which
// imports this before anything else could plausibly redirect the page.
captureMainRoomUrl();

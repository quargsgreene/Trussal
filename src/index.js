import { JAMULUS_ROOM_MAP , renderJamulusWelcomePanelAndBanner, getRoomNameFromUrl} from './jamulus.js';
import {renderPrejoinScreen, renderRecentListText, renderWelcomeOverlay, renderHideStartMeetingButton} from './welcome-page.js';
import {renderNoAudioToast} from './meeting.js';
import {renderAudioConfigCheck} from './audio-config-check.js';
import { sendLocalPattern, sendLocalPlaying, subscribePeerState } from './peer-state.js';
import { roomMapper, syncMapperFromPeerEvent } from './bridges/XMPPtoO2Mapper.js';
import './studio.js';

window.JAMULUS_ROOM_MAP = JAMULUS_ROOM_MAP;

// Keep the XMPP↔O2 mapping current: every peer with a room index gets an O2
// service name (/perf/<index>) the moment the sidecar announces it.
subscribePeerState((event, peer) => syncMapperFromPeerEvent(roomMapper, event, peer));

// Bots call this from inside their page once their Strudel REPL is running, to
// publish their pattern onto the peer-state bus so it shows (and can be edited)
// in every studio. strudel.js skips isBot peers in the combined mix, so marking
// the bot "playing" here doesn't double its audio.
window.__trussalAnnounceLocalPattern = (code) => {
  sendLocalPattern(typeof code === 'string' ? code : '');
  sendLocalPlaying(true);
};

// The aggregator bot taps remote participants' <audio> elements (id
// "remoteAudio_<jitsiId>") and needs to file each one's audio under its Net
// Cycles room-index token (0, 0a, 1, …). The room mapper above already keeps
// the jitsiId ↔ roomIndex bijection current, so expose the lookup to the page.
window.__trussalRoomIndexForJitsiId = (jitsiId) => roomMapper.roomIndexFor(jitsiId);

renderAudioConfigCheck();
renderJamulusWelcomePanelAndBanner();
renderRecentListText();
renderWelcomeOverlay();
renderHideStartMeetingButton();
renderPrejoinScreen();
renderNoAudioToast();

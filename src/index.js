import { JAMULUS_ROOM_MAP , renderJamulusWelcomePanelAndBanner, getRoomNameFromUrl} from './jamulus.js';
import {renderPrejoinScreen, renderRecentListText, renderWelcomeOverlay, renderHideStartMeetingButton} from './welcome-page.js';
import {renderNoAudioToast, renderReturnToLobbyOnMeetingEnd} from './meeting.js';
import {renderAudioConfigCheck} from './audio-config-check.js';
import { sendLocalPattern, sendLocalPlaying, subscribePeerState, getAllPeers, getLocalPeer, getPeerByJitsiId } from './peer-state.js';
import { electAggregator } from './aggregator-election.js';
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

// The aggregator bot's capture tap also needs to know whether a peer is
// ACTUALLY playing (vs merely present in the Jitsi conference) so a peer who
// has joined but not yet pressed play — or who has paused — never claims a
// turn in the rotation: presence alone would otherwise seat them and produce
// a silent slot exactly like an unremoved departure did before removeParticipant.
window.__trussalPeerIsPlaying = (jitsiId) => {
  const peer = getPeerByJitsiId(jitsiId);
  return !!(peer && peer.playing);
};

// The aggregator bot's page polls this to decide whether IT is the room's ACTIVE
// aggregator. Only one aggregator may stream at a time (see electAggregator):
// two active aggregators tap and re-emit each other's master, so both feed back
// and mute. True iff the local peer is the elected (lowest-room-index) aggregator
// — so a second aggregator that joins publishes nothing until the first leaves
// and it is promoted. Every browser client honors the same winner independently
// (latency-instrument's refreshAggregatorPeer), so bot and clients never disagree.
window.__trussalIsActiveAggregator = () => {
  const winner = electAggregator(getAllPeers());
  const local = getLocalPeer();
  return !!(winner && local && local.isAggregator && winner.jitsiId === local.jitsiId);
};

renderAudioConfigCheck();
renderJamulusWelcomePanelAndBanner();
renderRecentListText();
renderWelcomeOverlay();
renderHideStartMeetingButton();
renderPrejoinScreen();
renderNoAudioToast();
renderReturnToLobbyOnMeetingEnd();

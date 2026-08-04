import { JAMULUS_ROOM_MAP , renderJamulusWelcomePanelAndBanner, getRoomNameFromUrl} from './jamulus.js';
import {renderPrejoinScreen, renderRecentListText, renderWelcomeOverlay, renderHideStartMeetingButton} from './welcome-page.js';
import {renderNoAudioToast, renderReturnToLobbyOnMeetingEnd} from './meeting.js';
import {renderAudioConfigCheck} from './audio-config-check.js';
import { sendLocalPattern, sendLocalPlaying, subscribePeerState, getAllPeers, getLocalPeer, getPeerByJitsiId } from './peer-state.js';
import { electAggregator } from './aggregator-election.js';
import { roomMapper, syncMapperFromPeerEvent } from './bridges/XMPPtoO2Mapper.js';
import { installPublishedVideoOverride, startWithVideoMuted } from './published-video.js';
import { installHydraParamApi } from './hydra-params.js';
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
// and mute. True iff the local peer is the elected aggregator — so a second
// aggregator that joins publishes nothing until the first leaves and it is
// promoted. Every browser client honors the same winner independently
// (latency-instrument's refreshAggregatorPeer), so bot and clients never disagree.
window.__trussalIsActiveAggregator = () => {
  const winner = electAggregator(getAllPeers());
  const local = getLocalPeer();
  return !!(winner && local && local.isAggregator && winner.jitsiId === local.jitsiId);
};

// The mosaic re-executes participants' Hydra preambles, which may bind
// parameters to Strudel patterns via `H(...)`. Lend the aggregator the pattern
// half of Strudel so those animate instead of holding at a constant.
if (window.__trussalIsAggregator) installHydraParamApi();

// Before anything can ask for a camera. A participant's published video is
// their Hydra output or black — never the raw camera — so this has to be in
// place ahead of lib-jitsi-meet's first getUserMedia, and ahead of the
// video-off default, which only decides whether that canvas is sent.
//
// Bots are exempt, aggregator included (pageMarkBot sets this on both). They
// install their own getUserMedia override at document-start — before this
// bundle runs — and it already hands Jitsi the right canvas: a regular bot's
// Hydra canvas, or the aggregator's composited mosaic. Wrapping it again would
// publish a copy of a copy, and `startWithVideoMuted` here would fight the
// videoMuted flag their join URL already sets deliberately per bot kind.
if (!window.__trussalIsBot) {
  installPublishedVideoOverride();
  startWithVideoMuted();
}

renderAudioConfigCheck();
// renderJamulusWelcomePanelAndBanner();
renderRecentListText();
// The overlay is the ONLY way into a room from the welcome page, because
// renderHideStartMeetingButton() below hides Jitsi's native "Start meeting"
// button. Disabling one without the other leaves the address bar as the sole
// entrance, which is exactly what happened in bcf48ea.
renderWelcomeOverlay();
renderHideStartMeetingButton();
renderPrejoinScreen();
renderNoAudioToast();
renderReturnToLobbyOnMeetingEnd();

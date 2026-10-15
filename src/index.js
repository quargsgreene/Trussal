import './panic-button.js';
import {renderPrejoinScreen, renderRecentListText, renderWelcomeOverlay, renderHideStartMeetingButton} from './welcome-page.js';
import {renderNoAudioToast, renderReturnToLobbyOnMeetingEnd} from './meeting.js';
import { sendLocalPattern, sendLocalPlaying, subscribePeerState, getAllPeers, getLocalPeer, getPeerByJitsiId } from './peer-state.js';
import { electAggregator } from './aggregator-election.js';
import { roomMapper, syncMapperFromPeerEvent } from './bridges/XMPPtoO2Mapper.js';
import { installPublishedVideoOverride, startWithVideoMuted } from './published-video.js';
import { maybeBootstrapLibJitsi } from './lib-jitsi-bootstrap.js';
import { installHydraParamApi } from './hydra-params.js';
import { sampleDataRefAt } from './data-ref.js';
import { setDataRefReader } from './audio-net/ValuePattern.js';
import './theme-context.js';
import './studio.js';
import './landmark-gesture-mode.js';
import './docs-about.js';

setDataRefReader(sampleDataRefAt);
subscribePeerState((event, peer) => syncMapperFromPeerEvent(roomMapper, event, peer));

let lastAnnouncedPattern = null;
window.__trussalAnnounceLocalPattern = (code) => {
  const c = typeof code === 'string' ? code : '';
  lastAnnouncedPattern = c;
  sendLocalPattern(c);
  sendLocalPlaying(true);
};

subscribePeerState((event) => {
  if (event === 'connected' && lastAnnouncedPattern) {
    sendLocalPattern(lastAnnouncedPattern);
    sendLocalPlaying(true);
  }
});

window.__trussalRoomIndexForJitsiId = (jitsiId) => roomMapper.roomIndexFor(jitsiId);
window.__trussalJitsiIdForRoomIndex = (roomIndex) => roomMapper.jitsiIdForIndex(roomIndex);
window.__trussalPeerIsPlaying = (jitsiId) => {
  const peer = getPeerByJitsiId(jitsiId);
  return !!(peer && peer.playing);
};
window.__trussalIsActiveAggregator = () => {
  const winner = electAggregator(getAllPeers());
  const local = getLocalPeer();
  return !!(winner && local && local.isAggregator && winner.jitsiId === local.jitsiId);
};

if (window.__trussalIsAggregator) installHydraParamApi();
if (!window.__trussalIsBot) {
  installPublishedVideoOverride();
  startWithVideoMuted();
}

renderRecentListText();
renderWelcomeOverlay();
renderHideStartMeetingButton();
renderPrejoinScreen();
renderNoAudioToast();
renderReturnToLobbyOnMeetingEnd();

maybeBootstrapLibJitsi();

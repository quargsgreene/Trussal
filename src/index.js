import './panic-button.js';
import {renderPrejoinScreen, renderRecentListText, renderWelcomeOverlay, renderHideStartMeetingButton} from './welcome-page.js';
import {renderNoAudioToast, renderReturnToLobbyOnMeetingEnd} from './meeting.js';
import { sendLocalPattern, sendLocalPlaying, subscribePeerState, getAllPeers, getLocalPeer, getPeerByJitsiId, isAggregatorSlotTaken } from './peer-state.js';
import { electAggregator } from './aggregator-election.js';
import { roomMapper, syncMapperFromPeerEvent } from './bridges/XMPPtoO2Mapper.js';
import { installPublishedVideoOverride, startWithVideoMuted } from './published-video.js';
import { installHydraParamApi } from './hydra-params.js';
import { sampleDataRefAt } from './data-ref.js';
import { setDataRefReader } from './audio-net/ValuePattern.js';
import './theme-context.js';
import './studio.js';
import './landmark-gesture-mode.js';
import './docs-about.js';
import { onHmrDispose, hmrState } from './hmr-runtime.js';

setDataRefReader(sampleDataRefAt);
const unsubMapperSync = subscribePeerState((event, peer) => syncMapperFromPeerEvent(roomMapper, event, peer));

window.__trussalAnnounceLocalPattern = (code) => {
  const c = typeof code === 'string' ? code : '';
  hmrState.lastAnnouncedPattern = c;
  sendLocalPattern(c);
  sendLocalPlaying(true);
};

const unsubReannounce = subscribePeerState((event) => {
  if (event === 'connected' && hmrState.lastAnnouncedPattern) {
    sendLocalPattern(hmrState.lastAnnouncedPattern);
    sendLocalPlaying(true);
  }
});

// Dev only (onHmrDispose is a no-op in the production bundle): a hot update
// re-runs this module's top level, so the subscriptions above must be undone
// before the next pass subscribes again — see entry-hmr.js.
onHmrDispose(unsubMapperSync);
onHmrDispose(unsubReannounce);

window.__trussalRoomIndexForJitsiId = (jitsiId) => roomMapper.roomIndexFor(jitsiId);
window.__trussalJitsiIdForRoomIndex = (roomIndex) => roomMapper.jitsiIdForIndex(roomIndex);
window.__trussalPeerIsPlaying = (jitsiId) => {
  const peer = getPeerByJitsiId(jitsiId);
  return !!(peer && peer.playing);
};
window.__trussalIsActiveAggregator = () => {
  // A page the sidecar refused as a duplicate aggregator was never rostered, so
  // the election below would happily elect it the only aggregator its own
  // (empty-of-aggregators) view can see. The refusal is what settles it: no
  // election, no ingest, no streaming — and, on the bot side, a departure.
  if (isAggregatorSlotTaken()) return false;
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

window.__hmrProbe = (window.__hmrProbe || 0) + 1;

import './panic-button.js';
import './styles.css';
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
import './conductor-settings.js';
import './landmark-gesture-mode.js';
import './docs-about.js';
import { getLastAnnouncedPattern, setLastAnnouncedPattern } from './stable-state.js';

// The production shell normally loads /custom-config.css from body.html. Keep
// a fallback for a web image whose baked body.html predates the split: link
// the sibling stylesheet using the same cache-busting query as this script.
// Vite dev has already injected the imported stylesheet; the empty dev shim is
// harmless if this link is created there.
function ensureBundledStylesheet() {
  if (typeof document === 'undefined' || document.getElementById('trussal-styles')) return;
  const bundleUrl = typeof __TRUSSAL_BUNDLE_URL === 'string' && __TRUSSAL_BUNDLE_URL
    ? __TRUSSAL_BUNDLE_URL
    : (typeof location !== 'undefined' ? location.href : '');
  if (!bundleUrl) return;
  try {
    const base = new URL(bundleUrl, location.href);
    const href = new URL('custom-config.css', base);
    href.search = base.search;
    const link = document.createElement('link');
    link.id = 'trussal-styles';
    link.rel = 'stylesheet';
    link.href = href.href;
    document.head.appendChild(link);
  } catch {
    // A malformed script URL is not worth blocking app startup over.
  }
}

ensureBundledStylesheet();
setDataRefReader(sampleDataRefAt);
const unsubMapperSync = subscribePeerState((event, peer) => syncMapperFromPeerEvent(roomMapper, event, peer));

window.__trussalAnnounceLocalPattern = (code) => {
  const c = typeof code === 'string' ? code : '';
  setLastAnnouncedPattern(c);
  sendLocalPattern(c);
  sendLocalPlaying(true);
};

const unsubReannounce = subscribePeerState((event) => {
  const pattern = getLastAnnouncedPattern();
  if (event === 'connected' && pattern) {
    sendLocalPattern(pattern);
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

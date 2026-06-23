import { JAMULUS_ROOM_MAP , renderJamulusWelcomePanelAndBanner, getRoomNameFromUrl} from './jamulus.js';
import {renderPrejoinScreen, renderRecentListText, renderWelcomeOverlay, renderHideStartMeetingButton} from './welcome-page.js';
import {renderNoAudioToast} from './meeting.js';
import {renderAudioConfigCheck} from './audio-config-check.js';
import { sendLocalPattern, sendLocalPlaying } from './peer-state.js';
import './studio.js';

window.JAMULUS_ROOM_MAP = JAMULUS_ROOM_MAP;

// Bots call this from inside their page once their Strudel REPL is running, to
// publish their pattern onto the peer-state bus so it shows (and can be edited)
// in every studio. strudel.js skips isBot peers in the combined mix, so marking
// the bot "playing" here doesn't double its audio.
window.__trussalAnnounceLocalPattern = (code) => {
  sendLocalPattern(typeof code === 'string' ? code : '');
  sendLocalPlaying(true);
};

renderAudioConfigCheck();
renderJamulusWelcomePanelAndBanner();
renderRecentListText();
renderWelcomeOverlay();
renderHideStartMeetingButton();
renderPrejoinScreen();
renderNoAudioToast();

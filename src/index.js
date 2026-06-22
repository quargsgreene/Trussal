import { JAMULUS_ROOM_MAP , renderJamulusWelcomePanelAndBanner, getRoomNameFromUrl} from './jamulus.js';
import {renderPrejoinScreen, renderRecentListText, renderWelcomeOverlay, renderHideStartMeetingButton} from './welcome-page.js';
import {renderNoAudioToast} from './meeting.js';
import {renderAudioConfigCheck} from './audio-config-check.js';
import './studio.js';

window.JAMULUS_ROOM_MAP = JAMULUS_ROOM_MAP;

renderAudioConfigCheck();
renderJamulusWelcomePanelAndBanner();
renderRecentListText();
renderWelcomeOverlay();
renderHideStartMeetingButton();
renderPrejoinScreen();
renderNoAudioToast();

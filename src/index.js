import { JAMULUS_ROOM_MAP , renderJamulusWelcomePanelAndBanner, getRoomNameFromUrl} from './jamulus.js';
import {renderPrejoinScreen, renderRecentListText, renderWelcomeOverlay, renderHideStartMeetingButton} from './welcome-page.js';
import {renderNoAudioToast} from './meeting.js';
import './strudel.js';
import {createLatencyInstrument} from './latency-instrument.js';

window.JAMULUS_ROOM_MAP = JAMULUS_ROOM_MAP;

renderJamulusWelcomePanelAndBanner();
renderRecentListText();
renderWelcomeOverlay();
renderHideStartMeetingButton();
renderPrejoinScreen();
renderNoAudioToast();
createLatencyInstrument();

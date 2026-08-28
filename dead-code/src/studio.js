// ARCHIVED 2026-08-28 — moved out of src/studio.js as dead code.
//
// "Voice buttons" widget: buttons parsed out of lines like `*name: s("...")` in
// the personal editor. `renderVoiceButtons` looks for a `.ts-voice-btns`
// container, but no studio template ever renders one, so it always hit the
// `if (!area) return;` early-out — and nothing called it regardless. The
// `.ts-voice-btn*` rules still sit in src/studio.css (left in place: some are
// shared with the head-cursor dwell styling).
//
// Also here: the commented-out `onRelayClick()` handler, the studio-side UI for
// the archived Jamulus relay client (see dead-code/src/jamulus.js).
//
// If revived, these stayed in src/studio.js: `toggleButtonCode` (imported from
// './facial-gesture.js'), `OVERLAY_ID`, `setStatus`, `renderAll`, and the
// relay functions from './jamulus.js'.

const BTN_MARKER = ' // strudel-btn';

function parseVoiceButtons(code) {
  const buttons = [];
  const re = /^\*([a-zA-Z_$][a-zA-Z0-9_$]*)\s*:\s*(.+)$/mg;
  let m;
  while ((m = re.exec(code)) !== null) {
    const voiceCode = `${m[1]}: ${m[2].trim()}`;
    const isActive = code.includes(`\n${voiceCode}${BTN_MARKER}`);
    buttons.push({ name: m[1], voiceCode, isActive });
  }
  return buttons;
}

function renderVoiceButtons(container, code) {
  const area = container.querySelector('.ts-voice-btns');
  if (!area) return;
  const buttons = parseVoiceButtons(code);
  if (!buttons.length) { area.innerHTML = ''; return; }
  const esc = (s) => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
  area.innerHTML = buttons.map(b => {
    const label = b.name.length > 18 ? b.name.slice(0, 18) + '…' : b.name;
    return `<button class="ts-voice-btn${b.isActive ? ' on' : ''}" data-voice-code="${esc(b.voiceCode).replace(/"/g,'&quot;')}">▶ ${esc(label)}</button>`;
  }).join('');
  area.querySelectorAll('.ts-voice-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      toggleButtonCode(btn.dataset.voiceCode);
      // :not(.nc-code) — the Net Cycles textarea is also a .ts-code and comes
      // FIRST in the overlay, so a bare selector re-reads the personal
      // buttons out of the shared metaprogram.
      const ta = document.querySelector(`#${OVERLAY_ID} .ts-code:not(.nc-code)`);
      if (ta) renderVoiceButtons(container, ta.value);
    });
  });
}

// async function onRelayClick() {
//   if (isRelayConnected()) {
//     disconnectJamulusRelay();
//     setStatus('Relay disconnected');
//     renderAll();
//     return;
//   }
//   try {
//     setStatus('Connecting to Jamulus relay…');
//     await connectJamulusRelay();
//     setStatus('Relay connected — Jamulus audio through effects chain');
//     renderAll();
//   } catch (e) {
//     console.error('[studio] relay connect failed', e);
//     setStatus('Relay failed: ' + (e && e.message ? e.message : e));
//     renderAll();
//   }
// }

// Cycle highlighter: which performer's buffer is playing right now.
//
// A chip per participant token in the current program; a chip lights while
// that performer's slot is open. Slot events arrive ahead of time with
// network timestamps, so highlights are scheduled with the same
// network→local conversion the audio gates use — what lights up matches
// what is audible.
// Currently does nothing, should be like Strudel's cycle highlighter, but for the networked metaprogrammer. It should show which performer's buffer is playing right now.

import {
  subscribeSlotEvents,
  getProgramText,
  isNetCyclesActive,
  getQueueDepth
} from '../src/audio-net/Metaprogrammer.js';
import { parseMetaprogram } from '../src/audio-net/MetaprogrammerParser.js';

export function mountMetaprogrammerCycleHighlighter(container) {
  if (!container || container.querySelector('.nc-highlighter')) return null;

  const wrap = document.createElement('div');
  wrap.className = 'ts-section nc-highlighter';
  wrap.innerHTML = `
    <div class="ts-section-head">
      <div class="ts-section-title">Cycle</div>
      <div class="ts-meta nc-cycle-meta">idle</div>
    </div>
    <div class="ts-voice-btns nc-slot-chips"></div>
  `;
  container.appendChild(wrap);

  const chipsEl = wrap.querySelector('.nc-slot-chips');
  const metaEl = wrap.querySelector('.nc-cycle-meta');
  const timers = new Set();

  function tokensFromProgram() {
    const text = getProgramText();
    if (!text) return [];
    const { ast } = parseMetaprogram(text);
    const tokens = [];
    const seen = new Set();
    if (ast.participants) {
      const walk = (els) => {
        for (const el of els) {
          if (el.token && !seen.has(el.token)) { seen.add(el.token); tokens.push(el.token); }
          if (el.type === 'sequence') el.stacks.forEach(s => walk(s.elements));
          if (el.type === 'choice') el.options.forEach(walk);
        }
      };
      ast.participants.stacks.forEach(s => walk(s.elements));
    }
    return tokens;
  }

  function renderChips() {
    chipsEl.innerHTML = tokensFromProgram()
      .map(tok => `<span class="ts-voice-btn nc-slot-chip" data-token="${tok}">${tok}</span>`)
      .join('');
  }
  renderChips();
  document.addEventListener('trussal-netcycles-program', renderChips);

  // Slot events carry network time `t`; the scheduler emits them within its
  // lookahead, so a plain delay from "now" tracks the audio gates closely.
  let lastCycleStart = null;
  subscribeSlotEvents((ev) => {
    if (!isNetCyclesActive()) return;
    if (ev.type === 'cycle-start') {
      lastCycleStart = ev;
      const delay = Math.max(0, (ev.t - (performanceNowSeconds())) * 1000);
      schedule(() => {
        metaEl.textContent = `cycle ${ev.cycle} · ${ev.seconds.toFixed(2)} s · ${ev.beats} beats`;
      }, delay, ev);
      return;
    }
    const chip = () => chipsEl.querySelector(`[data-token="${CSS.escape(ev.token)}"]`);
    if (ev.type === 'slot-open') {
      schedule(() => {
        const el = chip();
        if (el) {
          el.classList.add('on');
          el.title = `queue depth ${getQueueDepth(ev.token)}`;
        }
      }, relDelayMs(ev.t), ev);
    } else if (ev.type === 'slot-close') {
      schedule(() => {
        const el = chip();
        if (el) el.classList.remove('on');
      }, relDelayMs(ev.t), ev);
    }
  });

  // The scheduler's `now` is network time; events arrive ≤ lookahead before
  // their timestamp. Convert via "time until t at emission" measured on the
  // wall clock: emission happens at ~(t − lookahead_remaining).
  let refNet = null, refWall = null;
  function performanceNowSeconds() { return performance.now() / 1000; }
  function relDelayMs(tNet) {
    // First event anchors network time onto the wall clock.
    if (refNet == null) { refNet = tNet; refWall = performanceNowSeconds(); }
    return Math.max(0, ((tNet - refNet) - (performanceNowSeconds() - refWall)) * 1000);
  }
  function schedule(fn, ms, ev) {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    timers.add(t);
  }

  document.addEventListener('trussal-netcycles-mode', (e) => {
    if (!e.detail.active) {
      for (const t of timers) clearTimeout(t);
      timers.clear();
      refNet = refWall = null;
      metaEl.textContent = 'idle';
      chipsEl.querySelectorAll('.on').forEach(el => el.classList.remove('on'));
    }
  });

  return wrap;
}

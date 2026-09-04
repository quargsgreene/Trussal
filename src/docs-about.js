// docs-about.js — the welcome-page Docs / About corner.
//
// Two buttons, top-right of the welcome page, positioned to sit immediately
// left of Jitsi's own settings gear (`.welcome-page-settings` — see
// docker-jitsi-meet/jitsi-web/custom.css, which already names it "the
// welcome-page settings gear"). That gear is a React-owned element we must
// not touch or append into (a re-render would wipe anything grafted onto it),
// so — the same pattern landmark-gesture-mode.js and studio.js use — this
// mounts as its own fixed-position corner appended to document.body, and
// reads the gear's live bounding rect to stay glued to its left edge as the
// window resizes or the welcome page re-renders.
//
// Docs and About are each a centered modal panel. Docs documents the JPattern
// (metaprogram) language end to end: what each `#`-directive/chained function
// does, its syntax, and a short example — the language `src/audio-net/
// MetaprogrammerParser.js` actually parses, kept in sync with
// `src/features/jpattern.md` and `src/features/turn-ring.md`. About is a
// short plain-language summary of what Trussal is.

const CORNER_ID    = 'trussal-da-corner';
const DOCS_BTN_ID  = 'trussal-da-docs-btn';
const ABOUT_BTN_ID = 'trussal-da-about-btn';
const DOCS_ID      = 'trussal-da-docs-scrim';
const ABOUT_ID     = 'trussal-da-about-scrim';
const STYLE_ID     = 'trussal-da-style';

import styles from './docs-about.css';

// ---------------------------------------------------------------------------
// Content — the JPattern function reference.
// ---------------------------------------------------------------------------
const JPATTERN_FUNCTIONS = [
  {
    name: '$ participants — the scheduling sequence',
    sig: '$ participants <token token …>\n$ <token token …>            (the "participants" label is optional)',
    body: `
      <p>Opens the metaprogram's one scheduling voice: the sequence of tokens
      that take turns streaming, in the order a <code>&lt;…&gt;</code>
      alternation names them. A token is a participant's room index — <code>0</code>
      for the first person to join a room, <code>1</code> the second, and so on
      — or a bot's index plus a letter suffix (<code>0a</code>, the first
      person's first bot; <code>0zb</code>, a later one). Under the default
      <code># ring hash</code> (see below) the sequence's own contents don't
      decide who plays — everyone present takes turns automatically — but the
      statement must still be there, since the grammar requires a
      <code>$</code> voice.</p>
      <p>Turn-modifying operators are written glued to the token, no spaces:</p>
      <table>
        <tr><th>Operator</th><th>Effect</th></tr>
        <tr><td><code>0@n</code></td><td>0 holds the ring for <em>n</em> cycles (in <code>&lt;…&gt;</code>) or a share of one cycle (in <code>[…]</code>).</td></tr>
        <tr><td><code>0!n</code></td><td>0 takes n turns in a row. Bare <code>!</code> means <code>!2</code>.</td></tr>
        <tr><td><code>0?</code> / <code>0?p</code></td><td>0's turn is silently dropped with probability 0.5 (or <em>p</em>) — the cycle still advances.</td></tr>
        <tr><td><code>&lt;…&gt;*n</code> / <code>/n</code> / <code>%n</code></td><td>Speeds up, slows down, or fixes the steps-per-cycle of the whole ring.</td></tr>
        <tr><td><code>0*n</code> / <code>0/n</code></td><td>The same, applied to one token's own slot only.</td></tr>
      </table>
      <p><code>0 .. 3</code> (or <code>0..3</code>) is a range, expanding to <code>0 1 2 3</code>.</p>
      <pre>'metaprogram editor'
$ participants &lt;0@2 1!3 0a?&gt;*2
# cycles "wcl" 20</pre>`,
  },
  {
    name: '# ring — how the rotation order is chosen',
    sig: '# ring hash [w <token> <weight> …]\n# ring explicit',
    body: `
      <p><code>hash</code> (the default in a fresh room) computes the rotation
      as a consistent hash of whoever is <em>currently present</em>, reseeded
      every cycle — joins and leaves reorder almost nothing else. <code>w</code>
      pairs give individual tokens a bigger share of turns (<code>w 0 3</code>
      is triple weight for token <code>0</code>); weights are only legal under
      <code>hash</code>.</p>
      <p><code>explicit</code> is the plain literal walk: the ring is exactly
      what <code>$ participants &lt;…&gt;</code> lists, and anyone not listed
      stays silent. An older program with no <code># ring</code> line at all
      behaves as <code>explicit</code>.</p>
      <pre># ring hash w 0 3 2a 2</pre>`,
  },
  {
    name: '# cycles — the length of one cycle (and one turn)',
    sig: '# cycles "wcl" | "wcpl"  [scale factor]  [fixed amount]',
    body: `
      <p>Sets how long one cycle — and so one performer's turn — lasts, as a
      multiple of a live network metric: <code>"wcl"</code> (worst-case
      mouth-to-ear latency) or <code>"wcpl"</code> (worst-case packet loss).
      With just a scale factor the target tracks the metric live:
      <code># cycles "wcl" 3</code> is 3× the current WCL. A third number
      <em>pins</em> the metric at that fixed value (seconds for wcl, a 0–1
      fraction for wcpl) while the scale still multiplies it — everything
      else (effect intensities, the readout) keeps following the real
      network. Exactly one <code># cycles</code> line is allowed per
      program. Metric names are always quoted.</p>
      <pre># cycles "wcl" 10 0.3   <span style="opacity:.7">// WCL pinned at 300ms, scaled ×10 → every cycle is 3s</span></pre>`,
  },
  {
    name: '# tempo — quantization tempo',
    sig: '# tempo <number>[/<int>]  bpm | cps | cpm',
    body: `
      <p>Sets the tempo cycle boundaries quantize against. Takes a quantity
      (a plain number, or a fraction like <code>90/4</code>) and a unit:
      beats, cycles, or cycles per minute. No <code># tempo</code> line is
      injected by default — an unwritten tempo still falls back to 120bpm
      for quantization purposes.</p>
      <pre># tempo 90/4 cpm</pre>`,
  },
  {
    name: '# room — reverb (audio), blur (video/css), letter-spacing (text)',
    sig: '# room <"wcl"|"wcpl"|"wcrtt"> [scale] [fixed amount] [medium set]',
    body: `
      <p>A Schroeder reverb whose decay time is <em>scale</em> × the metric,
      in seconds — longer decay also closes a cascaded lowpass, so a long
      tail is a darker one. Runs once on the room's shared mix, not per
      client. The same decay drives a blur on the composited video and on
      styled chat text, and widens letter-spacing. Any of the three worst-case
      metrics may drive it, and every argument accepts a mini-notation pattern
      (<code>&lt;a b&gt;</code>, <code>[a b]</code>, with <code>@ ? ! * /</code>)
      instead of a constant. A trailing <code>[<wbr>"audio" "video"<wbr>]</code>
      set narrows which of the four media (<code>audio css text video</code>)
      the directive touches — omitted means all four.</p>
      <pre># room "wcl" 2 0.4        <span style="opacity:.7">// fixed 800ms decay</span>
# room "wcl" 2 ["audio" "video"]</pre>`,
  },
  {
    name: '# crush — bitcrush (audio), pixelation (video/css/text)',
    sig: '# crush <"wcl"|"wcpl"|"wcrtt"> [scale] [fixed amount] [medium set]',
    body: `
      <p>Reduces bit-depth and sample rate as the metric worsens — 8 bits is
      the resting depth, halving each time the metric climbs by its halving
      amount, down to a 1-bit square wave on a bad enough network. Bypassed
      until written. <em>scale</em> multiplies the resting depth (2 doubles
      it to 16-bit; below 1 crushes harder). Runs once on the shared mix,
      same medium-set and pattern-argument rules as <code># room</code>.</p>
      <pre># crush "wcpl" 1 0.25    <span style="opacity:.7">// pinned at 25% loss: a steady 4 bits</span></pre>`,
  },
  {
    name: '# echo — feedback delay',
    sig: '# echo <metric> <length> <metric> <feedback> <metric> <gain>  [bound bound bound]  [medium set]',
    body: `
      <p>Three independently-metric-driven parameters — all six of the first
      arguments are required together, or omit the whole directive for the
      bare default (<code>wcl</code> driving all three). <em>length</em> is in
      cycles (a fraction like <code>1/2</code> is legal), so the echo stays in
      rhythm as the cycle length changes. <em>feedback</em> is clamped below
      unity so it can never self-oscillate, and also darkens the composited
      video as it rises. <em>gain</em> is the wet/dry balance. Each value is
      <code>scale × min(metric / bound, 1)</code> — the optional bounds (ms
      for wcl/wcrtt, percent for wcpl) cap how far a degrading network can
      push it. <code>wcrtt</code> is legal here even though
      <code># cycles</code> can't use it.</p>
      <pre># echo "wcl" 2 "wcpl" 0.3 "wcrtt" 3 1500 20 1200</pre>`,
  },
  {
    name: '# noise — noise bed (audio), grain (video/css/text)',
    sig: '# noise [<metric>] [spectrum factor] [<metric>] [volume factor] [fixed 1] [fixed 2]  [medium set]',
    body: `
      <p>Bypassed by default (no node exists until written). Two metrics —
      each defaulting to <code>wcl</code> and each optional — independently
      drive the bed's <em>spectrum</em> (0 brown … 1 white) and its
      <em>volume</em> (25dB … 75dB, clamped). A metric keyword binds to the
      factor written right after it. Re-derived once per cycle boundary, so
      its arguments take <code>&lt;…&gt;</code> alternation at rate 1 or
      slower only — <code>[…]</code> and a faster rate are parse errors here.</p>
      <pre># noise "wcl" 20 "wcrtt" 10</pre>`,
  },
  {
    name: '# grid — the per-participant distance overlay',
    sig: '# grid [landmarks: true|false]        (default false)',
    body: `
      <p>Marks each participant's video panel with a small grayscale circle
      (darker = a greater modelled network distance) in the top-left corner;
      your own panel's circle is always white from your own browser. With
      <code>landmarks</code> on, a participant running MediaPipe also gets a
      vector in the bottom-right showing their average facial-landmark
      motion. Unrelated to <code># mosaic</code>.</p>
      <pre># grid true</pre>`,
  },
  {
    name: '# mosaic — the aggregator\'s video layout',
    sig: '# mosaic [true|false]        (default true — unwritten means on)',
    body: `
      <p>Controls how the room's published video is composited. On (the
      default) tiles every Hydra-running participant into a square grid, only
      ticking whoever currently holds the turn. <code>false</code> drops to a
      single full-frame view of just the streaming participant.</p>
      <pre># mosaic false</pre>`,
  },
  {
    name: '# ply — repeat each turn\'s buffer n times',
    sig: '# ply <n>',
    body: `<p>Same as Strudel's <code>.ply()</code>: subdivides each turn's
      buffer into <em>n</em> repeats.</p>
      <pre># ply 2</pre>`,
  },
  {
    name: '# chop — chop each turn\'s buffer into n pieces',
    sig: '# chop <n>',
    body: `<p>Same as Strudel's <code>.chop()</code>: slices each turn's
      buffer into <em>n</em> consecutive pieces.</p>
      <pre># chop 2</pre>`,
  },
  {
    name: '# shuffle — randomize buffer-piece order',
    sig: '# shuffle [n]',
    body: `<p>Same as Strudel's <code>.shuffle()</code>: randomizes the order
      of (optionally, <em>n</em>) buffer pieces, seeded so every listener
      hears the same shuffle.</p>`,
  },
  {
    name: '# degrade / # degradeBy — drop events at random',
    sig: '# degrade\n# degradeBy <probability 0–1>',
    body: `<p><code>degrade</code> drops events at the fixed 50% Strudel
      default; <code>degradeBy</code> takes an explicit probability. Seeded,
      so the draw is identical for every listener.</p>
      <pre># degradeBy 0.25</pre>`,
  },
  {
    name: '# undegrade / # undegradeBy — the inverse of degrade',
    sig: '# undegrade\n# undegradeBy <probability 0–1>',
    body: `<p>Keeps only the events <code>degrade</code>/<code>degradeBy</code>
      would have dropped — the complementary draw, same seed.</p>`,
  },
  {
    name: '# hush — silence the voice',
    sig: '# hush',
    body: `<p>Same as Strudel's <code>.hush()</code>: mutes the chained
      voice's output entirely without removing it from the scheduling
      sequence.</p>`,
  },
  {
    name: '# jux — a stacked, cycle-offset duplicate',
    sig: '# jux',
    body: `<p>Duplicates the voice, offsetting the copy by one cycle — the
      metaprogram analog of Strudel's <code>.jux()</code>/the stack
      (<code>,</code>) operator.</p>`,
  },
  {
    name: '# superimpose — layer a second sequence on top',
    sig: '# superimpose [<sequence>]',
    body: `<p>Like <code># jux</code>, but the optional bracketed sequence
      lets the superimposed layer be a different pattern, not a plain copy.</p>
      <pre># superimpose &lt;0 2&gt;</pre>`,
  },
  {
    name: 'Button declarations — *$ / *#',
    sig: '*$ participants <tokens>       // a voice, waiting for its button\n*# crush "wcl" 2               // an effect, waiting for its button',
    body: `
      <p>A statement written with a leading <code>*</code> is a
      <strong>declaration</strong>, not a live statement — it's skipped by
      the parser and instead rendered as a button under the JPattern editor
      (also reachable by head-cursor dwell). Pressing a
      <code>*$ participants …</code> button merges its tokens into the live
      ring; pressing it again removes them. Pressing a
      <code>*# …</code> effect button appends that directive line (pressing
      again comments it back out). A declaration is one line, and may carry
      a trailing <code>//</code> comment.</p>`,
  },
];

// ---------------------------------------------------------------------------
// Content — About.
// ---------------------------------------------------------------------------
const ABOUT_HTML = `
  <p><strong>Trussal</strong> is a networked algorave platform — a room where
  every participant is also an instrument. It's built on top of Jitsi Meet,
  with a live-coding music engine (<a href="https://strudel.cc" target="_blank" rel="noopener">Strudel</a>),
  Hydra visual synthesis, and per-peer audio effects that respond to the
  room's own network conditions layered on top.</p>
  <p>Each participant runs their own personal Strudel + Hydra editor in the
  <strong>Trussal Studio</strong> panel, and the room's <strong>JPattern</strong>
  (metaprogram) editor — shared by everyone via CRDT — decides whose output
  plays when, and lets network-driven effects (reverb, bitcrush, delay,
  noise, and more) run on the room's combined mix. See the <strong>Docs</strong>
  button for the full JPattern reference.</p>
  <p><strong>Landmark &amp; Gesture Mode</strong> (the ☰ menu, top-left, or
  press → three times) turns on an on-screen keyboard, a MediaPipe head
  cursor, and facial-gesture control, so the whole editor can be driven
  hands-free.</p>
  <p>A room can also host <strong>bots</strong> — headless Puppeteer
  performers a participant spawns and configures from the Studio panel —
  whose combined audio and video is streamed into the room by an aggregator.</p>
`;

// ---------------------------------------------------------------------------
// DOM.
// ---------------------------------------------------------------------------
function _injectStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = styles;
  document.head.appendChild(s);
}

// fn.sig is plain text containing literal `<token>`-style placeholders —
// escape it before interpolating into innerHTML, or the angle brackets are
// parsed as markup instead of shown. fn.name and fn.body are authored HTML
// (body deliberately so, for its <code>/<pre>/<table> markup).
function _escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function _buildDocsBody() {
  const toc = JPATTERN_FUNCTIONS
    .map((fn, i) => `<a data-jump="${i}">${fn.name.split(' — ')[0]}</a>`)
    .join('');
  const fns = JPATTERN_FUNCTIONS
    .map((fn, i) => `
      <div class="da-fn" id="trussal-da-fn-${i}">
        <div class="da-fn-name">${fn.name}</div>
        <code class="da-fn-sig">${_escapeHtml(fn.sig)}</code>
        ${fn.body}
      </div>`)
    .join('');
  return `
    <h3 id="trussal-da-usage">Basic usage</h3>
    <p>Once you're in a room, click <strong>Studio</strong> (bottom-left) to
    open Trussal Studio. It has one card per performer for their personal
    Strudel + Hydra editor, plus one shared <strong>JPattern</strong> card
    that everyone in the room edits together.</p>
    <p>Every editor buffer opens with a required directive on its first line
    — <code>'personal editor'</code>, <code>'bot editor'</code>, or
    <code>'metaprogram editor'</code> for the JPattern card — that's already
    prefilled; leave it in place.</p>
    <p>A buffer is written entirely in one of two notations, never mixed:
    <strong>mondo</strong> (<code>$ participants &lt;0 1&gt;</code> then one
    <code># directive …</code> per line — what every example on this page
    uses) or <strong>mini</strong>, Strudel's own dot-chained spelling of the
    same thing (<code>$: participants("&lt;0 1&gt;").cycles("wcl", 10)</code>).</p>
    <p>Write or edit the program in the JPattern card and press
    <strong>▶ Apply</strong> to push it to the whole room. Any line prefixed
    with <code>*</code> is a <em>declaration</em> instead — it renders as a
    button under the editor rather than running immediately (see "Button
    declarations" below).</p>
    <p>For hands-free editing, see <strong>Landmark &amp; Gesture Mode</strong>
    (☰ menu, top-left of any screen, or press → three times) — it adds an
    on-screen keyboard and a head-cursor you can dwell-click with.</p>
    <h3>JPattern function reference</h3>
    <p>Every directive below is written on its own line, chained onto the
    <code>$ participants</code> voice. This is the language
    <code>src/audio-net/MetaprogrammerParser.js</code> parses — kept in sync
    with <code>src/features/jpattern.md</code> and
    <code>src/features/turn-ring.md</code> in the repository.</p>
    <div class="da-toc">${toc}</div>
    ${fns}
  `;
}

function _buildPanel(id, titleText, bodyHtml) {
  const scrim = document.createElement('div');
  scrim.id = id;
  scrim.className = 'trussal-da-scrim';
  scrim.innerHTML = `
    <div class="trussal-da-panel">
      <div class="da-head">
        <h2>${titleText}</h2>
        <button class="da-close" type="button" title="Close">✕</button>
      </div>
      <div class="da-body">${bodyHtml}</div>
    </div>
  `;
  // Trussal's other overlays stop mousedown/click here for the same reason:
  // Jitsi's own popovers close themselves on any click that bubbles to
  // document without landing inside their own DOM, so without this an
  // interaction inside this panel would read to Jitsi as an outside click.
  scrim.querySelector('.trussal-da-panel').addEventListener('mousedown', (e) => e.stopPropagation());
  scrim.querySelector('.trussal-da-panel').addEventListener('click', (e) => e.stopPropagation());
  const close = () => scrim.classList.remove('open');
  scrim.addEventListener('click', close); // click on the scrim itself (not the panel, stopped above)
  scrim.querySelector('.da-close').addEventListener('click', close);
  document.body.appendChild(scrim);
  return scrim;
}

function _ensureDOM() {
  if (document.getElementById(CORNER_ID)) return;
  if (!document.body) return;
  _injectStyles();

  const corner = document.createElement('div');
  corner.id = CORNER_ID;
  corner.innerHTML = `
    <button id="${DOCS_BTN_ID}" type="button">Docs</button>
    <button id="${ABOUT_BTN_ID}" type="button">About</button>
  `;
  corner.addEventListener('mousedown', (e) => e.stopPropagation());
  corner.addEventListener('click', (e) => e.stopPropagation());
  document.body.appendChild(corner);

  const docsScrim = _buildPanel(DOCS_ID, 'JPattern Docs', _buildDocsBody());
  _buildPanel(ABOUT_ID, 'About Trussal', ABOUT_HTML);

  // Jump-to-function links in the docs table of contents.
  docsScrim.querySelectorAll('.da-toc a').forEach((a) => {
    a.addEventListener('click', () => {
      const target = docsScrim.querySelector(`#trussal-da-fn-${a.dataset.jump}`);
      if (target) target.scrollIntoView({ block: 'start' });
    });
  });

  document.getElementById(DOCS_BTN_ID).addEventListener('click', () => {
    document.getElementById(ABOUT_ID).classList.remove('open');
    document.getElementById(DOCS_ID).classList.add('open');
  });
  document.getElementById(ABOUT_BTN_ID).addEventListener('click', () => {
    document.getElementById(DOCS_ID).classList.remove('open');
    document.getElementById(ABOUT_ID).classList.add('open');
  });
}

// Jitsi's own welcome-page settings gear — see docker-jitsi-meet/jitsi-web/
// custom.css, which already calls this class "the welcome-page settings
// gear". It's centered inside a fixed-width content column rather than
// pinned to the viewport edge, so a static CSS offset can't track it — read
// its live position instead.
const GEAR_SELECTOR = '.welcome-page-settings, [aria-label="Open settings" i]';

function _positionCorner() {
  const corner = document.getElementById(CORNER_ID);
  if (!corner) return;
  const gear = document.querySelector(GEAR_SELECTOR);
  if (gear) {
    const r = gear.getBoundingClientRect();
    const cw = corner.offsetWidth || 0;
    const ch = corner.offsetHeight || 0;
    corner.style.right = '';
    corner.style.left = `${Math.max(8, r.left - cw - 10)}px`;
    corner.style.top = `${Math.max(8, r.top + (r.height - ch) / 2)}px`;
  } else {
    corner.style.left = '';
    corner.style.top = '10px';
    corner.style.right = '10px';
  }
}

let _posPending = false;
function _schedulePosition() {
  if (_posPending) return;
  _posPending = true;
  requestAnimationFrame(() => { _posPending = false; _positionCorner(); });
}

function _onWelcomePage() {
  return !!(document.body && document.body.classList.contains('welcome-page'));
}

function _boot() {
  let tries = 0;
  const maxTries = 40; // ~10s at 250ms, same budget welcome-page.js's own poll uses
  const timer = setInterval(() => {
    tries += 1;
    if (_onWelcomePage()) {
      _ensureDOM();
      _schedulePosition();
    }
    if (document.getElementById(CORNER_ID) || tries >= maxTries) clearInterval(timer);
  }, 250);

  window.addEventListener('resize', _schedulePosition);

  // The welcome page keeps re-rendering (recent-meetings list, the settings
  // gear itself) well after first paint — reposition whenever it does.
  const obs = new MutationObserver(_schedulePosition);
  obs.observe(document.documentElement || document.body, { childList: true, subtree: true });
}

function init() {
  if (window.__trussalIsBot || window.__trussalIsAggregator) return;
  if (document.readyState === 'complete' || document.readyState === 'interactive') _boot();
  else window.addEventListener('DOMContentLoaded', _boot);
}

init();

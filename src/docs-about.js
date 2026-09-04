// docs-about.js — the welcome-page Docs / About corner.
//
// Two buttons, fixed bottom-right of the welcome page — a plain-CSS corner
// (docs-about.css), appended to document.body the same way
// landmark-gesture-mode.js's own corner is, since it must not be grafted
// into any of Jitsi's own React-owned DOM (a re-render would wipe it). An
// earlier version sat top-right, tracking the live position of Jitsi's own
// settings gear (`.welcome-page-settings`) to stay just left of it — that
// covered (and ate clicks meant for) the gear itself, so it was moved down
// here instead; see the removed `_positionCorner` in git history for the
// bug if this ever needs resurrecting.
//
// Docs and About are each a centered modal panel. Docs documents the JPattern
// (metaprogram) language end to end: what each chained function does, its
// syntax, and a short example — the language `src/audio-net/
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
    id: 'jp-participants',
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
    id: 'jp-ring',
    name: 'ring — how the rotation order is chosen',
    sig: 'ring hash [w <token> <weight> …]\nring explicit',
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
    id: 'jp-cycles',
    name: 'cycles — the length of one cycle (and one turn)',
    sig: 'cycles "wcl" | "wcpl"  [scale factor]  [fixed amount]',
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
    id: 'jp-tempo',
    name: 'tempo — quantization tempo',
    sig: 'tempo <number>[/<int>]  bpm | cps | cpm',
    body: `
      <p>Sets the tempo cycle boundaries quantize against. Takes a quantity
      (a plain number, or a fraction like <code>90/4</code>) and a unit:
      beats, cycles, or cycles per minute. No <code># tempo</code> line is
      injected by default — an unwritten tempo still falls back to 120bpm
      for quantization purposes.</p>
      <pre># tempo 90/4 cpm</pre>`,
  },
  {
    id: 'jp-room',
    name: 'room — reverb (audio), blur (video/css), letter-spacing (text)',
    sig: 'room <"wcl"|"wcpl"|"wcrtt"> [scale] [fixed amount] [medium set]',
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
    id: 'jp-crush',
    name: 'crush — bitcrush (audio), pixelation (video/css/text)',
    sig: 'crush <"wcl"|"wcpl"|"wcrtt"> [scale] [fixed amount] [medium set]',
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
    id: 'jp-echo',
    name: 'echo — feedback delay',
    sig: 'echo <metric> <length> <metric> <feedback> <metric> <gain>  [bound bound bound]  [medium set]',
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
    id: 'jp-noise',
    name: 'noise — noise bed (audio), grain (video/css/text)',
    sig: 'noise [<metric>] [spectrum factor] [<metric>] [volume factor] [fixed 1] [fixed 2]  [medium set]',
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
    id: 'jp-grid',
    name: 'grid — the per-participant distance overlay',
    sig: 'grid [landmarks: true|false]        (default false)',
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
    id: 'jp-mosaic',
    name: 'mosaic — the aggregator\'s video layout',
    sig: 'mosaic [true|false]        (default true — unwritten means on)',
    body: `
      <p>Controls how the room's published video is composited. On (the
      default) tiles every Hydra-running participant into a square grid, only
      ticking whoever currently holds the turn. <code>false</code> drops to a
      single full-frame view of just the streaming participant.</p>
      <pre># mosaic false</pre>`,
  },
  {
    id: 'jp-ply',
    name: 'ply — repeat each turn\'s buffer n times',
    sig: 'ply <n>',
    body: `<p>Same as Strudel's <code>.ply()</code>: subdivides each turn's
      buffer into <em>n</em> repeats.</p>
      <pre># ply 2</pre>`,
  },
  {
    id: 'jp-chop',
    name: 'chop — chop each turn\'s buffer into n pieces',
    sig: 'chop <n>',
    body: `<p>Same as Strudel's <code>.chop()</code>: slices each turn's
      buffer into <em>n</em> consecutive pieces.</p>
      <pre># chop 2</pre>`,
  },
  {
    id: 'jp-shuffle',
    name: 'shuffle — randomize buffer-piece order',
    sig: 'shuffle [n]',
    body: `<p>Same as Strudel's <code>.shuffle()</code>: randomizes the order
      of (optionally, <em>n</em>) buffer pieces, seeded so every listener
      hears the same shuffle.</p>`,
  },
  {
    id: 'jp-degrade',
    name: 'degrade / degradeBy — drop events at random',
    sig: 'degrade\ndegradeBy <probability 0–1>',
    body: `<p><code>degrade</code> drops events at the fixed 50% Strudel
      default; <code>degradeBy</code> takes an explicit probability. Seeded,
      so the draw is identical for every listener.</p>
      <pre># degradeBy 0.25</pre>`,
  },
  {
    id: 'jp-undegrade',
    name: 'undegrade / undegradeBy — the inverse of degrade',
    sig: 'undegrade\nundegradeBy <probability 0–1>',
    body: `<p>Keeps only the events <code>degrade</code>/<code>degradeBy</code>
      would have dropped — the complementary draw, same seed.</p>`,
  },
  {
    id: 'jp-hush',
    name: 'hush — silence the voice',
    sig: 'hush',
    body: `<p>Same as Strudel's <code>.hush()</code>: mutes the chained
      voice's output entirely without removing it from the scheduling
      sequence.</p>`,
  },
  {
    id: 'jp-jux',
    name: 'jux — a stacked, cycle-offset duplicate',
    sig: 'jux',
    body: `<p>Duplicates the voice, offsetting the copy by one cycle — the
      metaprogram analog of Strudel's <code>.jux()</code>/the stack
      (<code>,</code>) operator.</p>`,
  },
  {
    id: 'jp-superimpose',
    name: 'superimpose — layer a second sequence on top',
    sig: 'superimpose [<sequence>]',
    body: `<p>Like <code># jux</code>, but the optional bracketed sequence
      lets the superimposed layer be a different pattern, not a plain copy.</p>
      <pre># superimpose &lt;0 2&gt;</pre>`,
  },
  {
    id: 'jp-buttons',
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
// Content — Text Cycles (src/text-cycles.js, src/features/textcycles.md).
// Not JPattern `#` directives — Strudel functions available in the personal
// / bot editor once a buffer opens with `await initTextCycles()`.
// ---------------------------------------------------------------------------
const TEXT_CYCLES_FUNCTIONS = [
  {
    id: 'tc-init',
    name: 'await initTextCycles() — declare a text presence',
    sig: 'await initTextCycles()',
    body: `
      <p>Goes in the buffer's preamble, the same way <code>await initHydra()</code>
      declares visuals — first line, blank line, then the patterns. A voice
      carrying <code>word()</code>/<code>w()</code> paints one styled
      <code>&lt;span&gt;</code> per hap into the Jitsi chat panel instead of
      making sound — one bubble per cycle per performer, so a fast pattern
      fills a line rather than flooding the panel. It enters the chat on the
      performer's behalf (Jitsi otherwise hides the message log behind a
      nickname prompt), using their JPattern room index as the nickname.
      Nothing is sent over XMPP: every browser evaluates every peer's program
      already, so each client paints the same words from the shared program.</p>
      <pre>await initTextCycles()

$: word("I like squirrels").typeface('Times New Roman')</pre>`,
  },
  {
    id: 'tc-word',
    name: 'word() / w() — the text itself',
    sig: '.word("<mini-notation pattern>")\n.w("<mini-notation pattern>")        (alias)',
    body: `
      <p>Every double-quoted text param is mini notation, same as any other
      Strudel control — a bare space is a sequence separator, not a space in
      the words. A few characters need escaping to render literally:</p>
      <table>
        <tr><th>Written</th><th>Renders</th></tr>
        <tr><td><code>word("&lt;a ~ b&gt;")</code></td><td><code>a</code>, a rest, <code>b</code></td></tr>
        <tr><td><code>word("&lt;a \\~ b&gt;")</code></td><td><code>a</code>, a literal <code>~</code>, <code>b</code></td></tr>
        <tr><td><code>word("squirrels?")</code></td><td><code>squirrels</code>, played only sometimes</td></tr>
        <tr><td><code>word("squirrels\\?")</code></td><td><code>squirrels?</code> every cycle</td></tr>
      </table>
      <p>Single quotes opt out of mini entirely, so a phrase with its own
      spaces needs no escaping at all: <code>word('I like squirrels?')</code>
      is one whole phrase, one hap. The same rule applies to every text
      param, not only <code>word</code> — <code>.typeface("Times New Roman")</code>
      mints three separate steps; <code>.typeface('Times New Roman')</code>
      is one atom.</p>`,
  },
  {
    id: 'tc-style',
    name: 'typeface() / weight() / slant() / spacing() / underline() — text styling',
    sig: `.typeface("name")   —or—   .t("name")
.weight("400 200 100 800")
.slant("<italic none>")
.spacing("<3px 6px 9px 12px>")
.underline("underline")`,
    body: `<p>Chained styling controls, each patternable like any other Strudel
      param. <code>typeface</code>/<code>t</code> sets the font family,
      <code>weight</code> the font weight, <code>slant</code> italic/none,
      <code>spacing</code> letter-spacing, and <code>underline</code> toggles
      an underline. With nothing set, words inherit Jitsi's own chat
      typography — only properties you set are applied.</p>`,
  },
  {
    id: 'tc-borrowed',
    name: 'size() / color() — borrowed Strudel controls',
    sig: '.size("<12px 24px 10px 1px>*2")\n.color("<#346234 #bfe968>")',
    body: `<p><code>size</code> and <code>color</code> already exist in
      Strudel, so Text Cycles reuses them rather than re-registering —
      overriding <code>Pattern.prototype.size</code> would break
      <code>.size()</code> for every audio voice in the room.
      <code>size</code> arrives on the hap as the reverb <code>roomsize</code>
      control under the hood, and both are only rewritten to their text
      meaning inside a statement that also contains a <code>word()</code>
      call — an audio voice's <code>.size(4)</code> still means reverb
      size.</p>`,
  },
  {
    id: 'tc-link',
    name: 'hover() / hyperlink() — interactive styling',
    sig: '.hover("color:#ffffff")\n.hyperlink("<google.com reddit.com ca.gov>")',
    body: `<p><code>hover</code> takes CSS declarations applied while the
      word is moused over, scoped so one performer's hover rule can never
      restyle another's lines. <code>hyperlink</code> turns the word into a
      link: a bare domain gets <code>https://</code> added, only
      http/https/mailto schemes are permitted, and every link carries
      <code>rel="noopener noreferrer"</code> and opens in a new tab.</p>`,
  },
];

// ---------------------------------------------------------------------------
// Content — CSS Cycles (src/css-cycles.js, src/features/csscycles.md).
// Also a personal/bot-editor Strudel function, not a JPattern `#` directive.
// ---------------------------------------------------------------------------
const CSS_CYCLES_FUNCTIONS = [
  {
    id: 'css-init',
    name: 'await initCss() — declare a styling presence',
    sig: 'await initCss()',
    body: `<p>Declares a program's styling presence exactly as
      <code>await initTextCycles()</code> declares its words — first line of
      the preamble, then a blank line, then the patterns. Any of the
      capability declarations may share one preamble. Silent by
      construction: a css voice can never reach the speakers even if it also
      names a sound.</p>`,
  },
  {
    id: 'css-call',
    name: 'css(`…SCSS…`) — the two-part statement',
    sig: 'css(`.selector { …SCSS… }`)\n  .propertyName("<pattern>")   // any camelCase CSS property, chained',
    body: `
      <p>The backticked argument is <strong>SCSS</strong> — nesting,
      <code>&amp;</code>, <code>$variables</code>, <code>@media</code>,
      <code>@keyframes</code>, <code>@mixin</code>. Backticks rather than
      double quotes, because a double-quoted string is mini-parsed (
      <code>.example</code> would hit <code>.</code> as the subdivision
      operator) and <code>{}</code> never survives value sanitising.</p>
      <p>Any camelCase name chained on that then becomes a
      <strong>patterned declaration</strong> on the block's first top-level
      selector if it's a real CSS property (<code>borderRadius</code> →
      <code>border-radius</code>) — everything else in the chain
      (<code>.fast()</code>, <code>.slow()</code>, <code>.every()</code>…)
      is ordinary Strudel structure. <code>filter</code>, <code>mask</code>,
      <code>scale</code>, <code>rotate</code>, <code>translate</code>,
      <code>transition</code>, <code>order</code>, <code>offset</code>,
      <code>content</code>, <code>clip</code>, <code>direction</code> and
      <code>all</code> are both Strudel methods and CSS properties — inside
      a <code>css()</code> chain the CSS meaning wins.</p>
      <pre>css(\`.ts-chip { &:hover { border-color: #ffffff } }\`)
  .backgroundColor("<#101014 #16161c>")
  .fast(3)</pre>`,
  },
  {
    id: 'css-fence',
    name: 'The ^…^ fence — multi-part CSS values',
    sig: '.borderRadius("^2em / 1em 3em 0.5em^")\n.borderRadius("&lt;^2em 1em^ ^0.2em 4em^&gt;")',
    body: `<p>A double-quoted value is mini notation, so a bare space is a
      step separator — <code>.borderRadius("2em 1em")</code> is two
      one-cycle steps, not one two-part value. Carets fence one literal CSS
      value: inside them, spaces, commas and slashes are CSS rather than
      mini operators — the only way to write the slash form of
      <code>border-radius</code>, or a multi-shadow <code>box-shadow</code>.
      A function call needs no fence — <code>rgb(255, 0, 0)</code> is
      already read as one value.</p>`,
  },
  {
    id: 'css-reach',
    name: 'Reach — Trussal surfaces vs. the rest of the page',
    sig: '(governed by the selector, not a call of its own)',
    body: `<p>The <strong>full</strong> property set applies only where a
      rule matches inside a Trussal root (the Studio overlay, Text Cycles
      bubbles, the Hydra/keyboard/facial-gesture panels, the welcome
      overlays). Everywhere else on the page — Jitsi's own native UI — the
      same rule is re-emitted carrying only <strong>colour</strong>,
      <strong>border</strong> and <strong>font</strong> properties: a
      performer may repaint the room's chrome, but layout, position, size
      and visibility (<code>width</code>, <code>display</code>,
      <code>position</code>, <code>opacity</code>, <code>margin</code>…)
      stay Trussal-surface-only. Patterned declarations always carry
      <code>!important</code>, so they visibly track the pattern rather
      than losing to one of Trussal's own direct element rules.</p>`,
  },
  {
    id: 'css-guard',
    name: 'Guardrails',
    sig: '(enforced automatically — outbound in your browser, inbound in every peer\'s)',
    body: `
      <p>A statement is refused whole if any value its pattern can produce
      is illegal — including one that only surfaces on the third cycle of a
      four-step pattern:</p>
      <table>
        <tr><th>Refused</th></tr>
        <tr><td><code>display: none</code></td></tr>
        <tr><td><code>overflow</code>/<code>visibility</code>/<code>content-visibility</code> set to hidden</td></tr>
        <tr><td>any size property at <code>0</code> (except margin, padding, radii, border/outline widths)</td></tr>
        <tr><td><code>opacity: 0</code>, or an alpha of 0 on <code>color</code> (a transparent <em>background</em> is fine)</td></tr>
        <tr><td><code>z-index</code>, on any selector</td></tr>
        <tr><td>off-screen positions (<code>top</code>/<code>left</code>/<code>inset</code>/negative margins/<code>text-indent</code>/<code>translate()</code>)</td></tr>
        <tr><td><code>filter: opacity(0)/brightness(0)/contrast(0)</code>, or <code>blur()</code> over 8px</td></tr>
        <tr><td><code>clip-path</code> shapes that enclose nothing</td></tr>
        <tr><td><code>pointer-events: none</code></td></tr>
        <tr><td><code>url()</code> outside background/border-image, or on an unsafe scheme</td></tr>
        <tr><td><code>expression()</code>, <code>javascript:</code>, <code>@import</code>, <code>behavior</code>, <code>-moz-binding</code></td></tr>
      </table>
      <p>A value only knowable at runtime (a slider, a gesture) is instead
      <strong>clamped per hap</strong> — <code>opacity: 0</code> becomes
      <code>0.04</code>, <code>blur(80px)</code> becomes <code>blur(8px)</code>
      — rather than refused outright.</p>`,
  },
  {
    id: 'css-turn',
    name: 'Turn ownership',
    sig: '(governed by the JPattern ring — never fails open)',
    body: `<p>Two performers can both target the same selector, so only
      <strong>one</strong> peer's declared values for a given statement are
      ever live at a time — whoever currently holds the JPattern ring's
      slot. Everyone else's properties are pinned to the room's own captured
      baseline (what the page looked like before any CSS Cycles rule ever
      touched it), re-applied the instant the ring's token changes rather
      than waiting on that peer's own next hap. Unlike Text Cycles, CSS
      Cycles never opens every peer's styling to the shared cascade, even
      when no ring is actively scheduling turns.</p>`,
  },
];

// ---------------------------------------------------------------------------
// Content — liveCapture() (src/live-capture.js, src/features/live-capture.md).
// A Strudel source function, not a JPattern `#` directive.
// ---------------------------------------------------------------------------
const LIVE_CAPTURE_FUNCTIONS = [
  {
    id: 'lc-main',
    name: 'liveCapture(medium, name, detectLocalDevices)',
    sig: "liveCapture(medium, name = '', detectLocalDevices = false)",
    body: `
      <p>Records a rolling window of one medium from one source and returns
      a patternable handle — every pattern event replays / refires / retraces
      the freshest captured slice, the same "struct gates the live signal"
      model <code>live()</code> uses for audio, generalised to six mediums.</p>
      <table>
        <tr><th>arg</th><th>type</th><th>meaning</th></tr>
        <tr><td><code>medium</code></td><td>string</td><td>one of <code>audio</code>, <code>video</code>, <code>text</code>, <code>css</code>, <code>gesture</code>, <code>cursor</code></td></tr>
        <tr><td><code>name</code></td><td>string</td><td>a participant (display name or room-index token), or for <code>audio</code> a local input device name; ignored for <code>gesture</code>/<code>cursor</code></td></tr>
        <tr><td><code>detectLocalDevices</code></td><td>boolean</td><td>dump YOUR camera/audio devices to the console</td></tr>
      </table>
      <p>Every string argument is rewritten to a single-quoted literal before
      evaluation regardless of how you write it — a real device name like
      <code>"Scarlett 2i2 (Focusrite)"</code> would otherwise break Strudel's
      mini-notation parser and kill the whole room's combined program.</p>
      <pre>$: liveCapture('audio', 'Ada').struct("x*4").lpf(800).room(1)
$: liveCapture('video', 'Ada').struct("x*8")
$: liveCapture('gesture').struct("x*2")</pre>`,
  },
  {
    id: 'lc-media',
    name: 'The six mediums',
    sig: 'audio | video | text | css | gesture | cursor',
    body: `
      <table>
        <tr><th>medium</th><th>source</th><th>each event…</th></tr>
        <tr><td><code>audio</code></td><td>the named peer's aggregator audio, or a local input device</td><td>plays the freshest ~10s of ring audio through the normal effects chain</td></tr>
        <tr><td><code>video</code></td><td>the named peer's published video</td><td>steps a playback head over a rolling frame ring, blitted to a canvas for Hydra's <code>src()</code></td></tr>
        <tr><td><code>text</code></td><td>the named peer's editor-change stream</td><td>paints the freshest added code fragment into an overlay (silent)</td></tr>
        <tr><td><code>css</code></td><td>the named peer's compiled CSS Cycles sheet</td><td>re-applies it to your page via a dedicated stylesheet (silent)</td></tr>
        <tr><td><code>gesture</code></td><td>YOUR OWN fired facial gestures</td><td>refires the next gesture in the recorded sequence (silent)</td></tr>
        <tr><td><code>cursor</code></td><td>YOUR OWN head-cursor path</td><td>steps your head cursor along the recorded path (silent)</td></tr>
      </table>`,
  },
  {
    id: 'lc-replay',
    name: 'Breaking a replay / multi-peer semantics',
    sig: '(behavior of a running capture — no call of its own)',
    body: `<p>Pressing <strong>Right Arrow</strong>, or holding your
      <strong>right eye shut for two seconds</strong>, breaks every running
      <code>gesture</code>/<code>cursor</code> replay; it stays broken until
      the program is re-evaluated. Only the <strong>authoring</strong>
      browser's <code>liveCapture()</code> calls actually run — every other
      peer's copy of your program is silently rewritten to a no-op, so your
      capture never opens your microphone or replays your gestures on
      everyone else's machine.</p>`,
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

// Renders one function-reference section: a jump-link row over the fn cards.
// `fn.id` is required and must be unique across every section on the page,
// since data-jump targets a page-wide element id.
function _renderFnSection(fns) {
  const toc = fns
    .map((fn) => `<a data-jump="${fn.id}">${fn.name.split(' — ')[0]}</a>`)
    .join('');
  const cards = fns
    .map((fn) => `
      <div class="da-fn" id="trussal-da-fn-${fn.id}">
        <div class="da-fn-name">${fn.name}</div>
        <code class="da-fn-sig">${_escapeHtml(fn.sig)}</code>
        ${fn.body}
      </div>`)
    .join('');
  return `<div class="da-toc">${toc}</div>${cards}`;
}

function _buildDocsBody() {
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

    <h3 id="trussal-da-jpattern">JPattern function reference</h3>
    <p>Every directive below is written on its own line in the shared
    JPattern card, chained onto the <code>$ participants</code> voice. This
    is the language <code>src/audio-net/MetaprogrammerParser.js</code>
    parses — kept in sync with <code>src/features/jpattern.md</code> and
    <code>src/features/turn-ring.md</code> in the repository.</p>
    <div class="da-fn">
      <div class="da-fn-name">The <code>#</code> prefix</div>
      <p><code>#</code> is <strong>mondo</strong> notation's chaining
      operator — how a line attaches to the voice <code>$ participants</code>
      opened above it, the same job a mini-notation <code>.method(…)</code>
      call does. It is not part of any directive's own name: <code>#
      cycles "wcl" 10</code> (mondo) and <code>.cycles("wcl", 10)</code>
      (mini, chained onto <code>$: participants(…)</code>) are the same
      statement written in the two surface notations. Every directive
      below — <code>ring</code>, <code>cycles</code>, <code>room</code>,
      <code>ply</code>, … — takes this same <code>#</code> in mondo; the
      signatures on this page name the directive itself and omit it, the
      way this page also doesn't repeat <code>$:</code> on every mini
      example.</p>
      <pre>'metaprogram editor'
$ participants &lt;0 1&gt;
# cycles "wcl" 10
# room "wcl" 2</pre>
    </div>
    ${_renderFnSection(JPATTERN_FUNCTIONS)}

    <h3 id="trussal-da-textcycles">Text Cycles</h3>
    <p>Not a JPattern <code>#</code> directive — a Strudel function available
    in the <strong>personal</strong> or <strong>bot</strong> editor once a
    buffer opens with <code>await initTextCycles()</code>. Paints words into
    the room's chat instead of, or alongside, making sound. See
    <code>src/features/textcycles.md</code> for the full write-up (escaping,
    seeding, per-participant scoping, how the JPattern room effects reach
    text).</p>
    ${_renderFnSection(TEXT_CYCLES_FUNCTIONS)}

    <h3 id="trussal-da-csscycles">CSS Cycles</h3>
    <p>Also a personal/bot-editor Strudel function, declared with
    <code>await initCss()</code> — patterns that restyle the live page
    instead of making sound. See <code>src/features/csscycles.md</code> for
    the full write-up (the compile/broadcast pipeline, the trust model, and
    every guardrail in detail).</p>
    ${_renderFnSection(CSS_CYCLES_FUNCTIONS)}

    <h3 id="trussal-da-livecapture">Live Capture — liveCapture()</h3>
    <p>A Strudel source function usable directly in the personal/bot editor
    (no preamble declaration needed) that captures and replays a room
    medium — audio, video, editor text, CSS, your own gestures, or your own
    head-cursor path — as a patternable handle. See
    <code>src/features/live-capture.md</code> for the full write-up.</p>
    ${_renderFnSection(LIVE_CAPTURE_FUNCTIONS)}
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

// Bottom-right corner, fixed by plain CSS (see docs-about.css) — no JS
// positioning needed. This used to track the live position of Jitsi's
// welcome-page settings gear (top-right) to sit just left of it, but that
// gear is centered inside a fixed-width content column rather than pinned to
// the viewport edge, and the tracking logic left a stale `right` from the
// stylesheet's base rule alongside the JS-set `left` on some layouts — with
// both offsets present on a `position: fixed` box with no explicit width,
// the browser stretches it to fill the whole gap between them, and the
// resulting full-width strip sat on top of (and ate clicks meant for) the
// gear itself. Bottom-right has nothing else to collide with.
function _onWelcomePage() {
  return !!(document.body && document.body.classList.contains('welcome-page'));
}

function _boot() {
  let tries = 0;
  const maxTries = 40; // ~10s at 250ms, same budget welcome-page.js's own poll uses
  const timer = setInterval(() => {
    tries += 1;
    if (_onWelcomePage()) _ensureDOM();
    if (document.getElementById(CORNER_ID) || tries >= maxTries) clearInterval(timer);
  }, 250);
}

function init() {
  if (window.__trussalIsBot || window.__trussalIsAggregator) return;
  if (document.readyState === 'complete' || document.readyState === 'interactive') _boot();
  else window.addEventListener('DOMContentLoaded', _boot);
}

init();

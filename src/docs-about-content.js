// docs-about-content.js — the single source of truth for the Documentation and
// About content. Pure data + string builders: no DOM, no CSS import, so this
// module serves both the static page generator (build-pages.mjs, run by
// build.mjs) and any script / test that wants the rendered HTML.
//
// The markup produced here is styled by docs-about.css (the same rules that
// styled the old on-page panels), and lands inside the .trussal-da-panel /
// .da-body wrapper that build-pages.mjs places on each page.
// ---------------------------------------------------------------------------
// Content — the JPattern function reference.
// ---------------------------------------------------------------------------

//TODO: remove when done
const JPATTERN_FUNCTIONS = [
  {
    id: 'jp-participants',
    name: '$ participants',
    sig: 'participants([participant_tokens])\nparticipants [participant_tokens]',
    body: `
      <p>Orders participants' turns when ring is set to false.</p>
      <p>Turn-modifying operators are written glued to the token, no spaces:</p>
      <code>
        $: participants("<0 9>")
      </code>
      <code>
        $ participants <0 9>
      </code>
      `,
  },
  {
    id: 'jp-ring',
    name: 'ring',
    sig: 'ring([boolean])\nring boolean',
    body: `
      <p>Sets the Metaprogram into consistent hashing mode.</p>
      <code>
        $: participants(3)
        .ring(true)
      </code>
      <code>
        $ participants 3
        # ring true
      </code>
      `,
  },
  {
    id: 'jp-cycles',
    name: 'cycles',
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
      <pre># cycles "wcl" 10 0.3   <span class="da-comment">// WCL pinned at 300ms, scaled ×10 → every cycle is 3s</span></pre>`,
  },
  {
    id: 'jp-tempo',
    name: 'tempo ',
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
    name: 'room',
    sig: 'room [network_metric="wcl"] [scale_pattern] [fixed_amount_pattern] [pattern_medium_set]',
    body: `
      <p>Reverb whose decay time, whitespace amount, or visual blur varies with the supplied network metric value respectively
       regarding the Aggregator's audio, video, or text output. Example(s):</p> 
      <pre># room "wcl" 2 0.4        <span class="da-comment">// fixed 800ms decay</span>
# room "wcl" "2 3 4" ["audio" "video"] //audio and video reverb</pre>`,
  },
  {
    id: 'jp-crush',
    name: 'crush',
    sig: 'crush [network_metric="wcl"] [scale_pattern] [fixed_amount] [pattern_medium_set]',
    body: `
      <p>Varies the bit-depth and resolution of the Aggregator's audio and visual output according to the value of the currently
      supplied network metric. Example(s):</p>
      <pre># crush "wcpl" 1 0.25    <span class="da-comment">// pinned at 25% loss: a steady 4 bits</span></pre>`,
  },
  {
    id: 'jp-echo',
    name: 'echo',
    sig: 'echo [network_metric="wcl"] [length_in_cycles] [network_metric="wcl"] [feedback_percentage] [network_metric="wcl"] [output_mix_volume] [pattern_medium_set]',
    body: `
      <p>Applies a network-modulated echo effect to the Aggregator's audio and video output. Example(s):</p>
      <pre># echo "wcl" 2 "wcpl" 0.3 "wcrtt" 3 1500 20 1200</pre>`,
  },
  {
    id: 'jp-noise',
    name: 'noise',
    sig: 'noise [network_metric="wcl"] [lowpass_cutoff_scale_factor] [network_metric="wcl"] [output_mix_volume] [pattern_medium_set]',
    body: `
      <p>Adds pink, brown, or white noise to the Aggregator's audio and video output convolved with a lowpass filter, and inserts pseudorandomly-chosen characters
      into the text output. Example(s):</p>
      <pre># noise "wcl" 20 "wcrtt" 10</pre>`,
  },

  {
    id: 'jp-shape-3d',
    name: '3D shapes (three.js) — tetrahedron · box · sphere · icosahedron · octahedron · dodecahedron · torus · torusknot · cylinder · cone',
    sig: '# <shape> [geometry_params] [scene_params] [animation_params] [pattern_medium_set]',
    body: `
      <p>Re-renders the Aggregator's composed frame with three.js so the frame
      BECOMES the texture on a 3D shape — ground and form, with the existing
      effects chain (<code># crush</code>, <code># room</code>, …) still run
      over the rendered picture afterwards. Exactly one shape directive is
      live at a time (re-typing replaces it), while <code># skybox</code>,
      <code># particle2</code>/<code># particle3</code>,
      <code># tiling</code>, <code># tessellation</code> and
      <code># background</code> stack with it as independent layers. All
      groups are optional; every element may be a rest (<code>~</code>) or a
      <code>&lt;…&gt;</code> pattern sampled per cycle. Example(s):</p>
      <pre># tetrahedron [1.5] [2 ~ 2 2] [0.5 ~ 0.1]
# torusknot [1 0.4 64 8 2 3] [1.5] [~ 0.25]
# sphere [1] [1.2 4]                <span class="da-comment">// pushed back to distance 4</span></pre>
      <p>Group 1 is geometry, shape-specific, defaulting to three.js's own
      values when rested: <code>tetrahedron</code>/<code>icosahedron</code>/
      <code>octahedron</code>/<code>dodecahedron</code> radius, detail —
      <code>box</code> width, height, depth — <code>sphere</code> radius,
      widthSegments, heightSegments — <code>torus</code> radius, tube,
      radialSegments, tubularSegments — <code>torusknot</code> radius, tube,
      tubularSegments, radialSegments, p, q — <code>cylinder</code>
      radiusTop, radiusBottom, height, radialSegments — <code>cone</code>
      radius, height, radialSegments.</p>
      <p>Group 2 is the scene: <code>[scale distance repeatU repeatV]</code>
      — the mesh's size multiplier, the camera's distance (auto-fit when
      rested), and how often the frame tiles across the surface in each
      direction. Group 3 is the animation: <code>[spinX spinY spinZ]</code>
      in turns PER CYCLE, read off the same cycle grid the audio follows, so
      the spin is musical. A written group rests an axis to zero; an
      unwritten one defaults to a lazy <code>[0 0.5 0]</code> turn.</p>`,
  },
  {
    id: 'jp-shape-2d',
    name: '2D shapes (p5.js) — square · circle · triangle · star · polygon',
    sig: '# <shape> [geometry_params] [scene_params] [animation_params] [pattern_medium_set]',
    body: `
      <p>The flat counterpart, drawn with p5.js: the composed frame fills a
      shape centered on the output, everything around it showing the
      <code># background</code> layer. Composes exactly like the 3D shapes
      above — one shape at a time, every layer stacking with it. Example(s):</p>
      <pre># square [80] [1 ~ 3]           <span class="da-comment">// 80px block, frame repeated ×3 inside</span>
# star [260 7 0.45] [~ 2 2] [0.5]</pre>
      <p>Geometry slots: <code>square</code> size — <code>circle</code>
      radius — <code>triangle</code> radius — <code>star</code> outerRadius,
      points, innerRatio — <code>polygon</code> sides, radius. A rested slot
      takes a frame-relative default (a bare <code># square</code> is a
      poster block covering most of the height). Scene is
      <code>[scale repeatU repeatV]</code>, animation <code>[spin]</code> in
      turns per cycle (default 0.25, rests to zero).</p>`,
  },
  {
    id: 'jp-skybox',
    name: 'skybox',
    sig: 'skybox [boolean]',
    body: `
      <p>Wraps the camera in the frame itself — an immersive video sphere
      around the whole view (three.js) — off by default. Composes with a
      shape: the shape renders in front of the environment. A bare
      <code># skybox</code> turns it on. Example(s):</p>
      <pre># skybox true
# skybox false</pre>`,
  },
  {
    id: 'jp-particle2',
    name: 'particle2',
    sig: 'particle2 [count size speed]',
    body: `
      <p>The frame set loose as a 2D particle system (p5.js): every particle
      keeps a home cell on a jittered grid, drifts around it once per cycle
      (speed counts cycles), and paints itself from the video at its live
      position. With a 2D shape active the swarm is clipped to it, the
      particles filling the form the way the texture does. Defaults
      1200 particles, size 3, speed 1 — count caps at 8000 (software GL
      feeds every frame of the mosaic). Example(s):</p>
      <pre># particle2 [4000 4 2]</pre>`,
  },
  {
    id: 'jp-particle3',
    name: 'particle3',
    sig: 'particle3 [count size speed]',
    body: `
      <p>The same system in three.js: particles colored by the frame through
      their own mapping — on the SURFACE of an active 3D shape (its vertices
      and UVs, so the cloud hugs the form and spins with it), or a sphere
      shell otherwise. Independent of <code># particle2</code>: both may run
      at once, one per dimension. Defaults 1500 particles, size 2.5,
      speed 1. Example(s):</p>
      <pre># particle3 [4000 3 0.5]</pre>`,
  },
  {
    id: 'jp-tessellation',
    name: 'tessellation',
    sig: 'tessellation [cols rows spin]',
    body: `
      <p>Tiles the frame across the output as a mirrored quilt (p5.js): every
      cell cover-fits the video, alternate rows and columns flipped so the
      seams interlock edge to edge, the whole lattice turning at the spin
      rate (turns per cycle) while the background shows through the corners
      it uncovers. Defaults 4 columns, 3 rows, spin 0.35. Example(s):</p>
      <pre># tessellation [6 4 0.5]</pre>`,
  },
  {
    id: 'jp-tiling',
    name: 'tiling',
    sig: 'tiling <none|grid|hex|strip> [count]',
    body: `
      <p>Instances the active SHAPE across the output instead of drawing one
      — <code>grid</code>, <code>hex</code> (staggered rows), or a single
      <code>strip</code>; <code>none</code> clears back to one instance.
      Count defaults to 3 and caps at 12, and the camera pulls back to frame
      the lattice so nine copies stay legible. Needs a shape directive —
      without one there is nothing to tile. Example(s):</p>
      <pre># tiling hex [7]
# tiling none</pre>`,
  },
  {
    id: 'jp-background',
    name: 'background',
    sig: 'background ["color"] | "image" [url] | "gradient" [from] [to] [angle_degrees]',
    body: `
      <p>What surrounds the shape: a plain CSS color, a two-color gradient at
      an angle in degrees (0 points right, default 90 straight down), or an
      image URL drawn cover-fit. Painted before any shape layer, so it shows
      around the shape and through whatever a rotating tessellation uncovers.
      Colors and the angle are patternable per cycle; a bare
      <code># background</code> clears it. Images load cross-origin — a host
      that refuses simply leaves the base rather than poisoning the
      published canvas. Example(s):</p>
      <pre># background "#120a2a"
# background "gradient" "#ff00aa" "#002244" 45
# background "gradient" <"#f00" "#0f0"> "#000" <45 90>
# background "image" "https://example.com/backdrop.jpg"</pre>`,
  },

];

const TEXT_CYCLES_FUNCTIONS = [
  {
    id: 'tc-word',
    name: 'word()\n w',
    sig: '.word([pattern])\n.w([pattern])\n# word [pattern]\n#w [pattern]',
    body: `
      <p>Sends the specified words to the meeting-wide chat window. A few characters need escaping to render literally:</p>
      <table>
        <tr><th>Written</th><th>Renders</th></tr>
        <tr><td><code>word("&lt;a ~ b&gt;")</code></td><td><code>a</code>, a rest, <code>b</code></td></tr>
        <tr><td><code>word("&lt;a \\~ b&gt;")</code></td><td><code>a</code>, a literal <code>~</code>, <code>b</code></td></tr>
        <tr><td><code>word("squirrels?")</code></td><td><code>squirrels</code>, played only sometimes</td></tr>
        <tr><td><code>word("squirrels\\?")</code></td><td><code>squirrels?</code> every cycle</td></tr>
      </table>
`,
  },
  {
    id: 'tc-typeface',
    name:'typeface/t',
    sig: `typeface([typeface_pattern="Arial"])\n t([typeface_pattern="Arial"])`,
    body: `<p>Selects a typeface for the specified text pattern.</p>
    <span>Example(s):</span>
    <code>$: typeface("Monaco").word("dachshund")</code>
    <code>$ typeface("Monaco") # word "dachshund")</code>
    <code>$: t("Monaco"text-cycles).w("dachshund")</code>
    <code>$ t "Monaco" w "dachshund" </code>
    <table>
      <tr><th>Supported Typefaces</th></tr>
      <tr>Times New Roman<tr>
      <tr>Verdana</tr>
      <tr>Trebuchet MS</tr>
      <tr>Menlo</tr>
      <tr>Verdana</tr>
      <tr>Georgia</tr>
      <tr>Arial</tr>
      <tr>Helvetica</tr>
      <tr>Courier New</tr>
      <tr>Tahoma</tr>
    </table>
    `
  },
  {
    id: 'tc-weight',
    name:'weight',
    sig: `weight([font_weight_pattern])\n w([font_weight_pattern])`,
    body: `<p>Sets the font weight for the specified text pattern./p>
    <span>Example(s):</span>
    <code>$: typeface("Times New Roman")
    .word("ruppig")
    .weight(400)
    </code>
    <code>$ typeface "Times New Roman"
    # word "ruppig"
    # weight 400
    </code>
    `
  },
  {
    id: 'tc-spacing',
    name:'spacing',
    sig: `.spacing([character_spacing_pattern])\n# spacing [character_spacing_pattern]`,
    body: `<p>Sets the spacing amount between characters for the specified text pattern in pixels./p>
    <span>Example(s):</span>
    <code>$: typeface("Verdana")
    .word("Zecke")
    .spacing("<3 30 300>")
    </code>
    <code>$ typeface "Verdana" 
    # word "Zecke"
    # spacing <3 30 300>
    </code>
    `
  },
  {
    id: 'tc-underline',
    name:'underline',
    sig: `.underline()\n # underline`,
    body: `<p>Underlines the selected text pattern./p>
    <span>Example(s):</span>
    <code>$: typeface("Tahoma")
    .word("Pudding mit Gabel")
    .underline()
    </code>
    <code>$ typeface "Tahoma" 
    # word "Pudding mit Gabel"
    # underline
    </code>
    `
  },
  {
    id: 'tc-slant',
    name:'slant',
    sig: `.slant()\n # slant`,
    body: `<p>Italicizes the selected text pattern./p>
    <span>Example(s):</span>
    <code>$: typeface("Trebuchet MS")
    .word("Row row row your boat gently down the stream")
    .slant()
    </code>
    <code>$ typeface "Trebuchet MS" 
    # word "Row row row your boat gently down the stream"
    # slant
    </code>
    `
  },
  {
    id: 'tc-size',
    name: 'size',
    sig: '.size([font_size_pattern])\n# size [font_size_pattern]',
    body: `<p>Sets the font size for the selected text pattern using any CSS unit 
    or relative to the parent element. Overloads size in Strudel for text patterns.</p>
    <code>$: typeface("Georgia")
    .word("Colorless green ideas sleep furiously")
    .size("<3em 4px 10pc 0.3ch>*2")
    </code>
    <code>$ typeface("Georgia")
    # word("Colorless green ideas sleep furiously")
    # size <3em 4px 10pc 0.3ch>*2
    </code>     
    `,
  },
  {
    id: 'tc-color',
    name: 'color',
    sig: '.color([color_pattern])\n# color [color_pattern]',
    body: `<p>Sets the CSS color value for the selected text. Overloads color in Strudel.</p>
    <code>$: typeface("Trebuchet MS")
    .word("nooooooooo")
    .color("#abcdef")
    </code>
    <code>$ typeface("Tremuchet MS")
    # word("nooooooooo")
    # color "#abcdef"
    </code>     
    `,
  },
  {
    id: 'tc-hyperlink',
    name: 'hyperlink',
    sig: 'hyperlink([hyperlink_pattern])\n hyperlink [hyperlink_pattern]',
    body: `<p> Creates a pattern of hyperlinks into a
      link. "https://" is appended to the beginning. 
      Every hyperlink opens in a new tab.</p>
      <code>
      $: typeface("Times New Roman")
      .hyperlink("<google.com reddit.com ca.gov>")
      </code>
      <code>
      $ typeface
      # hyperlink "<google.com reddit.com ca.gov>"
      </code>
      `,
  },
  {
    id: 'tc-hover',
    name: 'hover',
    sig: 'hover([css_attribute:value]) \n hover [css_attribute:value]',
    body: `<p>Takes CSS declarations applied while the
      word is moused over, scoped to the calling performer's hover rule.
      <code>
       $: typeface("Times New Roman")
      .hyperlink("<google.com reddit.com ca.gov>")
      .hover("color:#ffffff font-size:12px")
      </code>
      <code>
      $ typeface("Times New Roman")
      # hyperlink("<google.com reddit.com ca.gov>")
      # hover("color:#ffffff font-size:12px")
      </code>
      </p>`,
  },
];

// ---------------------------------------------------------------------------
// Content — CSS Cycles (src/css-cycles.js, src/features/csscycles.md).
// Also a personal/bot-editor Strudel function, not a JPattern `#` directive.
// ---------------------------------------------------------------------------
const CSS_CYCLES_FUNCTIONS = [
  {
    id: 'css-call',
    name: 'css',
    sig: 'css(`[selector] [scss_code]`)\n',
    body: `
      <p>Creates a CSS pattern with a selector and SCSS code.</p>
      <span>Example:</span>
      <code>
          css(\`.ts-chip { &:hover { border-color: #ffffff } }\`)
      </code>`,
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
];

const CONFIG_FUNCTIONS = [
    {
    id: 'bc-main',
    name: 'botConfig',
    sig: "botConfig([config_object])",
    body: `
      <p>Applies constraints for generated bot code upon spawn.</p>
      <span>Example:</span>
      <code>botConfig({"random":true, "quantity":3, "retroactive":true})
      </code>
      `,
  },
  {
    id: 'gc-main',
    name: 'gestureAndLandmarkConfig',
    sig: "gestureAndLandmarkConfig([config_object])",
    body: `
      <p>Applies settings for gesture recognition and virtual keyboard use.</p>
      <span>Example:</span>
      <code>botConfig({"random":true, "quantity":3, "retroactive":true})
      </code>
      
      `,
  },
  {
    id: 'jp-grid',
    name: 'grid',
    sig: 'grid [boolean]=false',
    body: `
      <p>Marks each participant's video panel with a small grayscale circle in the top-left corner.
      One's own panel's circle is always white, and the darkness of the circle is determined
      according to estimated physical distance between participants.
      With landmarks on, a participant running MediaPipe also gets a
      vector in the bottom-right showing their average facial-landmark
      motion.</p>
      $: participants("<1 0 3z>")
      .cycles("wcpl", 100)
      .grid(true)
      .fast(1.2)
      </code>
      <code>
      $  participants <1 0 3z>
      # cycles "wcpl" 100
      # grid true
      # fast 1.2
      </code>  
      `,
  },
  {
    id: 'jp-mosaic',
    name: 'mosaic',
    sig: 'mosaic [boolean]=true',
    body: `
      <p>How the Aggregator's video feed is displayed. When set to true, when it is each participant's turn,
      individual video squares are displayed as a part of a grid that is arranged as a square with 
      a number of video tiles equal to the ceiling of the square root of the amount of participants. 
      When it is set to false,
      </p>
      <code>
      $: participants("0 1")
      .cycles("wcl", 35)
      .mosaic(true)
      .slow(3)
      </code>
      <code>
      $  participants "0 1"
      # cycles "wcl" 35
      # mosaic true
      # slow 3
      </code>     
      `,
  }

];

const UI_PATTERN_FUNCTIONS = [
    {
    id: 'meeting-reactions',
    name: 'reaction',
    sig: "reaction([meeting_reaction_pattern])",
    body: `
      <p>Broadcasts patterns of Jitsi Meet's built in reactions to the public chat window.</p>
      <span>Example:</span>
      <code>$: reaction("si tu@3 s!4")
      .slow(2)
      </code>
      <code>
      $ reaction "si tu@3 s!4" 
      # slow 2
      </code>
      `,
  },
  {
    id: 'breakout-patterns',
    name: 'breakout',
    sig: "breakout([breakout_room_assignment_pattern])",
    body: `
      <p>Creates a pattern of breakout room names and assignments. Does not recreate a preexisting breakout room.</p>
      <span>Example:</span>
      <code>$: breakout({"name":"room", "participants": ["0", "1", "2b"]})
      </code>
      <code>$ breakout {"name":"room", "participants": ["0", "1", "2b"]}
      </code>
      `,
  },
  {
    id: 'assign',
    name: 'assign',
    sig: "assign([participant_name_pattern)",
    body: `
      <p>Assigns participants to breakout rooms. Does not reassign participants to a room to which they have already been assigned/</p>
      <span>Example:</span>
      <code>$: assign({"name":"room", "participants": ["0", "1", "2b"]})
      </code>
      <code>$  assign {"name":"room", "participants": ["0", "1", "2b"]}
      </code>
      `,
  },
]
// ---------------------------------------------------------------------------
// Content — liveCapture() (src/live-capture.js, src/features/live-capture.md).
// A Strudel source function, not a JPattern `#` directive.
// ---------------------------------------------------------------------------
const LIVE_CAPTURE_FUNCTIONS = [
  {
    id: 'lc-main',
    name: 'liveCapture',
    sig: "liveCapture([pattern_medium], [device_name_pattern]='', [detect_local_devices]=false)/n liveCapture [medium] [device_name] [detect_local_devices]",
    body: `
      <p>Records and stores the most recently played turn of one medium from one source.</p>
      <span>Example:</span>
      <code>liveCapture('audio', 'Scarlett 2i2 (Focusrite)', true)
      .chop(8)
      </code>
      <code>liveCapture 'audio' 'Scarlett 2i2 (Focusrite)' true
      # chop(8)
      </code>     
      `,
  },
];

const STRUDEL_OVERLOAD = [
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
];

const FETCH_PATTERNS = [
  {
    id:'image',
    name:'image',
    sig: 'image([image_file_name_pattern])\nimage image_file_name_pattern',
    body:`<p>Sends image files up to 10MB in the public meeting chat window.
    .jpeg, .jpg, .png, .gif, .bmp, and .svg files are supported.</p>
    <code>$: image("<example.com/cat.png someplace.xyz/doggo.svg>")</code>
    <code>$ image <example.com/cat.png someplace.xyz/doggo.svg> </code>
    `
  },
  {
    id:'video',
    name:'video',
    sig: 'video([video_file_name_pattern])\nvideo video_file_name_pattern',
    body:`<p>Sends video files up to 10MB in the public meeting chat window.
    .mp4, mov, and m4a files are supported.</p>
    <code>$: video("example.com/pupper.mov")</code>
    <code>$ video "example.com/pupper.mov" </code>
    `
  },
  {
    id:'soundFile',
    name:'soundFile',
    sig: 'soundFile([sound_file_name_pattern])\nsoundFile sound_file_name_pattern',
    body:`<p>Sends audio files up to 10MB in the public meeting chat window.
    .wav, mp3, and .ogg files are supported.</p>
    <code>$: soundFile("example.com/ratchet.wav")</code>
    <code>$ soundFile "example.com/ratchet.wav" </code>
    `
  },
  {
    id:'pdfFile',
    name:'pdfFile',
    sig: 'pdfFile([pdf_file_name_pattern])\npdfFile pdf_file_name_pattern',
    body: `<p>Sends PDF files up to 10MB in the public meeting chat window</p>
    <code>$: textFile("<example.com/shopping.pdf someplace.xyz/digeridoo.pdf>")</code>
    <code>$ textFile <example.com/shopping.pdf someplace.xyz/digeridoo.pdf> </code>
    `
  },
  {
    id:'textFile',
    name:'textFile',
    sig: 'textFile([text_file_name_pattern])\ntextFile text_file_name_pattern',
    body: `<p>Sends text files up to 10MB in the public meeting chat window</p>
    <code>$: textFile("<example.com/satie.txt someplace.xyz/transistor.txt>")</code>
    <code>$ textFile <example.com/satie.txt someplace.xyz/transistor.txt> </code>
    `
  },

]
// ---------------------------------------------------------------------------
// Content — About.
// ---------------------------------------------------------------------------
export const DOCS_TITLE = 'JPattern Docs';
export const ABOUT_TITLE = 'About Trussal';

export const ABOUT_HTML = `
  <p>
  The name "Trussal" is a combination of parts of the words "truss" and "algorave", and brings together 
  the two concepts with software that provides a stage for online, real-time algorithmically-driven 
  musical co-creation and multimedia artistic interaction, providing an alternative to strictly in-person venues. 
  JPattern, Trussal Studio, <a href="https://jitsi.org/about/">Jitsi Meet</a>, 
  <a href="https://pptr.dev/guides/what-is-puppeteer">Puppeteer</a>, <a href="https://developer.mozilla.org/en-US/docs/Web/API/Web_Audio_API">Web Audio API </a>, 
  and <a>MediaPipe</a> form the backbone for a hands-optional distributed live coding environment 
  inside of a video conferencing system. JPattern is a superset of the Strudel and Hydra pattern languages, 
  born out of Trussal's prototyping journey, and additionally enables one to live code with text, 
  gestures, meeting reactions, participant polls, CSS, global meeting settings, and multimedia live 
  capture patterns, while able to modulate numerous parameters using different network metrics. 
  Trussal Studio houses the JPattern editors in addition to the status of the network, also serving as the interface for 
  calling upon bots to accompany oneself based on direct mutations of one's original pattern(s). 
  Trussal began with Quargs Greene in 2025 during master's work initially funded by Boston University.
  See the <a href="https://github.com/quargsgreene/Trussal">Trussal GitHub repository</a> for more information on contributing and to file an issue or feature request.
  <figure>
  <!-- Served from the repo's src/ tree (mounted at /usr/share/jitsi-meet/css/src
       and exposed by nginx's /css/src/ location). Jitsi's meet.conf static
       allowlist has no /docs-images/ entry, so an image under that path falls
       through to the room catch-all and is returned as text/html, which nosniff
       rejects -> only this alt text would show. -->
  <img
    src="https://trussal-docs.quargsgreene.workers.dev/about-trussal-in-action.png"
    alt="A person at a computer running a Trussal meeting Photo credit: Jennifer Deafenbaugh" />
  <figcaption>A person at a computer running a Trussal meeting Photo credit: Jennifer Deafenbaugh</figcaption>
</figure>
</p>
`;

// fn.sig is plain text containing literal `<token>`-style placeholders —
// escape it before interpolating into innerHTML, or the angle brackets are
// parsed as markup instead of shown. fn.name and fn.body are authored HTML
// (body deliberately so, for its <code>/<pre>/<table> markup).
function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Renders one function-reference section: a jump-link row over the fn cards.
// `fn.id` is required and must be unique across every section on the page,
// since the jump links use page-wide element ids (plain #anchor hrefs, so the
// table of contents works with or without JS).
function renderFnSection(fns) {
  const toc = fns
    .map((fn) => `<a href="#trussal-da-fn-${fn.id}">${fn.name.split(' — ')[0]}</a>`)
    .join('');
  const cards = fns
    .map((fn) => `
      <div class="da-fn" id="trussal-da-fn-${fn.id}">
        <div class="da-fn-name">${fn.name}</div>
        <code class="da-fn-sig">${escapeHtml(fn.sig)}</code>
        ${fn.body}
      </div>`)
    .join('');
  return `<div class="da-toc">${toc}</div>${cards}`;
}

export function buildDocsBody() {
  return `
    <h3>Creating or Joining a Meeting</h3>
        <h4> Starting a new meeting </h4>
        <p>To create a new meeting room, focus the "Room name:" field.</p>
        Then enter a meeting room name 1023 characters or less using letters, numbers, "-", or "_". 
        <figure>
          <img
            src="https://trussal-docs.quargsgreene.workers.dev/trussal_meeting_name_example.png"
            alt="The Trussal welcome page, showing the Room name field and the Join session button, with the meeting name 'someplace'" />
          <figcaption>The Trussal welcome page, showing the Room name field and the Join session button, with the meeting name 'someplace'</figcaption>
        </figure>
        Each meeting room name must start with a letter or number. If the user enters an invalid meeting room name, 
        the message "Use letters, numbers, -, or _, starting with a letter or number" will appear beneath the "Join session" button. 
        <figure>
          <img
            src="https://trussal-docs.quargsgreene.workers.dev/invalid_meeting_name.png"
            alt="The Trussal welcome page, showing the Room name field and the Join session button, with the invalid meeting name '@'" />
          <figcaption>The Trussal welcome page, showing the Room name field and the Join session button, with the invalid meeting name '@'</figcaption>
        </figure>
        Once a valid meeting name has been entered, click the 
        "Join meeting" button, which then brings the user to the prejoin screen, where one may optionally 
        enter a display name containing any characters. To enter the meeting room, click the "Join meeting" button.
        <figure>
          <img
            src="https://trussal-docs.quargsgreene.workers.dev/prejoin.png"
            alt="The prejoin screen with the display name 'someone' entered"/>
          <figcaption>The prejoin screen with the display name 'someone' entered</figcaption>
        </figure> 

        <h4> Joining a Preexisting Meeting Room </h4>
        <p>A list of previously joined meetings will appear below the "Join meeting" button in reverse chronological order. 
        To rejoin a meeting room, click on one of the meetings in the list. 
        <figure>
          <img
            src="https://trussal-docs.quargsgreene.workers.dev/meeting_list.png"
            alt="A list of meeting names on the landing page with trashcan icons to the right" />
          <figcaption>A list of meeting names on the landing page</figcaption>
        </figure>
        One will again reach the prejoin screen, where the most recently entered screen name will prepopulate.
        However, one may change one's display name again at this time and an unlimited number of times throughout the meeting.
        Clearing browser data will clear the list of previously joined meetings, as well as one's previously-chosen display name.
        Clicking on the trash can icon can remove individual meetings from the list of existing meetings.
        <br />
        Note that clicking on the trash can icon or clearing browsing data <strong>does not</strong> end an existing meeting.
        Meetings may only be ended by a participant clicking on the telephone icon attached to the meeting room toolbar inside of the meeting,
        or when no human meeting participant has been present inside of a meeting room for more than two minutes.
        Alternitavely, one may join an existing meeting by typing or pasting its URL in the browser's address bar.
        Trussal does not currently support password-protected meeting rooms or user account creation. </p>

        <h4> Inviting other users to an existing meeting room </h4>
        <p> To invite users to an existing meeting, once inside a meeting room, click the icon that depicts a
        humanoid bust with a plus icon to its top right, which is the icon that is the third from the right 
        within the bottom toolbar and situated between the phone and three-dot icons.
        <figure>
          <img
            src="https://trussal-docs.quargsgreene.workers.dev/invite_to_meeting_toolbar.png"
            alt="A trackpad-controlled cursor hovering over a humanoid icon with a plus icon in the top right showing a tooltip that reads 'Invite people' on the bottom toolbar" />
          <figcaption>The invite button in the bottom toolbar</figcaption>
        </figure>
        Upon hovering over the correct icon, a tooltip that reads "Invite people" will appear, and once clicked,
        a modal window will appear with a button underneath "Invite more people" and "Share the meeting link to invite others"
        dialogs. Click this button, which contains an icon of two overlapping squares on the far left side, to copy
        the meeting URL to the clipboard. Exit this modal window by clicking the "x" icon. </p>
        <figure>
          <img
            src="https://trussal-docs.quargsgreene.workers.dev/meeting_invite_modal.png"
            alt="The meeting invite modal, which has copy, Google, Outlook, Yahoo, and email icons and the text 'Invite more people', 'Share the meeting link to invite others', 'trussal.com/someplace', and 'Share meeting invitation'" />
          <figcaption>The meeting invite modal</figcaption>
        </figure>

        <h4> Using Landmark & Gesture Mode to join a meeting </h4>
        <p>To activate Landmark & Gesture Mode on the landing page, close your left eye for at least two seconds or press the
        right arrow key once. You will be prompted to give your browser permission to access your camera.
        Before using your left eye to activate Landmark & Gesture mode, make sure your face is well-lit.
        Otheriwse, MediaPipe's model will not detect your face. Once Landmark & Gesture Mode has been activated,
        an additional cursor, which is a white square surrounding a black circle, and a virtual keyboard will appear within your browser. 
        To enter a meeting name, focus the text field. The text field will stay focused when the cursor is moved away from it.
        <br />
        Then dwell upon each of the keys. A black progress circle will appear, as well as a gray vertical progress bar within each key.
        Each key will briefly turn black as characters appear in the form. Note that if browsing Incognito, upon entering the
        prejoin room, you will have to give permission for your camera to be used once more. Then focus the text field to provide
        a display name if desired, type a display name, and click the "Join meeting" button.
        Dwelling upon the "✥" icon allows for dragging the virtual keyboard and subsequently holding one's head still refixes the keyboard's position, whereas
        dwelling upon the "⇲" icon before moving one's head resizes the virtual keyboard.
        Movement of the head up or right respectively increases the height and width of the keyboard with the opposite
        occurring when respectively moving down or left. Dwelling on the "&#9660" icons collapses the virtual keyboard
        and rotates the icon 90 degrees, upon which clicking re-expands the keyboard. To the left of the keyboard,
        a grayscale face mesh will appear and can be moved, scaled and hidden using the same buttons in its respective toolbar.
        The face mesh UI will also display each of the default gesture mappings as they are detected. </p>
        <figure>
          <img
            src="https://trussal-docs.quargsgreene.workers.dev/button_focus_media_pipe.png"
            alt="Focusing the 'Start meeting' button" />
          <figcaption>Focusing the 'Start meeting' button</figcaption>
        </figure>
        <figure>
          <img
            src="https://trussal-docs.quargsgreene.workers.dev/resize_keyboard.png"
            alt="Resizing the keyboard by focusing the ⇲ button on the virtual keyboard" />
          <figcaption>Resizing the keyboard by focusing the ⇲ button on the virtual keyboard. Focus each of the buttons with the head cursor.</figcaption>
        </figure>
        <figure>
          <img
            src="https://trussal-docs.quargsgreene.workers.dev/enlarge_face.png"
            alt="Resizing the face panel by focus" />
          <figcaption>The face panel can be resized, in addition to dragged, and collapsed with the head cursor as well.</figcaption>
        </figure>
        <figure>
          <img
            src="https://trussal-docs.quargsgreene.workers.dev/drag_keyboard.png"
            alt="Dragging the keyboard by focusing the ✥ button" />
          <figcaption>Dragging the keyboard by focusing the ✥ button</figcaption>
        </figure>
        <figure>
          <img
            src="https://trussal-docs.quargsgreene.workers.dev/collapse_keyboard.png"
            alt="Collapsing the keyboard by focusing the &#9660 button" />
          <figcaption>Collapsing the keyboard by focusing the &#9660 button</figcaption>
        </figure>

    <h3>Navigating the Meeting Room</h3>
        <p>Much of a Trussal meeting room operates as it does within Jitsi Meet. However, there are some key differences that are discussed below. </p>

        <h4>Video</h4>
        <p>Participants cannot see their own or other participants' video by default, even when one permits webcam access.
        A participant cannot turn on video by clicking the camera icon. In order to stream one's webcam to the meeting room,
        one must fulfill two prerequisites which are: 1. The participant's join order participant index token must be included in the Metaprogram
        and 2. The participant calls the initCam Hydra method and/or the device name corresponding to the participant's webcam
        is passed as an argument to liveCapture. Live video streaming data may only be viewed globally within the Aggregator's video feed.
        See the associated documentation regarding initCam, the Aggregator, and liveCapture for further
        details on proper usage and the Aggregator's role within a meeting. If live webcam access is lost and the participant's index token
        remains present within a valid Metaprogram, the last recorded buffer will be streamed until the token is removed from
        the Metaprogram. If a participant's webcam live feed is requested within the Metaprogram, but it has not been provided,
        the Aggregator will stream a black square in lieu of that participant's video. One may also individually view bots' videos and one's own
        video output in minimized video panel squares.
        </p>

        <h4>Audio</h4>
        <p>As is the case regarding video, one cannot hear one's own or other participants' audio by default.
        In order to hear one's own or others' audio, in addition to giving the browser permission to access the microphone,
        one must call the liveCapture method and provide a valid local audio device name. Note that Hydra's audio processing capabilities
        only visualize audio data and do not support playback. 
        </p>

        <h4>Meeting Chat, Polls, Screen Sharing, Breakout Rooms, and Reactions</h4>
        <p>Each of these native Jitsi Meet features may be used identically to how they are used in Jitsi Meet.
        However, patterns manipulating the use of each of these features may be simultaneously applied to the meeting room,
        and all updates are sequential with respect to the timestamps of manually-triggered events against the stream scheduling
        performed by the Aggregator.
        </p>

    <h3>The Aggregator and Conductor</h3>
      <p>The Aggregator is responsible for scheduling each participants streaming turn. It appears in the meeting room as a bot meeting participant with participant index 'pi'.
      The Aggregator itself cannot be scheduled to have a turn and does not run any of its own code. Its output consists of that of participant who it has currently scheduled.
      Only the Aggregator outputs the coordinated live coded patterns to the entire meeting room and alters room-wide CSS during a meeting. The conductor monitors the health of 
      bot participants, as well as compliance with dynamic, automated memory and network bandwidth constraints, removing bot participants from the meeting room, and shutting off 
      the Aggregator's video feed as it sees fit in order to preserve the navigability of the meeting.
      </p>

    <h3>Trussal Studio</h3>
        <p>In the bottom right corner of the meeting room is a "Studio" button. Clicking or dwelling upon it opens Trussal Studio.
        Trussal Studio is where all of the live coding and coordination with the Aggregator happens, as well as the interface for one's personal meeting theming, and
        a dashboard displaying WCL, WCPL, WCRTT, and one's own round-trip time (RTT). Changes to the color scheme and font size only appear in one's own editor. There is an editor for each bot and human participant,
        and a single Metaprogram editor. All human participants may collaboratively edit the Metaprogram and any bot's code, as well as capture media assets from other participants.
        Trussal Studio also displays JPattern syntax errors to the user. The Metaprogram is stored in its own conflict-free replicated data type (CRDT). 
        Each bot editor corresponds to its own CRDT as well. In addition to the aforementioned ways to start hands-free features, one may also open the 
        gesture and landmark detection using the "Face" and "Keys" buttons in the top right corner of Trussal Studio. As is the case in Strudel, the keyboard
        shortcut "Ctrl" + "Enter" reevaluates the code in the currently focused editor, and "Ctrl" + "." pauses the running of the code
        inside of the current editor. In addition to mirroring Strudel's support for uploads and fetching of of audio samples as .wav with a sample rate of 48kHz with a bit-depth of 16 bits,
        Trussal Studio supports JSON, CSV, and TSV file uploads, as well as fetching of JPEG, PNG, GIF, SVG, BMP, MOV, MP4, TXT, and MP3 files.
        </p>
    <h3>Multi-Dimensional CSS Values</h3>
        <p>In order to create patterns with multi-dimensional CSS values, enclose the value 
        in a pair of carets. 
        <span>Example:</span>
        <code>$:css(".something")
        .borderRadius("<^1em 2em 3em 4em^ ^2em 4em 6em 8em^>")
        </code>
        <code>
        $ css ".something"
        # borderRadius <^1em 2em 3em 4em^ ^2em 4em 6em 8em^>
        </code>
        </p>

    <h3>MediaPipe in the Meeting Room</h3>
        <p>As is the case regarding the face mesh display and virtual keyboard, dwelling upon the same icons allows one to drag the Trussal Studio user interface.
        One may also focus other menus and text fields using the head landmark cursor. Inside of a meeting room, the virtual keyboard provides JPattern autocomplete suggestions using weighted trie search. 
        By default, various gestures are associated with different changes to JPattern code, including substitutions according to regular expressions, depending on which editor is focused.
        To focus an editor while typing using the virtual keyboard, and fix the position of the blinking cursor, hover over it with the head 
        landmark cursor and pucker your lips. One may also create new buttons inline, which, depending on the editor in which they are created,
        may be clicked on by all participants, using the head cursor, or manually. Sequences of gesture-associated events can themselves be patterns. Code updates and pauses take place
        respectively by hovering over and dwelling upon any of the "Eval" or "Stop" buttons.
        See the JPattern reference for the proper button creation syntax, as well as for further information regarding the gestureAndLandmarkConfig method.
        </p>
        <h4>Adding Inline Buttons</h4>
        <p>Adding an * to a voice name creates an inline button upon reevaluation.
        </p>
        <span>Example:</span>
        <code>*btn: sound("piano:2")
        .note("a4 b4 c4)
        </code>
        <code>*btn sound "piano:2"
        # note "a4 b4 c4"
        </code>
    <h3>JPattern Reference</h3>
        <p>
          Using JPattern, one may, in addition to live coding synthesized audio and visuals using Strudel and Hydra, live code text, reactions, polls, gestural sequences, CSS,
          external data fetching, and breakout room assignments. What follows is a reference detailing the syntax, usage examples, and output of JPattern and its associated functions.
        </p>

        <h4>Design</h4>
          <p>
          JPattern is a domain-specific, multi-paradigm programming language. JPattern is a superset of Strudel and Hydra, extending them to support creating patterns using video conferencing features
          that are not supported in either language. While maintaining Strudel's declarative approach, JPattern also handles complex immutable state conveyed through JavaScript objects as function arguments,
          and overloads Strudel operators and functions. JPattern also supports distributed and metaprogramming through its simultaneous editing, and the configuration of bot code before spawning.
          Within any editor that does not store the text of the Metaprogram, one may write Strudel and/or Hydra code. Unlike in the Strudel REPL, <code> await initHydra() </code> 
          is not required at the beginning of the program.
          </p>

        <h4>The Metaprogram</h4>
            <p>The Metaprogram controls when each participant has a performance turn and is shared between all participants. 
            All human participants can directly and simultaneously edit the Metaprogram, which is stored in a CRDT.</p>
            <h5>Participant Identifiers</h5>
            <p>As each participant joins the meeting, an ordered index token is assigned and persists for the entire meeting.
            Human participants receive non-negative ordinal integer string tokens, starting with '0' for the first participant.
            Bots receive a token that is prefixed with the human's token and a letter, starting with 'a'. Another letter,
            starting with 'a', is appended when the number of bot participants spawned by a given human satisfies |bot participants| ≡ 1 mod 26. 
            Note that these identifiers exist separately from the meeting identifier assigned by Jitsi Meet to make it easier for humans to type them 
            into the Metaprogram. All valid Metaprograms must reference at least one participant.
            </p>
            <h5>Participant Turn Ordering</h5>
            <p>
            By default, human participants manually dictate the participant turn order by arranging participant tokens into patterns.
            Both of the following are interchangeable examples of valid Metaprogram participant ordering syntax for a meeting
            with at least three human participants and one bot participant spawned by participant '2':
            <code>
            $ participants <0 2a 1 0>
            </code>
            <code>
            $: participants("<0 2a 1 0>")
            </code>
            Alternatively, one may allow the meeting participant turn ordering to be dictated by consistent hashing.
            This means that every participant's ordinal identifier will be hashed as a node and any existing instructions
            dictating ordering a literal ordering of a proper subset of the meeting participants will be overidden.
            Example:
            <code>
            $ participants <0 2a 1 0>
            # ring
            </code>
            </p>
            <h5>Determining Participant Turn Length</h5>
            <p>Each Metaprogram mandatorily calls the cycles method, which in turn multiplies a scale factor by a network metric,
            outputting each participant's turn length unit.
            </p>
            <h5>Method Chaining Syntax</h5>
            <p>
            Room effects and other methods can be chained together. 
            Currently, the participants, room, noise, crush, echo, grid, and mosaic, and cycles methods are supported.
            Example:
            <code>ode generation features.$ participants <1 3 2 0>
            # cycles "wcl" 30
            # room "wcpl" 10
            # noise "wcl" 100 "wcrtt" 0.2
            </code>
            </p>
            <h5>Operators</h5>
            <p>JPattern overloads Strudel's @, !, *, ?, _, ~, and / operators.
            <table>
              <tr><th>Operator</th><th>Effect</th></tr>
              <tr><td><code>0@n</code></td><td>0 holds the ring for <em>n</em> cycles (in <code>&lt;…&gt;</code>) or a share of one cycle (in <code>[…]</code>).</td></tr>
              <tr><td><code>0!n</code></td><td>0 takes n turns in a row. Bare <code>!</code> means <code>!2</code>.</td></tr>
              <tr><td><code>0?</code> / <code>0?p</code></td><td>0's turn is silently dropped with probability 0.5 (or <em>p</em>) — the cycle still advances.</td></tr>
              <tr><td><code>&lt;…&gt;*n</code> / <code>/n</code> / <code>%n</code></td><td>Speeds up, slows down, or fixes the steps-per-cycle of the whole ring.</td></tr>
              <tr><td><code>0*n</code> / <code>0/n</code></td><td>The same, applied to one token's own slot only.</td></tr>
            </table> 
            </p>

        <h4>Preprocessing Directives</h4>
          <p>There are three different preprocessing directives, signifying who each program belongs to.
          They are 'metaprogram editor', 'personal editor', and 'bot editor'. Each program must contain 
          a preprocessing directive, even if it only contains Strudel and/or Hydra code.
        </p>
        <h4>Global Room Pattern Functions</h4>
        ${renderFnSection(JPATTERN_FUNCTIONS)} 

        <h4>Text Patterns</h4>
        ${renderFnSection(TEXT_CYCLES_FUNCTIONS)}

        <h4>CSS Patterns</h4>
        ${renderFnSection(CSS_CYCLES_FUNCTIONS)}

        <h4>Configuration Methods</h4>
        ${renderFnSection(CONFIG_FUNCTIONS)}

        <h4>Live Capture Patterns</h4>
        ${renderFnSection(LIVE_CAPTURE_FUNCTIONS)}

        <h4>Jitsi UI Patterns</h4>
        ${renderFnSection(UI_PATTERN_FUNCTIONS)}

        <h4>Other Overloaded Strudel Functions</h4>
        ${renderFnSection(STRUDEL_OVERLOAD)}

        <h4>Data Fetching Patterns</h4>
        ${renderFnSection(FETCH_PATTERNS)}
  `
}

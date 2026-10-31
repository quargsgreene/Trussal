const JPATTERN_FUNCTIONS = [
  {
    id: 'jp-participants',
    name: '$ participants',
    sig: 'participants([participant_tokens])',
    body: `
      <p>Orders participants' turns when ring is set to false.</p>
      <p>Turn-modifying operators are written glued to the token, no spaces:</p>
      <code>
        $: participants("<0 9>")
      </code>
      `,
  },
  {
    id: 'jp-ring',
    name: 'ring',
    sig: 'ring([boolean])',
    body: `
      <p>Sets the Metaprogram into consistent hashing mode.</p>
      <code>
        $: participants(3)
        .ring(true)
      </code>
      `,
  },
  {
    id: 'jp-cycles',
    name: 'cycles',
    sig: 'cycles [network_metric_abbreviation="wcl"] [scale factor]  [fixed amount]',
    body: `
      <p>Sets how long one cycle — and so one performer's turn — lasts, as a
      multiple of a live network metric: <code>"wcl"</code> (worst-case
      mouth-to-ear latency), <code>wcj</code>, <code>wcrtt</code>, or <code>"wcpl"</code> (worst-case packet loss). Exactly one <code># cycles</code> line is allowed per
      program. Metric names are always quoted.</p>
      <pre># cycles "wcl" 10 0.3   <span class="da-comment">// WCL pinned at 300ms, scaled ×10 → every cycle is 3s</span></pre>`,
  },
  {
    id: 'jp-tempo',
    name: 'tempo ',
    sig: 'tempo [number=120] [tempo_unit="cpm"]',
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
      <figure>
          <img
            src="https://trussal-docs.quargsgreene.workers.dev/room_wcl_200.png"
            alt="Room effect in Hydra" />
          <figcaption>The room effect applied to Hydra output</figcaption>
      </figure>
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
      <figure>
          <img
            src="https://trussal-docs.quargsgreene.workers.dev/crush_hydra.png"
            alt="Crush effect in Hydra" />
          <figcaption>The crush effect applied to Hydra output</figcaption>
      </figure>
      <p>Varies the bit-depth and resolution of the Aggregator's audio and visual output according to the value of the currently
      supplied network metric. Example(s):</p>
      <pre># crush "wcpl" 1 0.25    <span class="da-comment">// pinned at 25% loss: a steady 4 bits</span></pre>`,
  },
  {
    id: 'jp-echo',
    name: 'echo',
    sig: 'echo [network_metric="wcl"] [length_in_cycles] [network_metric="wcl"] [feedback_percentage] [network_metric="wcl"] [output_mix_volume] [pattern_medium_set]',
    body: `
      <figure>
          <img
            src="https://trussal-docs.quargsgreene.workers.dev/echo_hydra.png"
            alt="Echo effect in Hydra" />
          <figcaption>The echo effect applied to Hydra output</figcaption>
      </figure>
      <figure>
          <img
            src="https://trussal-docs.quargsgreene.workers.dev/Echo.png"
            alt="Echo effect in Hydra with more than one participant in the mosaic view" />
          <figcaption>Echo effect with more than one participant in the mosaic view</figcaption>
      </figure>
      <p>Applies a network-modulated echo effect to the Aggregator's audio and video output. Example(s):</p>
      <pre># echo "wcl" 2 "wcpl" 0.3 "wcrtt" 3 1500 20 1200</pre>`,
  },
  {
    id: 'jp-noise',
    name: 'noise',
    sig: 'noise [network_metric="wcl"] [lowpass_cutoff_scale_factor] [network_metric="wcl"] [output_mix_volume] [pattern_medium_set]',
    body: `
      <figure>
          <img
            src="https://trussal-docs.quargsgreene.workers.dev/noise_hydra.png"
            alt="Noise effect in Hydra" />
          <figcaption>The noise effect applied to Hydra output</figcaption>
      </figure>
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
      the spin is musical; with <code># tiling</code> or
      <code># tessellation</code> every copy spins in place. A written group
      rests an axis to zero; an unwritten one defaults to a lazy
      <code>[0 0.5 0]</code> turn. <code># camera3d</code>,
      <code># controls3d</code> and <code># lighting3d</code> set how the
      shape is viewed and lit.</p>`,
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
      <p>Covers the whole output with the active shape, at least
      <code>cols</code> across and <code>rows</code> down. A 2D shape tiles
      the page in the lattice it really tiles in — squares in a grid,
      triangles alternating up and down, hexagons (<code>polygon [6]</code>)
      in a honeycomb, diamonds (<code>polygon [4]</code>) in offset rows —
      while circles, stars and other polygons pack in staggered rows with
      the background in the gaps. A 3D shape makes a honeycomb: copies
      close-packed edge to edge across the frame (three.js), laid over
      whatever the camera sees, so <code># controls3d</code> can fly over
      it. Every copy carries the frame and spins in place at the SHAPE's own
      spin; the shape's scale reads as how full each cell is (gaps below 1).
      With no shape, the frame itself becomes a mirrored quilt (p5.js),
      alternate cells flipped so the seams interlock, the whole lattice
      turning at <code>spin</code> turns per cycle. Defaults 4 columns,
      3 rows, spin 0.35. Example(s):</p>
      <pre># polygon [6] [0.95]
# tessellation [8 5]               <span class="da-comment">// a honeycomb of hexagons</span>
# torus [1 0.35] [0.9]
# tessellation [8 5]               <span class="da-comment">// a sheet of spinning tori</span>
# tessellation [6 4 0.5]           <span class="da-comment">// no shape: the quilt</span></pre>`,
  },
  {
    id: 'jp-tiling',
    name: 'tiling',
    sig: 'tiling <none|grid|hex|strip> [count]',
    body: `
      <p>Instances the active 3D shape across the output instead of drawing
      one — <code>grid</code>, <code>hex</code> (staggered rows), or a single
      <code>strip</code>; <code>none</code> clears back to one instance.
      Count defaults to 3 and caps at 12; the lattice is chosen to leave the
      fewest gaps (9 is 3×3) and the camera pulls back to frame it. Each copy
      spins in place about its own center while the lattice holds still.
      <code># tessellation</code> takes precedence. Example(s):</p>
      <pre># tiling hex [7]
# tiling none</pre>`,
  },
  {
    id: 'jp-camera3d',
    name: 'camera3d',
    sig: 'camera3d [azimuth polar zoom fov roll]',
    body: `
      <p>Places the three.js camera. Angles are degrees, as in three.js's
      OrbitControls: <code>azimuth</code> 0–360 around the vertical (0 is
      straight on), <code>polar</code> down from overhead (90 is level,
      smaller looks down from above, larger up from below). <code>zoom</code>
      multiplies the closeness of the auto-fitted (or the shape's own)
      distance — 2 is twice as close. <code>fov</code> is the lens angle
      (default 50); the framing refits to it, so it changes perspective, not
      size. <code>roll</code> tilts the picture. Rest any slot for its
      default. Applies to every three.js layer — shape, honeycomb, skybox,
      particle3. Example(s):</p>
      <pre># camera3d [30 60 1.5]           <span class="da-comment">// right, above, closer</span>
# camera3d [~ ~ ~ 20]              <span class="da-comment">// a long lens: flattened</span>
# camera3d [<360 90 180 270>]      <span class="da-comment">// a new side every cycle</span></pre>`,
  },
  {
    id: 'jp-controls3d',
    name: 'controls3d',
    sig: 'controls3d <none|orbit|trackball|map|fly> [speed amount]',
    body: `
      <p>Moves the camera on its own, in the style of the three.js control
      of the same name — the Aggregator's view has no mouse, so each control
      is a motion on the cycle grid, layered over <code># camera3d</code>.
      <code>speed</code> is laps per cycle (default 0.125: one lap every
      8 cycles). <code>orbit</code> circles the vertical, bobbing
      <code>amount</code>° over and under (default 20).
      <code>trackball</code> tumbles round an axis tilted <code>amount</code>°
      (default 35), rolling as it goes. <code>map</code> pans in a
      figure-eight reaching <code>amount</code> of the view (default 0.35).
      <code>fly</code> dives toward the shape and back, closing
      <code>amount</code> of the gap to its surface (default 0.6, at most
      0.95). <code>none</code> holds the camera still. Example(s):</p>
      <pre># controls3d orbit [0.25 30]
# controls3d fly [0.5 0.8]
# controls3d none</pre>`,
  },
  {
    id: 'jp-lighting3d',
    name: 'lighting3d',
    sig: 'lighting3d <none|ambient|directional|point|hemisphere|studio> [intensity azimuth polar spin] ["color"]',
    body: `
      <p>Lights the 3D shapes. By default (<code>none</code>) they are
      unlit, so the frame's own colors are the surface; any other mode
      shades them. <code>ambient</code> is even light; <code>directional</code>
      a sun; <code>point</code> a lamp near the shape; <code>hemisphere</code>
      sky-colored from above and dark from below; <code>studio</code> the
      three-point rig (key, fill, rim). <code>intensity</code> 1 shows the
      frame at full brightness where the key light hits it square on.
      <code>azimuth</code>/<code>polar</code> aim the key light, in the same
      degrees as <code># camera3d</code> (default 45/45: upper right front),
      and <code>spin</code> circles it at turns per cycle. The quoted color
      tints the light, and may be a pattern. Example(s):</p>
      <pre># lighting3d directional
# lighting3d point [1.5 300 60 0.25] "#ffd0a0"
# lighting3d studio <"#ffffff" "#ffb070"></pre>`,
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
  {
    id: 'jp-out',
    name: 'out',
    sig: 'out ["device_name"] [channel ...] [media]',
    body: `
      <p>Also streams the Aggregator's output to a named device on whichever
      participant's computer owns it: a monitor for video, text and CSS, or a
      speaker system for audio, optionally on specific 1-based channels.
      The name matches the device's label exactly, or else as a substring,
      ignoring case. <code>"screen 2"</code> picks a second monitor by position.
      Nothing is sent until the device's owner allows it. Each
      <code># out</code> line is its own route. Without a medium set, every
      medium the device can carry is routed. Without any
      <code># out</code>, output is unchanged. Example(s):</p>
      <pre># out "lobby screen" ["video" "text"]
# out "MOTU M4" 3 4 ["audio"]</pre>`,
  },
  {
    id: 'jp-inhabit',
    name: 'inhabit',
    sig: 'inhabit [host] [guests]',
    body: `
      <p>Lets participants temporarily inhabit another participant. The
      guests see the host's personal editor in place of their own, and the
      host and every guest can type into it at the same time. Play runs it as
      the host's program. Guests can also read the host's private text chats
      and send private messages as the host, which the host's browser sends.
      They wear the host's theme, see the host's device names, and can answer
      output requests for those devices. Guests hold the host's metaprogram
      permissions, follow the host into its breakout room, and take the host's
      turn on the ring, so their audio is heard in the host's place while
      their own turn is silent.</p>
      <p>The host is one participant, or a pattern of participants and
      <code>~</code>, which changes hosts each cycle. <code>~</code> means
      the guests are themselves for that cycle. A <code>/n</code> after the
      pattern holds each host for n cycles. The guests are one participant
      or a set in brackets. Humans may inhabit bots and bots may inhabit
      humans. Many guests may inhabit one host, but each guest inhabits only
      one host at a time and appears in only one <code># inhabit</code> line.
      Guests keep their own editor, theme and room, which come back when they
      leave. The host sees who is inhabiting them and what they can see.
      Example(s):</p>
      <pre># inhabit 0 1
# inhabit <0 ~ 3a>/4 [1 2b]</pre>`,
  },

];

const TEXT_CYCLES_FUNCTIONS = [
  {
    id: 'tc-word',
    name: 'word()\n w',
    sig: '.word([pattern])\n.w([pattern])\n# word [pattern]\n#w [pattern]',
    body: `
      <p>Sends the specified words to the meeting-wide chat window. A few characters need escaping to render literally:</p>
      <table>personal editor
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
    sig: `.spacing([character_spacing_pattern])`,
    body: `<p>Sets the spacing amount between characters for the specified text pattern in pixels./p>
    <span>Example(s):</span>
    <code>$: typeface("Verdana")
    .word("Zecke")
    .spacing("<3 30 300>")
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
    `
  },
  {
    id: 'tc-speak',
    name: 'speak',
    sig: `.speak([language], [voice])\n # speak`,
    body: `<p>Speaks each word aloud, using the browser's voice, at the moment it appears in the chat window.
    You'll hear the text exactly as it shows on screen, including any changes from the room's <code>#</code> effects.
    The optional language is a tag like <code>'fr-FR'</code>. The optional voice is either a number that picks
    from that language's voices or part of a voice's name.</p>
    <p>Everyone in the meeting hears the words, because each participant's browser speaks them as they
    appear in that participant's chat.</p>
    <p>Words written in the International Phonetic Alphabet are played as the sounds the symbols stand for,
    not read out in English: <code>x</code> is a velar fricative, <code>y</code> is a close front rounded
    vowel, and <code>ɬ</code> is a lateral fricative. Each sound is synthesized from its place and manner of
    articulation. Length (<code>ː ˑ ̆</code>), stress (<code>ˈ ˌ</code>), tone letters and tone marks
    (<code>˥ ˧˥ á ǎ</code>), up- and downstep, and global rise and fall are all heard. So are voicelessness,
    breathy and creaky voice, nasalization, aspiration, labialization, palatalization, velarization,
    pharyngealization, rhoticity, nasal and lateral release, unreleased stops, ejectives, syllabicity and
    tie bars. Diacritics that only move the tongue slightly (advanced, retracted, raised, lowered,
    centralized, more or less rounded, tongue root, dental, apical, laminal, linguolabial) can be typed but
    don't change the sound.</p>
    <p>A word counts as IPA if it uses a symbol that ordinary spelling doesn't, or if it is a transcription
    wrapped in <code>/…/</code> or <code>[…]</code>. Write a transcription in single quotes, because
    <code>/</code> and <code>[ ]</code> mean something else in double-quoted mini-notation. Other words are
    spoken by the browser's text-to-speech voice.</p>
    <p>To sing the words, add a pitch with Strudel's <code>note</code>, <code>freq</code>, <code>scale</code>
    or <code>run</code>. Every sound in a word is sung at the pitch of its event. To give each sound its own
    pitch, write the sounds as separate steps, such as <code>word("ʃ a l a")</code>, so each step gets the
    next note. Tone and stress marks bend the pitch up or down from the note. Sung sounds are synthesized at
    the note's pitch, so a vowel keeps its quality when it's sung high or low.</p>
    <p>A word that has a pitch or a <code>quantize</code> always uses the IPA voice, even if it's written in
    ordinary spelling, because the browser's voice can't be tuned or timed. You can also choose the IPA voice
    directly with <code>.speak('ipa')</code>.</p>
    <p>To type IPA symbols, press the <strong>IPA</strong> key on the virtual keyboard. The IPA keyboard is
    split into pages: vowels, consonants, other symbols, diacritics, stress &amp; tone, and impossible. Press
    <strong>ABC</strong> to go back.</p>
    <p>The <strong>Impossible</strong> page has the sounds in the shaded cells of the IPA chart, which the
    IPA judges impossible for a human to make. Because nobody can make them, the synthesized voice makes
    them by extending its rules for the sounds people can make: each one uses its row's manner (stop,
    nasal, trill, tap, lateral) at its column's place, and keeps making sound where a real throat
    couldn't. For example, a glottal nasal hums through the nose even though the glottis is closed, and
    a velar trill flaps the back of the tongue like a slow lip trill. These sounds have no IPA letters,
    so each one is written the way the IPA writes any sound it has no letter for, as the nearest letter
    plus a diacritic: <code>ʡ̬ ʔ̬</code> (voiced pharyngeal and glottal plosives), <code>ʡ̃ ʔ̃</code>
    (pharyngeal and glottal nasals), <code>ʀ̟ ʢ̠</code> (velar and glottal trills), <code>ɡ̆ ʔ̆</code>
    (velar and glottal taps), <code>ɦ̞</code> (glottal approximant), <code>ɸˡ βˡ fˡ vˡ ħˡ ʕˡ hˡ ɦˡ</code>
    (bilabial, labiodental, pharyngeal and glottal lateral fricatives) and <code>β̞ˡ ʋˡ ʕ̞ˡ ɦ̞ˡ</code> (the
    same four lateral approximants). Each combination plays as that one sound wherever it's written, so
    <code>ɡ̆</code> is a velar tap, not a short <code>ɡ</code>, and <code>fˡ</code> is a lateral
    fricative, not an <code>f</code> with lateral release. Other diacritics still work on them, such as
    <code>ʔ̥̃</code> for a voiceless glottal nasal.</p>
    <p>To type in another writing system, press the <strong>🌐</strong> key in the bottom-left corner of
    the virtual keyboard and choose one: Latin with diacritics (umlauts, ß and other accented letters),
    Arabic, Hebrew, Canadian Syllabics, Northern Brahmic (Devanagari, Bengali, Gurmukhi, Gujarati, Odia),
    Southern Brahmic (Tamil, Telugu, Kannada, Malayalam, Sinhala), Thaana, Armenian, Cyrillic, Georgian,
    Greek, Hangul, Mongolian, Neo-Tifinagh, Thai, Perso-Arabic, Osage, Cherokee, Hanzi, Kana &amp; Kanji,
    or Emoji. Hangul letters join into syllable blocks as you type them. The keyboard remembers your
    choice.</p>
    <p>Words in these scripts are spoken too, by the synthesized voice: each word is converted to IPA and
    played from the same phonetic sounds as an IPA word, so everyone in the meeting hears the same voice
    whatever voices their browser has. The conversion is a rough guide to pronunciation, not a
    dictionary: it adds the vowels that Arabic, Hebrew and Thaana usually leave unwritten, and it only
    knows readings for the Chinese characters and Kanji on the keyboard. A Chinese character is read in
    Mandarin, unless the word also contains kana or you pass <code>'ja'</code> as the language. To have
    your browser's own voice read the word instead, name a voice as well as a language, as in
    <code>.speak('ar-SA', 0)</code>. Emoji are read by the browser's voice, and are silent when sung.</p>
    <p>To make your own emoji, open the Emoji keyboard and press <strong>＋</strong> on its
    <strong>Mine</strong> page, or drop image files onto the keyboard. Each image is shrunk to emoji size
    and gets a name from its filename, and its key types that name between colons, like
    <code>:party_cat:</code>. Wherever a word in the chat contains that code, everyone in the meeting sees
    the picture, including people who join later. When spoken, the browser's voice reads the name and the
    synthesized voice skips it. Press <strong>🗑</strong> and then an emoji to delete it. You can keep up
    to 64 of your own emoji.</p>
    <span>Example(s):</span>
    <code>$: word("&lt;hello ʃiːp&gt;").speak()</code>
    <code>$: word('/ˈχaʁt͡s/').speak()</code>
    <code>$: word('/ma˥ ma˧˥ ma˨˩˦ ma˥˩/').speak()</code>
    <code>$: word("bonjour").speak('fr-FR', 1)</code>
    <code>$: word("&lt;مرحبا 안녕하세요 ᏣᎳᎩ&gt;").speak()</code>
    <code>$: word("&lt;hello:party_cat: :party_cat:&gt;").speak()</code>
    <code>$: note("c4 e4 g4").word("नमस्ते").speak()</code>
    <code>$: note("c4 e4 g4 e4").word("ʃa").speak()</code>
    <code>$: n(run(8)).scale("C:minor").word("la").speak()</code>
    <code>$: freq("&lt;220 330&gt;").word('/ʁuʒ/').speak()</code>
    `
  },
  {
    id: 'tc-quantize',
    name: 'quantize',
    sig: `.quantize([beats_pattern])\n # quantize [beats_pattern]`,
    body: `<p>Sets how long each sound of a spoken word lasts, in beats of the Metaprogram's
    <code># tempo</code>. If there is no tempo, a beat is 120 bpm. Every participant applies the same
    Metaprogram, so the timing is the same for everyone. Use it with <code>.speak()</code>.</p>
    <p>Each sound gets one slot of that length. Long and half-long marks (<code>ː ˑ</code>) make the slot
    2 or 1.5 times as long, and extra-short (<code>̆</code>) makes it half as long. Sounds joined by a tie bar
    (<code>t͡s</code>) share one slot. A space or a minor group <code>|</code> is a silent slot, and a major
    group <code>‖</code> is two. A stop or click is placed at the end of its slot, so it is held closed and
    then released into the next sound.</p>
    <p>Like any control, it can be a pattern: <code>.quantize("&lt;1 0.5&gt;")</code>.</p>
    <span>Example(s):</span>
    <code>$: word('/ˈχaʁt͡s/').speak().quantize(0.5)</code>
    <code>$: note("&lt;c4 g3&gt;").word("sala").speak().quantize("&lt;1 0.25&gt;")</code>
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
    `,
  },
  {
    id: 'tc-color',
    name: 'color',
    sig: '.color([color_pattern])',
    body: `<p>Sets the CSS color value for the selected text. Overloads color in Strudel.</p>
    <code>$: typeface("Trebuchet MS")
    .word("nooooooooo")
    .color("#abcdef")
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
      </p>`,
  },
];

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
    id: 'pc-main',
    name: 'permissionsConfig',
    sig: "permissionsConfig([config_object])",
    body: `
      <p>Sets what other participants may do with you. Write it anywhere in your personal editor;
      it takes effect when you press Play.</p>
      <p><code>allowInhabitFrom</code> is who may inhabit you with the metaprogram's
      <code># inhabit</code>: "all" (the default), "none", or a list of participants.
      Anyone else named as your guest stays themselves.</p>
      <p><code>allowClipping</code> is whether others may clip your audio and video with
      liveCapture() (true by default). Setting it to false stops any clip of you that is already
      running and clears what it recorded.</p>
      <p>A permissionsConfig with a mistake in it changes nothing, so your previous permissions
      still apply. Leaving it out restores the defaults.</p>
      <span>Example:</span>
      <code>permissionsConfig({"allowInhabitFrom": ["1", "2b"], "allowClipping": false})
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
    id: 'jp-mosaic',
    name: 'mosaic',
    sig: 'mosaic [boolean]=true',
    body: `
      <figure>
        <img
          src="https://trussal-docs.quargsgreene.workers.dev/Trussal_2.png"
          alt="An example of the mosaic output" />
          <figcaption>Mosaic mode with a triadic color scheme</figcaption>
      </figure>
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
      <figure>
        <img
          src="https://trussal-docs.quargsgreene.workers.dev/collapse_keyboard.png"
          alt="Collapsing the keyboard by focusing the &#9660 button" />
          <figcaption>Collapsing the keyboard by focusing the &#9660 button</figcaption>
      </figure>
      `,
  },
  {
    id: 'breakout-patterns',
    name: 'breakout',
    sig: "breakout([breakout_room_assignment_pattern])",
    body: `
      <p>Creates a pattern of breakout room names and assignments. Does not recreate a preexisting breakout room.
      Rooms are created and participants moved by a moderator's browser, so a moderator must be in the main room.
      Anyone being moved between rooms sees a panic button at the bottom right, which returns them to the main room,
      notifies everyone, and stops breakout patterns from moving them again.</p>
      <span>Example:</span>
      <code>$: breakout({"name":"room", "participants": ["0", "1", "2b"]})
      </code>
      <p>The name may be a mini-notation pattern of room names, which moves participants back and forth.
      "main" is the main room. Within a pattern, escape a space in a room name with a backslash (written \\\\ in the literal).</p>
      <code>$: breakout({"name":"&lt;room main&gt;", "participants": ["2b"]}).slow(4)
      </code>
      `,
  },
  {
    id: 'assign',
    name: 'assign',
    sig: "assign([breakout_room_assignment_pattern])",
    body: `
      <p>Assigns participants to breakout rooms already created with breakout(), or to "main" to send them back to the main room.
      Does not reassign participants to a room to which they have already been assigned.</p>
      <span>Example:</span>
      <code>$: assign({"name":"&lt;room other main&gt;", "participants": ["0", "1", "2b"]})
      </code>
      `,
  },
  {
    id: 'meeting-move',
    name: 'meeting',
    sig: "meeting([meeting_assignment_pattern])",
    body: `
      <p>Moves participants to a different meeting on the same server, the way breakout() moves them to a breakout room.
      No moderator is needed: each participant named rejoins the other meeting from their own browser, a full page load that takes a few seconds,
      so a participant who has just arrived waits 8 seconds before the next move. Does not move a participant who is already in the named meeting.
      When patterns disagree about where someone should be, the most recent request wins, whichever meeting it came from.
      Anyone moved sees the same panic button as for breakout rooms, which returns them straight into the meeting they first joined
      and stops meeting patterns from moving them again.</p>
      <span>Example:</span>
      <code>$: meeting({"name":"jam2", "participants": ["0", "1", "2b"]})
      </code>
      <p>The name may be a mini-notation pattern of meeting names. "main" is the meeting the pattern is running in, so a pattern can send participants away and bring them back.
      Meeting names cannot contain spaces, /, ?, #, % or backslashes.</p>
      <code>$: meeting({"name":"&lt;jam2 main&gt;", "participants": ["2b"]}).slow(8)
      </code>
      `,
  },
]
const MULTIMEDIA_FUNCTIONS = [
  {
    id: 'mm-arrange',
    name: 'multiArrange',
    sig: 'multiArrange([cycles, pattern, ...], ..., [options])',
    body: `
      <p>Plays sections one after another, each for its number of cycles, like Strudel's
      <code>arrange</code>, except that a section may hold any medium: Strudel audio, Hydra visuals,
      text, CSS, files, polls and reactions. Every pattern after the cycle count plays at the same time.
      Hydra chains are written without <code>.out()</code>, and stay on screen until another Hydra
      section replaces them. A <code>css()</code> section sequences its chained properties; the SCSS
      written inside <code>css()</code> itself applies for as long as the pattern runs.</p>
      <p>The arrangement only moves forward during your turn, so each turn picks up where your last one
      left off. To stay on the room's beat, a turn that ended part-way through a cycle may repeat up to
      one cycle of what was already played. With no turns in the room it plays exactly like
      <code>arrange</code>. Options, given as the last argument:</p>
      <table>
        <tr><td><code>resume: false</code></td><td>Follow the room's cycles, like <code>arrange</code>, instead of your turns.</td></tr>
        <tr><td><code>output: o1</code></td><td>Draw Hydra sections to this output instead of <code>o0</code>.</td></tr>
      </table>
      <span>Example:</span>
      <code>$: multiArrange(
  [4, s("bd*4"), osc(10).kaleid()],
  [2, word("&lt;hello there&gt;"), noise(3)],
  [2, n("0 2 4").scale("C:minor"), css(\`.ts-chip {}\`).borderColor("&lt;#ff00aa #00ffaa&gt;")]
)
      </code>`,
  },
  {
    id: 'mm-stack',
    name: 'multiStack',
    sig: 'multiStack(pattern, ..., [options])',
    body: `
      <p>Plays patterns of any medium at the same time, like Strudel's <code>stack</code>. Several
      Hydra chains are mixed evenly. Takes the same <code>output</code> option as
      <code>multiArrange</code>.</p>
      <span>Example:</span>
      <code>$: multiStack(s("hh*8"), word("&lt;one two&gt;"), osc(30), shape(4).rotate(0.2))
      </code>`,
  },
];
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
      `,
  },
];

const OUTPUT_ROUTE_FUNCTIONS = [
  {
    id: 'out-main',
    name: 'out',
    sig: '.out([device_name], [channels])/n # out [device_name] [channels]',
    body: `
      <p>Streams a voice's output, as the Aggregator streams it, to a named
      device on a participant's computer: a monitor for Hydra, word() and css()
      voices, or a speaker system for Strudel voices. A speaker route can name
      one channel or a list of channels, starting from 1. Two channels carry
      left and right. One channel, or three or more, each carry a mono mix.
      Device names match the way liveCapture matches them: the exact label
      first, then a substring, ignoring case.</p>
      <p>The device's owner is always asked first, once for each author and
      device. Choosing Deny lasts for the rest of the session. A monitor opens
      in its own window on that screen, so the owner clicks Open to place it.
      Click inside that window to make it fullscreen. A route plays during its
      author's turn on the ring, and stops when the author stops playing.
      Leaving off <code>.out</code>, or using Hydra's own
      <code>.out()</code> or <code>.out(o1)</code>, leaves output as it is.
      Example(s):</p>
      <code>vid: osc(100).out("some monitor")
drums: s("bd*4").out("MOTU M4", [3, 4])
$: word("hello").out("lobby screen")</code>
      <p>The Aggregator mixes all of one performer's voices of the same medium
      into a single stream. Two of a performer's voices routed to the same
      device therefore share that stream. A bot has no devices to route to,
      so <code>.out("…")</code> in a bot's editor is ignored.</p>
      `,
  },
];

const FETCH_PATTERNS = [
  {
    id:'image',
    name:'image',
    sig: 'image([image_file_name_pattern])',
    body:`<p>Sends image files up to 10MB in the public meeting chat window.
    .jpeg, .jpg, .png, .gif, .bmp, and .svg files are supported.</p>
    <code>$: image("<example.com/cat.png someplace.xyz/doggo.svg>")</code>
    `
  },
  {
    id:'video',
    name:'video',
    sig: 'video([video_file_name_pattern])',
    body:`<p>Sends video files up to 10MB in the public meeting chat window.
    .mp4, mov, and m4a files are supported.</p>
    <code>$: video("example.com/pupper.mov")</code>
    `
  },
  {
    id:'soundFile',
    name:'soundFile',
    sig: 'soundFile([sound_file_name_pattern])',
    body:`<p>Sends audio files up to 10MB in the public meeting chat window.
    .wav, mp3, and .ogg files are supported.</p>
    <code>$: soundFile("example.com/ratchet.wav")</code>
    `
  },
  {
    id:'pdfFile',
    name:'pdfFile',
    sig: 'pdfFile([pdf_file_name_pattern])',
    body: `<p>Sends PDF files up to 10MB in the public meeting chat window</p>
    <code>$: textFile("<example.com/shopping.pdf someplace.xyz/digeridoo.pdf>")</code>
    `
  },
  {
    id:'textFile',
    name:'textFile',
    sig: 'textFile([text_file_name_pattern])',
    body: `<p>Sends text files up to 10MB in the public meeting chat window</p>
    <code>$: textFile("<example.com/satie.txt someplace.xyz/transistor.txt>")</code>
    `
  },
  {
    id:'backing',
    name:'backing',
    sig: 'backing([file_name], [loop]=true, [turn_only]=false, [restart]=false)',
    body: `<p>Streams an uploaded audio or video file up to 10MB as a backing voice while you are playing,
    unbroken by the turns of the participant rotation. The second argument is whether it loops; the third is whether
    it streams only during your own turn; the fourth is whether pressing play starts the file over. A turn-only backing
    pauses when your turn ends and picks up where it left off on your next turn. Stopping pauses a backing too, and
    playing again resumes it where it left off unless restart is true. .wav, .mp3, .ogg, .mp4, .mov, and .m4a files are supported. A video plays full-frame beneath
    the mosaic. Requires the room's aggregator.</p>
    <code>$: backing("example.wav", true, false)</code>
    `
  },

]

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
  <img
    src="https://trussal-docs.quargsgreene.workers.dev/about-trussal-in-action.png"
    alt="A person at a computer running a Trussal meeting Photo credit: Jennifer Deafenbaugh" />
  <figcaption>A person at a computer running a Trussal meeting Photo credit: Jennifer Deafenbaugh</figcaption>
</figure>
</p>
`;

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
        The face mesh UI will also display each of the default gesture mappings as they are detected.
        Head-cursor speed, gain, and meeting-load sensitivity are adjusted with the sliders in the face panel, beside the mesh they affect. </p>
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
        only visualize audio data and do not support playback. To learn more about liveCapture, refer to the corresponding section below in
        the JPattern reference.
        </p>

        <h4>Meeting Chat, Polls, Screen Sharing, Breakout Rooms, and Reactions</h4>
        <p>Each of these native Jitsi Meet features may be used identically to how they are used in Jitsi Meet.
        However, patterns manipulating the use of these features (Meeting Chat, Polls, Screen Sharing, Reactions) may be simultaneously applied to the meeting room,
        and all updates are sequential with respect to the timestamps of manually-triggered events against the stream scheduling
        performed by the Aggregator.
        <figure>
        <img
          src="https://trussal-docs.quargsgreene.workers.dev/ReactionPattern.png"
          alt="The Aggregator" />
        <figcaption></figcaption>
      </figure>
        </p>

        <h4>MediaPipe in the Meeting Room</h4>
        <p>As is the case regarding the face mesh display and virtual keyboard, dwelling upon the same icons allows one to drag the Trussal Studio user interface.
        One may also focus other menus and text fields using the head landmark cursor. Inside of a meeting room, the virtual keyboard provides JPattern autocomplete suggestions using weighted trie search. 
        By default, various gestures are associated with different changes to JPattern code, including substitutions according to regular expressions, depending on which editor is focused.
        To focus an editor while typing using the virtual keyboard, and fix the position of the blinking cursor, hover over it with the head 
        landmark cursor and pucker your lips. One may also create new buttons inline, which, depending on the editor in which they are created,
        may be clicked on by all participants, using the head cursor, or manually. Sequences of gesture-associated events can themselves be patterns. Code updates and pauses take place
        respectively by hovering over and dwelling upon any of the "Eval" or "Stop" buttons.
        See the JPattern reference for the proper button creation syntax, as well as for further information regarding the gestureAndLandmarkConfig method.
      </p>

    <h3>The Aggregator and Conductor</h3>
      <p>The Aggregator is responsible for scheduling each participants streaming turn. It appears in the meeting room as a bot meeting participant with participant index 'pi'.
      The Aggregator itself cannot be scheduled to have a turn and does not run any of its own code. Its output consists of that of participant who it has currently scheduled.
      Only the Aggregator outputs the coordinated live coded patterns to the entire meeting room and alters room-wide CSS during a meeting. The conductor monitors the health of 
      bot participants, as well as compliance with dynamic, automated memory and network bandwidth constraints, removing bot participants from the meeting room, and shutting off 
      the Aggregator's video feed as it sees fit in order to preserve the navigability of the meeting.
      Conductor settings changed from inside a meeting apply to that meeting only; every other meeting keeps its own.
      </p>
      <figure>
        <img
          src="https://trussal-docs.quargsgreene.workers.dev/agg.png"
          alt="The Aggregator" />
        <figcaption>The Aggregator</figcaption>
      </figure>
      <figure>
        <img
          src="https://trussal-docs.quargsgreene.workers.dev/conductor_cropped.png"
          alt="The Conductor interface" />
        <figcaption>The Conductor interface</figcaption>
      </figure>
    <h3>Trussal Studio</h3>
        <p>In the bottom right corner of the meeting room is a "Studio" button. Clicking or dwelling upon it opens Trussal Studio.
        Trussal Studio is where all of the live coding and coordination with the Aggregator happens, as well as the interface for one's personal meeting theming, and
        a dashboard displaying WCL, WCPL, WCRTT, and one's own round-trip time (RTT). Changes to the color scheme and font size only appear in one's own editor. There is an editor for each bot and human participant,
        and a single Metaprogram editor. All human participants may collaboratively edit the Metaprogram and any bot's code, as well as capture media assets from other participants.
        Trussal Studio also displays JPattern syntax errors to the user. The Metaprogram is stored in its own conflict-free replicated data type (CRDT). 
        Each bot editor corresponds to its own CRDT as well. In addition to the aforementioned ways to start hands-free features, one may also open the 
        gesture and landmark detection using the "Face" and "Keys" buttons in the top right corner of Trussal Studio. The "Personal Theme Settings" button
        in the same toolbar group opens the color, font, and font-scale controls for one's own browser. Its "Walkie Talkie Mode" checkbox is the one
        setting there that others notice: while it is on, one talks only with the other participants who have it on, over plain camera and microphone in a
        small screen in the bottom left corner. To everyone else, and to the Aggregator, Walkie Talkie Mode participants have left the meeting, though the
        meeting is never ended because of it, even if every human participant has it on. As is the case in Strudel, the keyboard
        shortcut "Ctrl" + "Enter" reevaluates the code in the currently focused editor, and "Ctrl" + "." pauses the running of the code
        inside of the current editor. In addition to mirroring Strudel's support for uploads and fetching of of audio samples as .wav with a sample rate of 48kHz with a bit-depth of 16 bits,
        Trussal Studio supports JSON, CSV, and TSV file uploads, as well as fetching of JPEG, PNG, GIF, SVG, BMP, MOV, MP4, TXT, and MP3 files.
        </p>
      <figure>
        <img
          src="https://trussal-docs.quargsgreene.workers.dev/metaprogram_window.png"
          alt="The Metaprogram editor" />
        <figcaption>The Metaprogram editor</figcaption>
      </figure>
      <figure>
        <img
          src="https://trussal-docs.quargsgreene.workers.dev/personal_editor_window.png"
          alt="The personal editor in another configuration" />
        <figcaption>The personal editor in another configuration</figcaption>
      </figure>
      <figure>
        <img
          src="https://trussal-docs.quargsgreene.workers.dev/pe_2.png"
          alt="The personal editor in yet another theming configuration" />
        <figcaption>The personal editor in another theming configuration</figcaption>
      </figure>
      <figure>
        <img
          src="https://trussal-docs.quargsgreene.workers.dev/net_dash.png"
          alt="The network dashboard" />
        <figcaption>The network dashboard</figcaption>
      </figure>
      <figure>
        <img
          src="https://trussal-docs.quargsgreene.workers.dev/dark_mode.png"
          alt="Dark mode" />
        <figcaption>Dark mode</figcaption>
      </figure>
    <h3>Personal Editor Languages</h3>
        <p>The dropdown at the top of the personal editor switches the language it plays. Each language keeps its own draft, so switching
        back and forth loses nothing, and switching never stops anything already playing: Stop (or "Ctrl" + ".") stops only the language
        currently selected. "Ctrl" + "/" comments lines out with the selected language's own comment marker.</p>
        <table>
          <tr><th>Language</th><th>Where it runs</th><th>Who hears or sees it</th></tr>
          <tr><td>JPattern</td><td>Every browser in the room</td><td>The whole room, scheduled by the Metaprogram</td></tr>
          <tr><td>Strudel (pure)</td><td>Every browser in the room</td><td>The whole room. Written exactly as on strudel.cc — no <code>'personal editor'</code> directive needed; it is added when the code is sent</td></tr>
          <tr><td>Hydra (pure)</td><td>Every browser in the room</td><td>The whole room. Written exactly as on hydra.ojack.xyz — no <code>await initHydra()</code> needed, and blank lines are allowed</td></tr>
          <tr><td>Punctual</td><td>This browser only</td><td>Only you, unless you share your screen or route your audio (below)</td></tr>
          <tr><td>TidalCycles, Sonic Pi, SuperCollider (sclang), Renardo, zwirn, Sardine</td><td>Your own terminal, through the live bridge</td><td>The room, once your computer's audio is routed into your microphone (below)</td></tr>
          <tr><td>Text mode (no code)</td><td>Nowhere</td><td>Only you — a plain text scratchpad that is never evaluated</td></tr>
        </table>

        <h4>The Live Bridge</h4>
        <p>Languages that run in a terminal are reached through a small bridge that runs on your own computer. From a checkout of the Trussal
        repository (after <code>npm install</code>), start it in a terminal and leave it running:</p>
        <code>npm run bridge</code> (or <code>node scripts/live-bridge.mjs</code>)
        <p>It prints a token. Pick a terminal language in the dropdown, paste the token into the "Token" field that appears, and press Play.
        The bridge only listens on 127.0.0.1 and refuses any connection that does not present the token, because whatever reaches it runs
        as you. Each interpreter is started on its first Play and kept running; its output appears in the editor's status line and in the
        bridge's terminal. Some browsers ask for permission the first time a page connects to a local address — allow it. Useful settings, all optional:</p>
        <table>
          <tr><td><code>--port 7171</code></td><td>The port to listen on (match it in the "Bridge" field).</td></tr>
          <tr><td><code>TRUSSAL_BRIDGE_TOKEN</code></td><td>A fixed token instead of a new random one each run.</td></tr>
          <tr><td><code>TRUSSAL_BRIDGE_ORIGINS</code></td><td>Comma-separated page origins allowed to connect, e.g. <code>https://meet.example.org</code>.</td></tr>
          <tr><td><code>TIDAL_CMD</code>, <code>TIDAL_BOOT</code>, <code>SCLANG_CMD</code>, <code>RENARDO_CMD</code>, <code>ZWIRN_CMD</code>, <code>SARDINE_CMD</code></td><td>Override the command that starts an interpreter.</td></tr>
          <tr><td><code>SONIC_PI_HOST</code>, <code>SONIC_PI_PORT</code></td><td>Where Sonic Pi listens for OSC (default 127.0.0.1:4560).</td></tr>
        </table>

        <h4>Routing Terminal Audio Into the Room</h4>
        <p>Terminal languages make sound on your computer, not in the browser, so the room hears them only through your microphone input.
        Send your audio output into a virtual input and choose that input as your microphone in the meeting's audio settings:
        on Linux a PipeWire/PulseAudio monitor source (e.g. via <code>pavucontrol</code>, or <code>pw-loopback</code>); on macOS BlackHole;
        on Windows VB-CABLE. SuperCollider-based languages can instead be pointed at that device directly.</p>

        <h4>TidalCycles</h4>
        <p>Install GHC and Tidal (<code>cabal install --lib tidal</code>), and SuperCollider with SuperDirt; start SuperDirt in SuperCollider with
        <code>SuperDirt.start</code>. The bridge runs <code>ghci</code> with Tidal's <code>BootTidal.hs</code>, which it finds through GHC; if it cannot,
        set <code>TIDAL_BOOT=/path/to/BootTidal.hs</code>. The whole buffer is evaluated as one block, so several <code>d1</code>…<code>d16</code> lines can be
        sent together. Stop sends <code>hush</code>.</p>

        <h4>Sonic Pi</h4>
        <p>Sonic Pi cannot be driven from a terminal, so the bridge sends your code as an OSC cue to a receiver running inside Sonic Pi. Open Sonic Pi,
        paste this into an empty buffer of its own, and press Run once:</p>
        <code># Trussal live bridge receiver
live_loop :trussal_run do
  use_real_time
  code = sync "/osc*/trussal/run"
  run_code code[0]
end</code>
        <p>Each Play then runs your buffer as a new Run, exactly as if you had pressed Run in Sonic Pi. Stop stops every <code>live_loop</code> your last
        buffer started (Sonic Pi's own Stop button stops everything, the receiver included — press Run on it again afterwards).</p>

        <h4>SuperCollider (sclang)</h4>
        <p>Install SuperCollider so that <code>sclang</code> is on your PATH. The bridge starts its own <code>sclang</code>, so boot the server from
        your code (<code>s.waitForBoot { … }</code>). Stop runs <code>CmdPeriod.run</code>, the same as "Ctrl" + "." in the SuperCollider IDE.</p>

        <h4>Renardo</h4>
        <p>Install Renardo (<code>pip install renardo</code>) and SuperCollider, and complete Renardo's first-run setup (its SuperCollider
        startup code and sample download) by running <code>renardo</code> once. The bridge runs <code>renardo --pipe</code>; if Renardo should launch
        SuperCollider itself, set <code>RENARDO_CMD="renardo --sclang --pipe"</code>. Stop runs <code>Clock.clear()</code>.</p>

        <h4>zwirn</h4>
        <p>The easiest route is a zwirnmill release; the bridge needs the <code>zwirnzi</code> interpreter, built from source with Haskell and Rust
        (see zwirn's installation guide at codeberg.org/uzu/zwirn), or with <code>cabal install zwirnzi --flags +superdirt</code> to play through
        SuperDirt instead of its built-in Doux engine. The bridge runs <code>zwirnzi --ci.cli=true</code>. Stop sends <code>hush</code>.</p>

        <h4>Sardine</h4>
        <p>Install Python 3.10+ and Sardine (<code>pip install sardine-system</code>), configure it once with <code>sardine config</code>, and start
        SuperCollider with SuperDirt if you play samples. The bridge runs the <code>sardine</code> interpreter and sends your buffer to it, adding the
        blank lines Python needs after indented blocks. Stop runs <code>silence()</code>.</p>

        <h4>Punctual</h4>
        <p>Nothing to install: Punctual is loaded into the page from dktr0.github.io the first time it is played, and draws over the meeting the way
        Hydra does. Stop clears it.</p>

    <h3>JPattern Overview & Reference</h3>
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
            <code>
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
              <tr><td><code>&lt;…&An example of a multidimensional CSS pattern in actiongt;*n</code> / <code>/n</code> / <code>%n</code></td><td>Speeds up, slows down, or fixes the steps-per-cycle of the whole ring.</td></tr>
              <tr><td><code>0*n</code> / <code>0/n</code></td><td>The same, applied to one token's own slot only.</td></tr>
            </table> 
            </p>

        <h4>Preprocessing Directives</h4>
          <p>There are three different preprocessing directives, signifying who each program belongs to.
          They are 'metaprogram editor', 'personal editor', and 'bot editor'. Each program must contain 
          a preprocessing directive, even if it only contains Strudel and/or Hydra code.
        </p>    <code>$ typeface("Tremuchet MS")
    # word("nooooooooo")
    # color "#abcdef"
    </code>  
        <h4>Adding Inline Buttons</h4>
        <p>Adding an * to a voice name creates an inline button upon reevaluation.
        </p>
        <span>Example:</span>
        <code>*btn: sound("piano:2")
        .note("a4 b4 c4")
        </code>
        <figure>
        <img
          src="https://trussal-docs.quargsgreene.workers.dev/button_creatiom.png"
          alt="Creating a button in the Metaprogrammer" />
        <figcaption>Creating a button that appeands "<0>" if desired</figcaption>
        </figure>
        <h4>Global Room Pattern Functions</h4>
        ${renderFnSection(JPATTERN_FUNCTIONS)} 
        <figure>
        <img
          src="https://trussal-docs.quargsgreene.workers.dev/tc_window.png"
          alt="The words 'I' and 'exist' in the chat window appearing in red, green, and blue" />
        <figcaption>An example of a multicolor text pattern output</figcaption>
        </figure>

        <h4>Multimedia Sequencing Patterns</h4>
        ${renderFnSection(MULTIMEDIA_FUNCTIONS)}

        <h4>Text Patterns</h4>
        ${renderFnSection(TEXT_CYCLES_FUNCTIONS)}

        <h4>CSS Patterns</h4>
        ${renderFnSection(CSS_CYCLES_FUNCTIONS)}
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
      <figure>
        <img
          src="https://trussal-docs.quargsgreene.workers.dev/css_pat.png"
          alt="An example of a multidimensional CSS pattern in action" />
        <figcaption>An example of a multidimensional CSS pattern in action</figcaption>
      </figure>

        <h4>Configuration Methods</h4>
        ${renderFnSection(CONFIG_FUNCTIONS)}

        <h4>Live Capture Patterns</h4>
        ${renderFnSection(LIVE_CAPTURE_FUNCTIONS)}

        <h4>Output Routing Patterns</h4>
        ${renderFnSection(OUTPUT_ROUTE_FUNCTIONS)}

        <h4>Jitsi UI Patterns</h4>
        ${renderFnSection(UI_PATTERN_FUNCTIONS)}

        <h4>Data Fetching Patterns</h4>
        ${renderFnSection(FETCH_PATTERNS)}
  `
  
}
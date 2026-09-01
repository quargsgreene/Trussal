# liveCapture() — capturing and replaying room mediums in Strudel patterns

Status: Implemented. Unit-tested for the pure logic (ring buffer, event log,
cursor path, argument parsing, call rewriting). The capture paths themselves
need a live room and, for `gesture`/`cursor`, MediaPipe face control — they have
not been exercised in a live set yet.

```
$: liveCapture('audio', 'MOTU M4').struct("<x ~ x>")                  // a local input
$: liveCapture('audio', 'Ada').struct("x*4").lpf(800).room(1)        // Ada's aggregator output
$: liveCapture('video', 'Ada').struct("x*8")                         // scrub Ada's aggregator video
$: liveCapture('text',  'Ada').struct("x*2")                         // Ada's editor changes → chat
$: liveCapture('css',   'Ada').struct("<x ~>")                       // Ada's CSS changes → this page
$: liveCapture('gesture').struct("x*2")                              // refire my gestures in order
$: liveCapture('cursor').struct("x*8")                               // retrace my head-cursor path
$: liveCapture('audio', '', true).struct("x")                        // + dump my local devices
```

`liveCapture(medium, name, detectLocalDevices)` records a rolling window of one
MEDIUM from one source and returns a Strudel-patternable handle. Every pattern
event replays / refires / retraces the freshest captured slice — the same
"struct gates the live signal" model `live()` had for audio, generalised to six
mediums.

## Arguments

| arg | type | meaning |
|---|---|---|
| `medium` | string | one of `audio`, `video`, `text`, `css`, `gesture`, `cursor` |
| `name` | string | a **participant** (display name — exact then substring — or room-index token), or for `audio` a local **input device** name; ignored for `gesture`/`cursor` |
| `detectLocalDevices` | boolean | dump YOUR devices to the console (see below) |

Any quote style works — see the transpiler note below for why the strings are
rewritten before evaluation. An unknown medium logs a warning and the voice
stays silent.

## Mediums

- **`audio`** — the named participant's aggregator-output audio (their routed
  Jitsi `<audio>`), or a local input device when `name` matches one instead of a
  participant. Empty `name` = the default local input. Capture runs continuously
  into a 10-second mono rolling ring (raw: no echo cancellation / AGC / noise
  suppression), never monitored directly. Each event snapshots the most recent
  ring audio, snapshot length = the event's duration, and it plays through
  superdough's normal chain — `.gain() .lpf() .crush() .room() .speed() .slow()`
  all apply; negative `.speed()` reverses. Capturing **yourself** is refused
  (it is a monitor loop) and falls back to your default input.

- **`video`** — the named participant's published video track, mirrored into a
  rolling frame ring (`240×180`, ~12 fps, ~10 s). Each event advances a
  playback head one frame (direction follows `.speed()` sign) and blits it to a
  canvas exposed at `window._liveCapture.video["<slug>"].canvas` — feed that to
  a Hydra `src()` (`s0.init({ src: window._liveCapture.video["livecap_video_ada"].canvas })`).
  `.live` on the same handle is the continuous, un-scrubbed mirror. Silent in
  the audio mix.

- **`text`** — the named participant's editor-change stream (their pattern text
  on the bus). Each event paints the freshest *added* fragment into a
  bottom-left overlay, honouring any `.color() .size() .typeface()` chained on
  the voice. Silent by construction.

- **`css`** — the named participant's CSS changes (their sidecar-compiled sheet
  on the bus). Each event re-applies the freshest compiled sheet to **this**
  page via a dedicated `<style>` element, removed when the capture is released.
  Silent by construction.

- **`gesture`** — YOUR OWN fired facial gestures only (`smile`, `thumbsUp`,
  `leftBlink`, `browRaise`, `headTiltLeft`, `headTiltRight`), logged in order.
  Each event refires the next gesture in the sequence, wrapping to the start
  once the end is passed, running the exact same action the live latch would.
  Silent by construction.

- **`cursor`** — YOUR OWN head-cursor / pointer path only. Each event steps a
  head along the recorded path (by the event's duration × `.speed()`) and hands
  the point to the face-control loop, so the real head cursor — and every dwell
  target it hovers — follows the retrace. A fallback dot is drawn when face
  control is off. Silent by construction.

### Breaking a gesture / cursor replay

Pressing the **Right Arrow**, or holding your **right eye shut for two
seconds**, breaks every running `gesture`/`cursor` replay. It stays broken
until the program is re-evaluated (which re-runs the `liveCapture()` call and
clears the flag) — editing the code is the way to resume.

## detectLocalDevices

The third argument, when `true`, enumerates your camera and audio I/O devices,
prints them as a table to the console, and re-prints on every `devicechange`.
One cannot enumerate another participant's local system devices, so it is
ignored with a warning when `name` resolves to a remote participant. It is a
single shared watch regardless of how many `liveCapture()` calls request it,
and it stops when the last capture is released.

## The strings must never be mini-parsed

Strudel's transpiler rewrites **every** double-quoted and backtick string into
`mini(...)`. Real device labels routinely break the krill grammar — `"Scarlett
2i2 USB (Focusrite)"` throws on the parentheses — and a mini parse error kills
the **entire combined program** for everyone in the room, not just that voice.

So `rewriteLiveCaptureCalls` (in `live-capture-core.js`) re-emits every string
argument as a **single-quoted** literal before evaluation; single quotes are
the one string form the transpiler leaves alone. A trailing boolean / number /
identifier argument passes through untouched. Only the call arguments are
rewritten — `.struct("<x ~ x>")` and every other string stays mini notation.

## Multi-peer semantics

Strudel evaluates one combined program per browser, so a peer's
`liveCapture()` call is present in everyone's program. Only the **authoring
browser** runs it: `strudel.js` (buildPeerBlock) rewrites remote peers'
`liveCapture(...)` calls to `_liveCaptureSilent(...)`, which keeps the pattern
shape but skips triggers. Without that, one person's `liveCapture('audio',
'Built-in Microphone')` would open the microphone on every machine in the room,
and their `gesture`/`cursor` voice — which has no meaning off their own
machine — would fire nowhere. A browser that cannot resolve the source stays
silent and retries with a 10 s cooldown, so a device plugged in (or a
participant who finally presses Play) self-heals on a later re-evaluate. In
aggregator mode the authoring peer's published Strudel track carries the
captured audio to the room.

**That rewrite is a safety default, not a security boundary.** It is a source
transform matching `liveCapture(`, so an alias (`const f = liveCapture; f(...)`)
slips past it. This is not a new exposure: `buildPeerBlock` already hands every
peer's pattern text to `evaluate()` as arbitrary JavaScript. The room's real
trust boundary is "everyone in the room may run code in your browser".

## Metaprogrammer / JPattern

`liveCapture()` needs no special handling: JPattern stores, queues, rotates,
and slot-gates pattern text opaquely, so a pattern containing `liveCapture()`
flows through the metaprogram scheduler exactly like any other Strudel code.

## Implementation

- `src/live-capture-core.js` — pure logic: `LiveRing` (audio), `EventLog`
  (text/css/gesture), `CursorPath` (cursor), `matchAudioDevice`, `captureSlug`,
  `parseLiveCaptureArgs`, `rewriteLiveCaptureCalls`. Tested in
  `test/live-capture-core.test.js`.
- `src/live-capture.js` — capture management: source resolve (participant
  `<audio>`/`<video>` tag, local `getUserMedia`, the peer-state bus, the
  face-control loop) → per-medium ring/log/path → one superdough sound per
  capture (`livecap_audio_motu_m4`, `livecap_cursor_self`, …) whose trigger
  performs the medium's replay. `audio` returns a real sound; every other
  medium's trigger produces no audio.
- `src/facial-gesture.js` — dispatches `trussal-gesture-fired` on each live
  gesture (the capture source), listens for `trussal-gesture-refire` (the
  replay), and lets `window._lcCursorOverride` drive the head cursor.
- `src/strudel.js` — registers `liveCapture`/`_liveCaptureSilent` into the eval
  scope, rewrites remote peers' calls, stops captures on Strudel stop.

Feedback caveat: sampling a monitor/loopback of the same output Strudel plays
into re-captures the pattern's own playback delayed by the event grid. That is
usable as an effect, but it is the performer's routing decision.

# live() — sampling incoming system audio in Strudel patterns

Status: Implemented. Unit-tested for the pure logic (ring buffer, device
matching, call rewriting); the capture path itself needs a browser with a real
audio input and has not been exercised in a live room yet.

```
$: live("MOTU M4").struct("<x ~ x>")
$: live('Monitor of Built-in Audio Analog Stereo').struct("x*4").lpf(800).room(1)
```

`live(<device name>)` turns any local audio input — a microphone, an audio
interface channel, or a loopback/monitor device carrying system output — into
a Strudel sound source.

## Behavior

- **Capture** starts on first evaluate and runs continuously into a 10-second
  mono rolling ring buffer (raw: no echo cancellation / AGC / noise
  suppression). It is never monitored directly — audio is only heard through
  pattern events.
- **Each event** (e.g. each `x` in `.struct("<x ~ x>")`) snapshots the most
  recent ring audio; the snapshot length equals that event's duration, so the
  struct call determines both when and for how long the live signal sounds.
- **Manipulable like any sample**: the snapshot plays through superdough's
  normal chain, so `.gain() .lpf() .crush() .room() .speed() .slow()` etc.
  all apply. Negative `.speed()` reverses the snapshot.
- **Device naming**: case-insensitive exact label match, then substring match
  (`live("motu")` finds "MOTU M4"), then raw deviceId. `live()` with no name
  uses the default input. Any quote style works — see the transpiler note
  below for why the name is rewritten before evaluation.
- **Release**: an open device never outlives the call that opened it. Each
  evaluate bumps an epoch that every running `live()` re-stamps, so editing a
  `live()` call away (or the peer who wrote it leaving) releases that device on
  the next evaluate. Stop releases everything. The mic indicator tracks this.

## The device name must never be mini-parsed

Strudel's transpiler rewrites **every** double-quoted and backtick string into
`mini(...)`. Real device labels routinely break the krill grammar — `"Scarlett
2i2 USB (Focusrite)"` throws on the parentheses — and a mini parse error kills
the **entire combined program** for everyone in the room, not just that voice.

So `rewriteLiveCalls` (in `live-input-core.js`) re-emits every `live()` name as
a **single-quoted** literal before evaluation; single quotes are the one string
form the transpiler leaves alone (`isStringWithDoubleQuotes` tests `raw[0]`).
Users can therefore type whatever quoting they like. Only the name literal is
rewritten — `.struct("<x ~ x>")` and every other string stays mini notation.

## Multi-peer semantics

Strudel evaluates one combined program per browser, so a peer's `live()` call
is present in everyone's program. Normally only the **authoring browser**
captures and plays it: `strudel.js` (buildPeerBlock) rewrites remote peers'
`live(...)` calls to `_liveSilent(...)`, which keeps the pattern shape but
skips triggers. Without that, one person's `live("Built-in Microphone")` would
open the microphone on every machine in the room. A browser whose inputs don't
match the name is silent too, and retries with a cooldown so plugging the
device in self-heals. In aggregator mode the authoring peer's published
Strudel track carries the live audio to the room.

**That rewrite is a safety default, not a security boundary.** It is a source
transform matching `live(`, so an alias (`const f = live; f('Mic')`) slips
past it. This is not a new exposure: `buildPeerBlock` already hands every
peer's pattern text to `evaluate()` as arbitrary JavaScript, so a peer who
wanted a remote browser's microphone could call `getUserMedia` directly. The
room's real trust boundary is "everyone in the room may run code in your
browser" — worth knowing before treating a public room as untrusted. Note the
sidecar does gate the one path that writes a *human's* pattern from the
network (`remote-control` requires `target.isBot`, `server.js`), so this is
peer-authored code, not operator-injected.

## Metaprogrammer / Net Cycles

`live()` needs no special handling: Net Cycles stores, queues, rotates, and
slot-gates pattern text opaquely, so a pattern containing `live()` flows
through the metaprogram scheduler exactly like any other Strudel code.

## Implementation

- `src/live-input-core.js` — pure ring buffer + device matching + sound-key
  slug + `rewriteLiveCalls` (tested in `test/live-input-core.test.js`).
- `src/live-input.js` — capture management: device resolve → getUserMedia →
  inline AudioWorklet (mono downmix, batched transferable posts) → LiveRing;
  registers one superdough sound per device (`live_motu_m4`) whose trigger
  builds an AudioBufferSourceNode from the ring snapshot.
- `src/strudel.js` — registers `live`/`_liveSilent` into the eval scope,
  rewrites remote peers' calls, stops captures on Strudel stop.

Feedback caveat: sampling a monitor/loopback of the same output Strudel plays
into re-captures the pattern's own playback delayed by the event grid. That
is usable as an effect, but it is the performer's routing decision.

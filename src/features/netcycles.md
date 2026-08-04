# Net Cycles

Status: Implemented. The Fleet Service (`bots/src/orchestrator/fleet-service.js`)
has replaced the conductor as primary orchestrator: fleet membership is
(ownerIndex → cluster), driven by in-room `fleet-request` messages relayed via
the latency sidecar, while the conductor's whole external surface persists
without duplication (`/assignment/:botId` + `POST /metrics` on :7700, the
admin/config API on :7777 consumed by mcp-observer, and the health policy in
`health.js` verbatim). `conductor.js` remains only for the legacy
admin-driven fleet mode and its tests.

Room-side, the Metaprogrammer (`src/audio-net/Metaprogrammer.js`) owns AV
orchestration: the CRDT-shared metaprogram (parsed by
`MetaprogrammerParser.js`) drives a deterministic scheduler
(`MetaprogramScheduler.js`) clocked by O2lite ClockSync against the sidecar's
O2 relay; per-participant AV buffer queues dequeue one buffer per slot
(pattern updates land at the performer's next slot; empty queues play silence
and the cycle always advances); slots gate Strudel voices and per-peer chains;
`#`-chained effects (room/echo/crush/noise/grid) modulate from worst-case
network metrics merged with CRDT-shared artificial inductions. The sidecar
(`latency-instrument/server.js`) assigns the sequential room indices and
cluster suffixes, relays CRDT/permission/fleet traffic, and writes the
research session JSONL (`research/export.js` rolls it into CSV;
mcp-observer's `get_session_log` reads it).

To be updated as this feature's implementation changes.

## Scope

The Net Cycles feature (`net-cycles`) holds primary bot and end user audiovisual signal orchestration responsibilities. In addition to receiving the transfer of all of the conductor's responsibilities without duplication, and replacing the conductor completely, the Net Cycles editor allows each user to edit and update a metaprogramming script shared among all meeting participants that dictates how the audiovisual output of the user and accompanying bots, which consists of the first stored multimedia buffer in each performer's respective multimedia buffer queues, are scheduled and transformed according to Jitsi's RTCStatsReport, which is displayed to the user by the Network Metrics service.

The metaprogramming script executes metapatterns that dictate when each performer's (whether user or bot) individual scripts will execute as determined by the minimum number of beats that exceed a positive real multiple of the worst case latency, where the multiplying factor is chosen by the user, and the execution pattern stipulated by the users.

Users may also chain multiple audiovisual network modulated effects, and update bot orchestration configuration. The existing MediaPipe functionality shall be extended to allow the head cursor and user mapped facial gestures to update and reevaluate the metaprogramming script.

By default, each room entrant is not a bot, but users can each connect and disconnect a cluster of bots on their own behalf to execute scripts and pass along transmitted audio to peers via the Trussal studio UI by specifying a number of bots to join the room, which may be interrupted by preexisting health measures.

## User Story Map

The further down the task is within a given epic's bullet points, the lower the priority. For now, ignore tasks lower than level three within an epic's bullet points.
- Persona:
    - End user:
        - Features:
            - Join room
                - Steps:
                    - Enter lobby
                    - Select meeting room from lobby
                    - Join room from prejoin screen hyperlinked by lobby room selection
            - Modify OS audio input
                - Steps:
                    - Configure local machine audio and video I/O settings and permissions
                    - Allow Jitsi to use user's audio input and video source
            - Update personal Hydra-integrated Strudel script via keyboard input
                - Steps:
                    - Open personal Trussal studio dashboard and focus the Strudel editor
                    - Update code
                    - Load and delete samples
            - Update personal Hydra-integrated Strudel script via MediaPipe landmark and gesture detection integration
                - Steps: 
                    - Enable MediaPipe landmark detection
                    - Focusing, running and deleting code injected by StrudelButton objects and user-defined regular expressions using the head cursor
                    - Stop, start, and apply personal metapatterns using choice of supported facial gestures
            - Update global metaprogramming script via keyboard input
                - Steps:
                    - Focus the global Net Cycles editor in order to update the global metaprogramming script
                    - Using correct Net Cycles syntax, update the metaprogramming script
            - Update global metaprogramming script via MediaPipe landmark and gesture detection
                - Steps:
                    - Focusing, running and deleting code injected by NetCyclesButton objects and user-defined regular expressions using the head cursor integration
            - Adjust room settings
                - Steps:
                    - Adjusting standard Jitsi room settings
            - Toggle video and audio on and off both locally and globally
                - Steps:
                    - Toggle audio and video via standard Jitsi room settings and global personal mix
            - Toggle personal bot cluster video and audio
                - Steps:
                    - Focus a subset of bots in personal cluster fleet
                    - Turn off their display or mute its audio optionally according to certain condition(s)
                    - Mute all bot audio and/or video at once
            - Remove bots
                - Steps:
                    - Focus on a subset of bots in personal cluster fleet
                    - Remove selection optionally according to certain condidion(s) from meeting room
                    - Remove all bots at once
            - Allow or disallow bots in cluser to read or update metaprogramming script
                - Steps:
                    - Focus on a subset of bots in personal cluster fleet
                    - Give edit and/or read permissions to selection optionally according to certain conditions(s)
                    - Allow or disallow edit and/or read permissions for all bots
            - Expose network performance metrics and frequency response over time
                - Steps:
                    - Allow reading from network metrics
            - Write to artificial network modulation
                - Steps:
                    - Raise the artificial latency, jitter, RTT, packet loss percentage induction floors (no control surface at present — the induction sliders were removed; the CRDT 'modulation' channel and the merge into effective worst-case remain)
            - Allow or disallow bots in cluser to write to artificial network modulation
                - Steps:
                    - Focus on a subset of bots in personal cluster fleet
                    - Give artificial network write permissions optionally according to certain conditions(s)
                    - Allow or disallow artificial network write permissions for all bots
            - Leave meeting room
                - Steps:
                    - Leave Jitsi meeting room as a standard Jitsi user would
                    - Upon leaving a room, all remaining bots also leave the room after a maximum time threshold according to currently set global metaprogramming configuration
    - Bot:
        - Features:
            - Join room
                - Steps:
                    - Join as Puppeteer instance 
            - Update personal Hydra-integrated Strudel script via simulated keyboard and originating user input
                - Steps:
                    - Update current code editor with latest MCP-generated buffer updates depending on order in update queue
            - Update global metaprogramming script if allowed by user
                - Steps:
                    - Update current Net Cycles code with latest MCP-generated buffer updates depending on order in update cycle buffer queue
            - Expose network performance metrics and frequency response over time
                - Steps:
                    - Allow reading from network metrics
            - Write to artificial network modulation
                - Steps:
                    - Raise the artificial latency, jitter, RTT, packet loss percentage induction floors according to originating user permissions (no control surface at present — see the same capability above)
            - Leave meeting room
                - Steps:
                    - Destroy all Puppeteer instances after meeting ends according to standard XMPP constraints
                    - Track how long it has been since origin user has left and terminate according to bot persistence settings when meeting is still running

## Proposed File Tree

Below is the directory structure supporting O2lite bridging and Strudel AI control, without eliminating any functionality that already exist. Assume other directories and files still exist, other than the replacement of the conductor, and move latency instrument effects to the Metaprogrammer. Add any needed files to faciliatate the above-described MediaPipe integration.

```text
├── src/
│   ├── audio-net/
│   │   ├── o2lite_driver.js        # Core library handling O2lite serialization
│   │   ├── MetaprogrammerCrdtSync.js # Allow editing by all meeting participants
│   │   ├── Metaprogrammer.js       # Runs the metaprogrammer and creates scheduling rule patterns
│   │   ├── MetaprogrammerParser.js # Parses metaprogrammer syntax
│   │   ├── ValuePattern.js         # Samples patterned effect arguments (<2 3>, [1 4]) at the cycle position
│   │   ├── UserBotOrchestration.js # Allows users to eliminate, filter, and select bots in their own cluster
│   │   ├── ClockSync.js            # Critical for O2: syncs local audio time with network time
│   │   ├── observability/
│   │   │   └── NetStats.js         # Store network metrics
│   │   ├── network-modulation/
│   │       ├── IncreaseJitter.js   # Increase above minimum Worst-Case Jitter (WCJ)
│   │       ├── IncreaseLatency.js  # Increase above minimum Worst-Case Latency (WCL)
│   │       ├── IncreaseRTT.js      # Increase above minimunm Worst-Case RTT (WCRTT)
│   │       ├── IncreasePacketLoss.js # Increase above minimum Wost-Case Packet Loss (WCPL)
│   │       └── WorstCaseCalculationUtils.js # Calculate and set all Worst-Case Network Metrics
│   │   │            
│   │   └── av-effects/
│   │       ├── Room.js
│   │       ├── Crush.js
│   │       ├── Noise.js
│   │       ├── Grid.js
│   │       └── Echo.js
│   ├── bridges/
│   │   └── XMPPtoO2Mapper.js       # Maps XMPP JIDs to O2 Service Names
│   └── mcp-agent/
│       ├── tools/
│       │   ├── instrument_defs.json # Defines valid Strudel instruments for the AI
│       │   └── theory_utils.js      # Helpers for the AI (scales, chord progressions)
│       └── server.js                # The MCP server exposing Strudel control to Claude
├── public/
│   └── lib/
│       └── o2lite-web.js           # The browser-compatible O2lite client
├── components/
│   ├──MetaprogrammerEditor.jsx
│   ├──MetaprogrammerCycleHighlighter.jsx # Highlights which user's buffer is currently playing
│   └──BotClusterVideo.jsx         # Make the video cluster of bots attached to each user smaller and surround user
└── server/
    └── O2Relay.js                  # WebSocket relay for O2lite clients
```

### Key Differences in this Spec
*   **`ClockSync.js` is mandatory:** unlike XMPP chat which is asynchronous, O2lite requires tight time synchronization to ensure music plays in time across the network. Your spec must account for this file/module.
*   **`instrument_defs.json`:** The AI (Claude) doesn't inherently know which synths your Strudel instance has loaded. You need a definition file to strictly type the inputs (e.g., allowing "piano", "sawtooth" but rejecting "random_noise"). Have instrument_defs.json default to currently available instrument definitions if none are provided by the user.

### AV Buffer Object
AV is an object with audio and video samples, as well as the corresponding o2lite messages and XMPP stanzas requisite to transmit and receive each participant's code and performance status.

## Mix Output
By highlighting different participants within Trussal Studio, one can hear the entire master bus, one's own ipsilateral mix, or any contralateral mix of one's choosing.

## Room Health
All prior conductor health functionality persists (i.e. removing bots to avoid server overload) with the added functionality that it also by default adjusts the decoupling of timing between audio and visual buffers for each user (with a default of one cycle length) according to network conditions, prevents deadlock, and further compresses any output signal according to current server load globally, and locally according to a client's CPU, RAM, and GPU usage, possibly also scaling down MediaPipe landmark density.

## Data Flow
+-------------------------------------------------------------------+
       |                                                                   |
       |                        [video? audio?]                            |
       |                                                                   |
       v                                                                   |
 +---------------------------------------+                                 |
 |        Network Metrics Service        |                                 |
 |---------------------------------------|                                 |
 | src/audio-net/observability/          |                                 |
 | └── NetStats.js                       |                                 |
 +---------------------------------------+                                 |
       |                                                                   |
       | [RTCStatsReport]                                                  |
       v                                                                   |
 +---------------------------------------+                                 |
 |       Network Modulator Service       |                                 |
 |---------------------------------------|                                 |
 | src/audio-net/network-modulation/     |                                 |
 | ├── IncreaseJitter.js                 |                                 |
 | ├── IncreaseLatency.js                |                                 |
 | ├── IncreaseRTT.js                    |                                 |
 | ├── IncreasePacketLoss.js             |                                 |
 | └── WorstCaseCalculationUtils.js      |                                 |
 +---------------------------------------+                                 |
       |                                 \                                 |
       | [Effects Parameters]             \ [Conductor parameters]         |
       v                                   v                               |
 +---------------------------------------+ +-----------------------------+ |
 |            Effects Service            | |        Fleet Service        | |
 |---------------------------------------| |-----------------------------| |
 | src/audio-net/av-effects/             | | src/audio-net/              | |
 | ├── Room.js                           |<------[AV]-- UserBotOrchestr..| |
 | ├── Crush.js                          | | src/mcp-agent/              | |
 | ├── Noise.js                          | | ├── server.js               | |
 | ├── Grid .js                          | | └── tools/* | |
 | └── Echo.js                           | | components/                 | |
 +---------------------------------------+ | └── BotClusterVideo.jsx     | |
       |                 ^                 +-----------------------------+ |
       |                 |                               ^                 |
       | [processed AV]  | [AV]                          | [AV]            |
       v                 |                               |                 |
 +-----------------------+                               |                 |
 |      Jitsi Server     |                               |                 |
 |-----------------------|                               |                 |
 | bridges/              |                               |                 |
 | └── XMPPtoO2Mapper.js |                               |                 |
 +-----------------------+                               |                 |
       |                 |                               |                 |
       |                 +-------------------------------+                 |
       |                                 |                                 |
       v                                 |                                 |
 +-----------------------------------------------------------------------+ |
 |                              Performers                               | |
 |-----------------------------------------------------------------------| |
 | src/audio-net/                                                        | |
 | ├── Metaprogrammer.js                                                 | |
 | ├── MetaprogrammerCrdtSync.js                                         | |
 | ├── MetaprogrammerParser.js                                           | |
 | ├── ClockSync.js                                                      | |
 | └── o2lite_driver.js                                                  | |
 | components/                                                           | |
 | ├── MetaprogrammerEditor.jsx                                          | |
 | └── MetaprogrammerCycleHighlighter.jsx                                | |
 | public/lib/                                                           | |
 | └── o2lite-web.js                                                     | |
 +-----------------------------------------------------------------------+ |
       |                                                                   |
       +-------------------------------------------------------------------+

## Metaprogramming Syntax
The NetCycles metaprogramming language foundationally uses the Mondo pattern language syntax (https://strudel.cc/learn/mondo-notation/).

## Metaprogramming Semantics
Each Jitsi room participant is assigned a sequential identifying index upon first joining the room that is immutable for the duration of the meeting. 

Examples:

- Good:
    First person to join -> 0
    Second person to join -> 1
- Bad:
    First person to join -> 10432
    Second person to join -> 09454

### Bot Cluster Room Indices
Each bot in a given participant's bot cluster is assigned the particpants index concatenated with a sequence of ordered letters to indicate to indicate its uniqueness in the cluster. The length of the letter sequence increases only when all 26 English letters have been exhausted for a given position in a sequence. Then, one more letter is appended to the sequence starting with 'a'.

Examples:

- Good:
    First person's first bot -> 0a
    Second person's 28th bot -> 0zb
- Bad:
    First person's first bot -> 0z
    Second person's 28th bot -> 0zz
 QuantizeAudio
- Also bad bot index names:
    0bcd
    9fae

### Scheduling
A minimal valid NetCycles program consists of a scheduling sequence of the audiovisual buffers of all room participants' outputs. As soon as a meeting starts, this is auto-populated and a new AudioContext is instantiated. Each entering participant is automatically added to the end of the sequence array, and each leaving participant is removed from it. Multiple bots may be appended at once. Each user, including bots may rearrange the buffer sequence.

The length of each cycle is defined according to a multiple of the worst-case latency, worst-case jitter, or length computed by the worst-case percentage of packet loss.

Each rig measures its own audio pipeline by loopback — a local RTCPeerConnection pair carrying an impulse through a real Opus encoder and decoder, plus the platform's reported device buffers — and publishes the result, so the bound reflects the actual hardware in the room rather than one constant standing in for every machine. A rig that has not measured itself yet contributes a mid-range fallback and so can never pull the bound below what is already known.

That cycle length is also the length of each performer's TURN: the aggregator paces its rotation off the scheduler's `slot-open`/`slot-close` grid, so a degrading room stretches every solo and a recovering one tightens them. The join-order write pointer's fixed `slotMs` remains only as the fallback before the first slot arrives, and in standalone runs with no metaprogram sync.

WCJ is the worst-case **audio** RTP inter-arrival jitter across the room, read from RTCStats on the media path — the same path WCL's own terms come from. (It falls back to the WebSocket ping/pong RTT stdev, a different and much noisier leg, only for a peer that has not produced an RTCStats sample yet.) Video streams are excluded, so WCJ does not move when a camera is switched on. On a LAN this puts WCJ in the low single-digit milliseconds, an order of magnitude below the WS figure that preceded it — scale factors calibrated against the old value, including Echo's `n_samples_factor`, produce correspondingly shorter results.

The general syntax is `# cycles <metric> [scale factor] [amount]`. With only a scale factor, the cycle target is the dynamically evolving worst-case measurement times the scale — `# cycles wcl 1000` is the live WCL (in seconds) × 1000. An additional amount FIXES the metric at that value regardless of current network conditions: `# cycles wcl 10 0.3` sets WCL to 300 ms and multiplies by 10 for a cycle length of 3 s. The amount is in seconds for `wcl`/`wcj` and a loss fraction in [0, 1] for `wcpl`. A fixed amount pins timing only — effects and readouts keep following the real network. The scale factor defaults to 1 when omitted.

Examples:

```
$ participants <0 1 3 5 2a 1zzzv 9 1>*2
# cycles wcl 3 // This is a comment. 

```
```
$ participants <0 1 2 3>
# cycles wcl 20 // Default if not specified. wcl is worst-case MOUTH-TO-EAR latency: an UPPER BOUND over the room, built from the two worst network legs, the worst measured de-jitter buffer, and the worst rig's own measured capture/codec/playout latency. It sits in the tens-to-low-hundreds of ms, so a scale of 20 gives seconds-long solos.
# tempo 120 bpm // Tempo takes two arguments, quantity and unit, either bpm, cps, or cpm. No tempo directive is injected when none is written, but cycle quantization still falls back to 120 bpm — and the room's default program deliberately carries no `# tempo` line. A minimum waiting period based on specified cycle timing mode is prioritized over hitting buffer scheduling deadlines according to the specified tempo.

 // This is the default metaprogram for a meeting with four human participants. We first hear and see participant 0's output then participant 1's, and so on, with the smallest number of beats covering (≥) the cycle target. This is the order in which inputs are established via the Web Audio API.
```

```
$ participants < 0 1 2 3 1a 1b 1c 1d 2a 2b 2c 0a>
# cycles wcl 20
# tempo 120 bpm

// This is how the program would look immediately after participant 1 adds a cluster of four bots, participant 2 later adds a cluster of 3 bots, and participant 0 then adds one bot. The `# tempo` line here is written explicitly — the room's default program carries none, and quantization falls back to 120 bpm.
```

```
$ participants <0 1 2>
# cycles wcl 10 0.3

// WCL pinned at 300 ms and scaled by 10: every cycle is exactly 3 s no matter how the network behaves.
```

Overarching cyclic timing modes cannot be chained together.
Below is an example of an invalid program.

```
$ participants [0 2 ~ 3 1]
# cycles wcl
# cycles wcj
```

The infix operators @, !, ?, .., |, %, /, *, and : each apply as usual. What they apply to here is a TURN — the stretch of the room's output that belongs to one participant — so read them that way:

| | Effect on the sequence |
|---|---|
| `0@n` | Gives 0 n times the room of a plain element. In a `[…]` subdivision that is a share of one cycle (`[0@2 1]` — 0 takes two thirds of it); in a `<…>` alternation, where a cycle already IS the turn, it is a number of cycles (`<0@2 1>` — 0 holds the ring for two whole cycles, unbroken across the boundary). |
| `0!n` | 0 takes n turns in a row. Bare `!` means once more, i.e. `!2`. The count must be glued to the operator: `<0! 2>` is a doubled 0 followed by participant 2, not `<0!2>`. |
| `0?` / `0?p` | 0's turn is dropped with probability 0.5 (or p) — the cycle still advances, the room just hears nothing. The draw is seeded per OCCURRENCE, not per cycle, so a turn stretched over several cycles by `@` or `/` is dropped or kept as a whole rather than flickering at each boundary. |
| `<…>*n` `/n` `%n` | The rate the room reads the sequence at. `*n` fits n turns where one used to go, so every turn is 1/n as long; `/n` is the inverse, stretching each turn over n cycles; `%n` states the steps per cycle outright. They compose, so `*4/2` is ×2. |
| `0*n` / `0/n` | The same on one token: `0*2` splits 0's own slot into two turns, `0/2` holds a single turn across it. |

Every one of these is written **glued** to what it modifies, with no space anywhere in the run — `4@3`, `10!2`, `[0 1]*2`. A gap is a syntax error, not a loose spelling of the same thing: whitespace is what separates one turn from the next, so `<0 @3>` looks like two elements and is far likelier a slipped `<0@3>` (or a `3` that lost its token) than a deliberate weighting of `0`. The same holds on the right of the operator, where `<0@ 3>` is an error for the same reason. `..` is the exception — it joins two elements into a range rather than modifying one, so `<0 .. 3>` and `<0..3>` are both fine.

For example, `$ participants <0@2 1!3 0a?>*2` gives participant 0 twice the turn of anyone else, sends participant 1 three times in a row, and drops 0a's audio half the time. `<0@2 1!3 0a?>/2` is the same rotation played four times as slowly as that and twice as slowly as an unmodified `<0@2 1!3 0a?>`.

A turn widened past one cycle is CLIPPED to each cycle it covers rather than gated on its onset the way Strudel's `slow` is, which is what keeps a stretched solo continuous instead of sounding only on the cycle it began in. Rates are clamped to between 1/1024 and 1024 units per cycle: past that a program that parses perfectly well would schedule turns too short to emit, or a window too narrow to contain one, and the room would fall silent with nothing to diagnose. Clamped, the extremes still say what they mean — turns a millisecond long, or one turn held for a thousand cycles.

The , (stack) operator, as well as the semantics of the `jux` and `superimpose` functions result in the stacked elements receiving an offset of one cycle according to the current cyclic timing mode

The `ply`,`chop`, and `shuffle`, `degrade`, `hush`, `undegrade`, `undegradeBy`, and `degradeBy` functions function as in Strudel in that they split and/or omit each buffer into the specified subdivision and/or probability.

Otherwise, Strudel functions cannot be executed in the NetCycles editor. No Hydra functions can be executed within the NetCycles metaprogramming editor.

### AV Buffer Object Sequencing
Each individual participant automatically enqueues AV buffer objects at intervals specified by the cyclic timing mode, which may or may not be empty, and which varies in size both according to this setting, and health monitor memory constraints. When a participant updates code in their own Trussal Studio Strudel-Hydra editor, if it is valid, it is additionally enqueued at the next scheduled interval. When the metapattern reaches a particular participant's buffer queue, a single buffer is dequeued and streamed.

### Valid Chainable Functions
There exist audiovisual analogs to Strudel functions whose parameters are automatically modulated according to network conditions in addition to user input, which do not align with Strudel's preexisting semantic framework when executed within the NetCycles editor.

These include the functions `room`, `crush`, `echo`, and `noise`. More analogs will exist in later versions.

Effect parameters are plain positive numbers, except where the effect says otherwise: `crush`, `echo` and `noise` each accept mini-notation patterns in their argument slots, sampled from the room's cycle position. `crush` and `echo` run in each browser and are re-read on a 50 ms tick, so both `<…>` alternation and `[…]` subdivision apply; `noise` runs on the aggregator's master bus and is re-derived once per cycle boundary, so it takes `<…>` only and a `[…]` is a parse error.

Examples:

- Good:
```
$ participants [0 1 _ 4? 10 2a - 2za ~]
# cycles wcj 3
# tempo 90/4 cpm
# room wcl 2.5
# noise
```

- Bad:
```
$ participants [0 1 _@2 4@3 10!2 2a? 2 - 4zza] // the number to the right is exactly as mondo notation repeats or lengthens an element in the sequence.
# cycles wcj 3
# tempo 90/4 cpm
# room wcl (pink # range 0 1)
```

### Supported Audiovisual Functions
Upon addition of a supported function via valid syntax in the NetCycles editor, it is added as a node within the preexisting Web Audio API graph after all other effects, as well as a corresponding visual effects chain that modifies the output of the Hydra WebGL shaders.

#### room
- Description
The room function is a Schroeder reverb whose decay time (RT60) is a multiple of wcl, with a lowpass filter with a dynamic cutoff frequency cascaded at the end of the filter chain according to wcrtt.

Like `noise`, and unlike the rest of the chainable functions, room runs on the **aggregator's master bus** — the single assembled mix the aggregator streams back to the room — rather than in each participant's browser. Everyone therefore hears one reverb on the shared mix, not one per client stacked on top of it. The Hydra lowpass counterpart is still computed locally in every browser and published to `window._ncVisual.lowpass`, though nothing reads that channel yet (see the note under `noise`). Where both are written the master path is `room` then `noise` regardless of the order in the program, because the bed is additive and belongs on the mix rather than in the reverb's tail.
- Syntax
`# room wcl [scale factor] [amount for wcl]`

The `wcl` metric keyword is required; the bare-number form (`# room 2 3`) is not valid.
- Input
AV buffer object
- Parameters
scale factor: A positive real number multiplying wcl to give the reverb decay time: decay = scale_factor * wcl, in seconds. Defaults to 1. Each comb line's feedback gain is then solved for that RT60 (g = 0.001^(delay/decay)), clamped below unity so the tail always dies away.
amount for wcl: A positive real number of seconds that *pins* wcl instead of reading it live, so `# room wcl 2 0.4` is a fixed 800 ms decay regardless of network conditions. Defaults to unset (live metrics).

Note that wcl models mouth-to-ear latency (tens of ms), not the bare network leg, so a modest scale factor already yields an audible tail — `# room wcl 10` is a ~1 s decay at 100 ms wcl. Scale or pin the amount as needed, the same way `# cycles` carries its scale openly rather than through a hidden multiplier.

The cascaded cutoff is `wcrtt * 100 Hz` (wcrtt in ms), clamped to [40, 18000]. It also applies a lowpass filter to the Hydra signal.
- Return value
Updated AV buffer object
- Examples:
```
$ participants [0 2 1 4 3]
# room wcl 2
```
```
$ participants [0 2 1 4 3]
# room wcl 2 0.4
```

#### echo
- Description
A feedback delay whose three parameters — echo length, feedback and gain — are each driven by a network metric of the user's choosing, one metric per parameter.
- Syntax
`# echo <metric> <length> <metric> <feedback> <metric> <gain> [<bound 1> [<bound 2> [<bound 3>]]]`

Six arguments (three metric/scale pairs), or none at all; a half-written chain is a parse error rather than a partial default. The three upper bounds are individually optional and fill their slots left to right. Legal metrics are `wcl`, `wcj`, `wcrtt` and `wcpl` — wcrtt is admitted here even though `# cycles` has no use for it, since an echo tracking the round trip rather than mouth-to-ear latency is a different musical choice.
- Input
AV buffer object
- Parameters
Every parameter is its scale factor times its metric **normalized against an upper bound**, clamped so a network that keeps degrading cannot push it further:

    value = scale × min(metric / bound, 1)

The scale is therefore the value that parameter reaches when its metric sits at the bound, and nothing runs away when the network does.

length: the delay time in **cycles**, not seconds. The echo rides the room's cycle grid, so it re-times itself whenever the metrics move the cycle length and stays in rhythm with the rotation. Rational lengths may be written as fractions — `# echo wcl 1/2 …`, the same spelling `# tempo 90/4` uses — or as decimals. Default scale 0.5.
feedback: the recirculated proportion, clamped strictly below unity (0.95) — the one place a user's scale factor is overruled, because a self-oscillating delay line never gets quiet again. It also modulates the brightness of the synthesized video output: `brightness = 1 − feedback`, so an echo doing nothing audible leaves the image untouched and thicker repeats darken it. Default scale 0.5.
gain: the level of the wet (echoed) path against the dry signal. Default scale 1.

upper bound for each: a positive real in the unit its metric is *written* in — milliseconds for wcl/wcj/wcrtt, **percent for wcpl** (`20` means 20 % loss, while the metric itself is broadcast as the fraction 0.2). Omitted bounds default per metric: wcl 500 ms, wcj 50 ms, wcrtt 500 ms, wcpl 20 %. These sit near the worst a real algorave room reaches rather than at each metric's theoretical ceiling, so the effect audibly moves without anyone having to induce degradation first.

A bare `# echo` is `wcl` driving all three at scales 0.5 / 0.5 / 1 — still normalized against wcl's default bound, so even the default echo follows the network rather than sitting at fixed values. A new meeting starts with no `# echo` line at all, i.e. bypassed.

Scales and bounds may both be **patterns** instead of plain numbers: `<2 3 0.5>` alternates one value per cycle and `[1 4]` subdivides the cycle, nesting the way a `$ participants` sequence does. They are sampled from the cycle position, which every client derives from the same shared epoch, program and metrics — so a patterned parameter stays identical across browsers.
- Return value
Updated AV buffer object
- Examples:
```
$ participants [0 2 1 4 3]
# echo wcl 2 wcpl 0.3 wcl 3 1500 20 1200 // packet loss is a percentage
# ply 2
```
A 2-cycle echo at 1500 ms of worst-case latency, 0.3 feedback at 20 % worst-case loss, and gain 3 at 1200 ms — all three shrinking together as the room gets healthier.
```
$ participants [0 2 1 4 3]
# echo wcl <2 3 0.5> wcpl 0.3 wcl [1 4] 1500 20 1200
```
The same echo with its length alternating per cycle and its gain jumping mid-cycle.

#### crush
- Description
This effect reduces the bit-depth and sample rate for both the incoming audio and video buffer according to a worst-case network metric. 8 bits is the resting depth and the metric eats into it: the depth halves each time the metric climbs by one halving amount, arriving at a 1-bit square wave on a bad enough network. It is bypassed until a performer writes it into the metaprogram — there is no crush on the bus otherwise.
- Syntax
`# crush <metric> [scale factor] [amount for metric]`

The metric keyword is required; the bare-number form (`# crush 2`) is not valid. Unlike `# room` and `# cycles`, any worst-case metric may drive it — `wcl`, `wcj`, `wcpl`, or `wcrtt`.
- Input
AV buffer object
- Parameters
scale factor: A positive real number multiplying the 8-bit resting depth: bit_depth = clamp(8 * scale_factor / 2^(metric / halving_amount), 1, 16). Defaults to 1. Raising it crushes **less** (a 2 gives a 16-bit base); a value below 1 crushes harder.
amount for metric: A positive real number that *pins* the metric instead of reading it live, in that metric's own unit — seconds for wcl/wcj/wcrtt (`# crush wcl 2 0.4` is a fixed 400 ms whatever the network does), a loss fraction for wcpl, clamped to [0, 1].

The halving amounts are per metric, because the metrics are not on one scale: 100 ms of wcl, 20 ms of wcj, 100 ms of wcrtt, or 0.25 of wcpl each halve the depth. The wcpl figure preserves the "a factor of 2 per 25 % packet loss" this effect was first specified with.

**The resting depth is a ceiling, not a typical reading.** wcl is mouth-to-ear — both network legs plus the de-jitter buffer plus each rig's own capture/encode/playout pipeline (40 ms assumed until a rig measures itself) — so a healthy LAN room already sits around 90-150 ms. `# crush wcl 1` therefore rests near 4 bits rather than 8, and `# crush wcl 2` is the line that puts a typical room near 8. wcrtt runs the other way: single-digit on a LAN, so it barely crushes until a room is spread over a WAN.

Sample rate follows the metric alone, not the scale factor: sr_divisor = clamp(round(2^(metric / halving_amount)), 1, 64), a sample-and-hold period that is also the pixel-block edge for the Hydra counterpart. A clean room therefore decimates nothing whatever base depth the performer asked for.
- Parameters as patterns
Each of the three may be written as a mini-notation sequence instead of a constant, read once per Net Cycles cycle off the same grid the slots run on: `<a b>` alternates one element per cycle, `[a b]` subdivides the cycle, and the two nest. This applies to the metric keyword as well as the numbers. The value is a pure function of the shared epoch, program, and metrics, so every client reads the same one at the same instant.
- Return value
Updated AV buffer object
- Examples:
```
$ participants [0 2 1 4 3]
# crush wcl 2
# chop 2
```
```
$ participants [0 2 1 4 3]
# crush wcpl 1 0.25       // pinned at 25 % loss: a steady 4 bits
```
```
$ participants [0 2 1 4 3]
# crush <wcl wcj> <2 4>   // metric and base depth both turn over per cycle
```

#### noise
- Description
Lays a noise bed over the mix whose **spectrum** and **output volume** are each modulated by a worst-case metric of the user's choosing. The spectrum sweeps continuously from brown through pink to white, so worsening conditions open the bed's top end; the volume rises from the base level toward the clamp. Like `room` (and unlike the rest), the audio node runs on the **aggregator's master bus**, so the room hears one bed on the shared mix rather than one uncorrelated bed per browser; the Hydra grain counterpart still applies locally in every browser.

A meeting opens **bypassed**: the default program carries no `# noise` line, so no node exists at all — not a silent one.
- Syntax
`# noise [<metric>] [spectrum factor] [<metric>] [volume factor] [amount for metric 1] [amount for metric 2]`

Both metric keywords are optional and default to `wcl`; either may be `wcl`, `wcj`, `wcrtt` or `wcpl`. A keyword binds to the factor that *follows* it, so `# noise wcl 20 wcrtt 10` reads "spectrum from wcl × 20, volume from wcrtt × 10". The numbers are positional: spectrum factor, volume factor, then the two pinned amounts in the same order the metrics were written.
- Input
AV buffer object
- Parameters
spectrum factor: A positive real number multiplying its metric to give the bed's position on the colour axis, clamped to [0, 1]: 0 is brown, 0.5 pink, 1 white, with an equal-power crossfade between the two adjacent colours (the generators are normalized to a common level, so a sweep changes colour without changing level). Metrics are read in seconds for `wcl`/`wcj`/`wcrtt` and as a loss fraction for `wcpl`, so at 100 ms wcl a factor of 5 lands exactly on pink and a factor of 10 or more saturates at white. Defaults to 0 — an unmodulated bed sits at brown.
volume factor: A positive real number multiplying its metric the same way, mapping [0, 1] onto 25 dB … 75 dB. The bed's gain is `0.12 × 10^((dB − 25) / 20)`, so 25 dB is the level the effect has always run at and each further 6 dB doubles it. **Clamped at 75 dB** — 50 dB above the base, i.e. 316× the base gain, an absolute linear gain of ~38. The clamp bounds the modulation; it does not promise the bed stays inside the mix's headroom. 0 dBFS arrives at about 43 dB, and there is no limiter between the bed and the published track, so the upper part of the range clips the master by design. Defaults to 0, leaving the bed at 25 dB.
amount for metric 1 / metric 2: Positive real numbers that *pin* the corresponding metric instead of reading it live — seconds for `wcl`/`wcj`/`wcrtt`, a loss fraction for `wcpl` — exactly as `# room wcl 2 0.4` pins room's. Being positional, pinning the first metric means writing a volume factor first. Default unset (live metrics).

A factor defaults to 1 rather than 0 when its metric keyword was written, so `# noise wcj` is "spectrum from live wcj at scale 1", the same shape as `# room wcl`.

Every slot also accepts a `<…>` pattern, sampled **one element per cycle** — the aggregator re-derives the bed at each cycle boundary. `[…]` subdivides within a cycle, which a per-cycle argument cannot express, and is a parse error; so is mixing metric keywords and numbers in one pattern. Nested groups advance once per visit of their parent, as in mondo.

The Hydra counterpart is image grain: the colour sets its character (0.15 brown … 0.6 white) and the level scales it, so a quiet brown bed barely marks the image and a loud white one buries it. Note that this value is *published* — every browser computes it into `window._ncVisual.noise` — but nothing renders it yet: the only channel of that object the visual layer reads today is `brightness`. The grain (like room's blur) is wired up to the point of publication and no further.
- Return value
Updated AV buffer object
- Examples:
```
$ participants [0 2 1 4 3]
# noise
```
```
$ participants [0 2 1 4 3]
# noise wcl 20 wcrtt 10
```
```
$ participants [0 2 1 4 3]
# noise wcl 20 wcrtt 10 0.4 0.06
```
```
$ participants [0 2 1 4 3]
# noise <wcl wcpl> <20 5> wcrtt 10
```

### grid
- Description
Approximates physical distances between room participants based on network metrics and marks each participant's video panel with a small grayscale circle in the top lefthand corner, with the longest distances receiving a black circle. Output changes from each room participant's perspective and each participant's own video panel has a white circle from the participant's own broswer perspective. landmarks is set to false by default, which displays a vector the same color as the circle in the direction of greatest change by the average of the landmark displacements within each user's video buffer in the bottom right corner of each user's video panel. When a participant is a bot or not using MediaPipe functionality, this vector is not displayed in the respective video panel.
- Parameters
landmarks
- Return value
A matrix of distances
- Example:
```
$ participants <0 9 1 4 2>*2
# grid true
```

## Artificial Network Modulation
In addition to upward adjustments from o2lite-estimated wcl, wcj, wcpl, and wcrtt, room participants may place other participants in their own additional VLANs with their own local network conditions via the Trussal Studio UI, the output of which are mixed down into a single master bus. By default, all participants share a mutual VLAN. This portion of the Trussal Studio UI, like the NetCycles metaprogramming editor, is governed by CRDT.
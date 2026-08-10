# botConfig — declaring what your bot cluster plays

`botConfig({...})` in a performer's editor decides what their spawned bots play
and how. It is a declaration, not a pattern: it is stripped before Strudel
evaluates the block, so it makes no sound and occupies no voice.

```js
botConfig({ harmony: "diatonic", colorScheme: "triadic" })

await initHydra()
osc(10, 0.1).out(o0)

n("0 2 4").scale("C:minor").s("sawtooth")
```

Spawning with the above gives every bot in the cluster that Hydra and that
pattern, each transposed a further scale degree up and rotated a third of the
way around the hue circle.

## Defaults

`botConfig()` with no argument, or no declaration at all, means **each bot plays
exactly what is in your editor when you spawn it**. Every property left out is
`null`, which always means "no effect".

Your editor, not your last evaluation: the declaration is stripped before
Strudel runs and makes no sound, so nothing would prompt you to re-run your
block after typing one — and a spawn that read the last-evaluated pattern
instead sent code with no declaration in it, quietly spawning plain copies.
Spawn reads the box.

## Properties

| Property | Type | Values |
|---|---|---|
| `random` | string | `"params"` jitters every numeric parameter of your code (±50%); `"full"` replaces it with a fresh patch from the built-in palette |
| `paramFactor` | number | Scales every numeric parameter of your code by this factor |
| `harmony` | string | `"diatonic"`, `"random"`, or a signed semitone count like `"+2"` / `"-13"` |
| `mcp` | string | A prompt. The cluster's code is composed by a model instead of copied from you |
| `colorScheme` | string | `complementary`, `monochromatic`, `analogous`, `triadic`, `tetradic`, `split-complementary`, `square`, `random` |
| `textParrot` | boolean | `true` keeps your Text Cycles statements, so the bots repeat your words |
| `cssParrot` | boolean | `true` keeps your CSS Cycles statements, so the bots repeat your styling |
| `retroactive` | boolean | `true` applies later edits to bots already running, at each one's next turn |
| `samples` | boolean | `true` shares your uploaded sample folders with your bots |

A value outside these sets is rejected and reported back to your studio as a
`fleet-status` reason. The cluster still spawns, playing exact copies — a typo
costs you the config, not the bots.

Every spawn says what the fleet took, on the same status line as the spawn
itself: `spawned 2/2 for 1 — botConfig applied: harmony=diatonic`, or
`— no botConfig() declared`, or the rejection. It rides on that one line
deliberately: your studio shows the last `fleet-status` it saw, so a reason sent
as a message of its own was buried by the spawn's own status a moment later —
which is what made a config that never arrived look identical to one that did.

## How each property behaves

**Numeric shaping.** `paramFactor` and `random: "params"` rewrite numeric
*literals*, including bare values inside a quoted mini-notation string —
`n("0 2 4")`'s scale degrees and `.cutoff("800 1200")`'s pattern values move
exactly like `.cutoff(800)` does, staying inside their original quotes. What
stays put is pattern *structure*: `s("bd*2 sd:3").cutoff(800)` keeps its `*2`
(repeat count) and `:3` (sample-bank index) — along with `!` (replicate), `@`
(weight), `%` (polymeter steps), `/` (slow) and `?` (degrade probability) —
while the cutoff moves; and `note("c3 e3")`/`src(s0).out(o1)` keep their note
names and channel identifiers, quoted or not. When both are set the factor
applies first, and the jitter is measured around the scaled value.

**Harmony** is measured along your cluster: bot 0 stays at pitch and each
subsequent bot moves one step further, so a cluster of four spells a four-note
voicing rather than four copies of the same transposition. `"diatonic"` is truly
diatonic when your code is degree-based (`n(...)` feeding a `.scale(...)`) —
Strudel resolves the degree through your own scale. Otherwise the degrees are
converted to semitones in the scale you declared (C major if you declared none),
which keeps a cluster spelling the right chord but moves individual notes by a
fixed interval rather than a scale-following one.

**colorScheme** chains a colour transform onto the master's own Hydra pipeline,
before its `.out(o0)`, so it stacks with the fleet's own band and tile roles
instead of replacing them (a second `.out(o0)` statement would rebind the
buffer, not tint it). Cluster member 0 always keeps your hue and the scheme
opens up from there — reached by omitting the `.hue()` call rather than
writing `.hue(0)`, since a zero rotation is a Hydra no-op and would be dead
syntax. The same omission applies wherever else a hue is computed (the
`frequencyBands` role's band→hue mirror, `colorScheme: "random"` landing on
0 by chance): a hue is never emitted as literally `.hue(0)`.
`monochromatic` separates members by brightness, since rotating hue by zero
would make them identical.

**textParrot** and **cssParrot** are off by default, which means bot scripts
have their `word()`/`css()` statements stripped from what each bot ANNOUNCES —
without that, every bot in a cluster repeats its author's words or restyling
in every viewer's chat panel/page. Setting either to `true` keeps that voice in
what a bot announces, which every OTHER performer's own browser then paints —
text and CSS are per-page and never ride an audio track, so this is true
regardless of parroting: what changes is only whether OTHER viewers ever see
it. Note that a bot's own REPL never runs `word()`/`css()` either way — a
separate, minimal Strudel instance boots each bot's audio and has neither
capability installed, so both are always stripped from what it actually
evaluates, parrot or not.

**samples** ships your uploaded folders to the fleet, which serves them to your
bots over its own HTTP surface. The bots register them under the same folder
names you use, so `s("mykit")` means the same thing in both editors. Limits are
1MB per file and 16MB per performer; anything refused is reported to your studio
by name.

**retroactive** is the only thing that makes an edit reach a bot that is already
running, and it lands at that bot's **next turn**, never mid-phrase. The config
that governs is the one you just typed — turning `retroactive` on is itself an
edit that takes effect. With it off (the default), a bot plays what you were
playing when it spawned, for as long as it lives.

**mcp** hands the prompt to a model along with your current code as context, and
uses the answer as the cluster's master — every other property still shapes it
from there. Composition happens once, at spawn, before any container starts, so
it is never on the path of a turn boundary.

## Where the code runs

Three processes have to agree about a performer's editor text, and each reads it
with the same shared modules rather than its own copy of the rule:

- the **browser** strips the declaration (`src/bot-config.js`, via
  `normalizePeerCode`) so it never reaches Strudel's transpiler — its argument is
  free text, and every double-quoted string in Strudel is mini-parsed;
- the **fleet** parses it and builds each bot's script
  (`bots/src/script-gen/cluster-source.js`);
- the **bot page** uses the same Hydra and Text Cycles rules to decide whether an
  edit pushed into its editor replaces its whole program or just its audio.

## Model access for `mcp`

Claude answers by default; a locally hosted TinyLlama answers when Claude is
unreachable or unkeyed, so an isolated network still spawns configured bots.
Every answer is validated before it can reach a container, retried once, and
falls back to the built-in palette — a cluster always spawns.

| Variable | Where | Effect |
|---|---|---|
| `ANTHROPIC_API_KEY` | conductor | Enables Claude. Absent → TinyLlama only |
| `TINYLLAMA_URL` | conductor | Ollama-compatible host (default `http://localhost:11434`) |
| `TINYLLAMA_MODEL` | conductor | Model tag (default `tinyllama`) |
| `MCP_EVERYTHING_COMMAND` / `_ARGS` | conductor | How to start the Everything MCP server (default `npx -y @modelcontextprotocol/server-everything`) |

Everything MCP is the protocol's reference server — echo, add, printEnv and
friends. It exposes no music capability, so a model composing a part rarely
calls it; it is wired so that attaching a server that *is* useful later is a
config change rather than a code change.

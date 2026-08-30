# Text Cycles

Strudel patterns that play into the Jitsi chat window instead of the speakers.

```js
await initTextCycles()

$: typeface('Times New Roman').word("<I like@2 ~ squirrels\?>")
     .weight("400 200 100 800")
     .slant("<italic none>")
     .size("<12px 24px 10px 1px>*2")
     .color("<#346234 #bfe968>")
     .underline("underline")
     .spacing("<3px 6px 9px 12px>")
     .hover("color:#ffffff")
     .hyperlink("<google.com reddit.com ca.gov devry.edu>")
```

`await initTextCycles()` declares a program's text presence exactly as
`await initHydra()` declares its visuals: first line, then a blank line, then
the patterns. Both may appear in the same preamble.

## What it renders

One styled `<span>` per hap, appended into a chat bubble. There is **one bubble
per cycle per performer**, so a fast pattern fills a line rather than flooding
the panel with messages. Scrollback is capped at 200 bubbles.

Nothing is sent over XMPP. Every browser already evaluates every peer's program
(see `strudel.js`), so each client paints the same words at the same time from
the shared program — no chat traffic, no rate limits, and nothing written into
the room's saved message history.

With no CSS specified, words inherit Jitsi's own chat typography. Only
properties you set are applied.

## Entering the chat

Jitsi gates the message **log** behind a nickname: with no display name on the
local participant the panel renders its nickname prompt *instead of* the message
list, so `#chatconversation` is not in the document at all. Words painted then
land in a detached container and nobody sees them — a working pipeline that
looks exactly like a broken one.

So `await initTextCycles()` enters the chat on the performer's behalf: it takes
their **JPattern room index** as the nickname — the same token the metaprogram
addresses them by, which is also what labels their bubbles — and opens the
panel. A performer who already chose a name keeps it; the prompt is satisfied,
which was the only thing in the way. The token arrives with the sidecar
handshake, so the entry retries for ~20s rather than giving up on the first miss.

Nothing is lost while the chat is shut. The container is the same element every
time, so words collect in it while it is detached and the whole backlog appears
the moment it attaches — whether that is the nickname landing, the performer
opening chat by hand, or a later paint finding the log.

## No sound, by construction

The renderer attaches with `onTrigger(fn, dominant = true)`, and `repl.mjs`
skips `defaultOutput` for any hap carrying a dominant trigger — so a text voice
cannot reach superdough even if it also names a sound. Tempo still works
(`*2`, `@2`, `fast`, `slow`) because that is pattern structure, not output.

The renderer is attached **per statement**, never per block, since landing a
dominant trigger on an audio voice would silence it. A program can mix text and
audio voices freely.

## Escaping

Mini notation owns several characters. To render one literally, escape it:

| Written | Renders |
|---|---|
| `word("<a ~ b>")` | `a`, a rest, `b` |
| `word("<a \~ b>")` | `a`, a literal `~`, `b` |
| `word("squirrels?")` | `squirrels`, played only sometimes |
| `word("squirrels\?")` | `squirrels?` every cycle |

Everything else is literal already — spaces separate words, and emoji, `#`, `:`
and `.` are ordinary text. Case is preserved exactly.

Single quotes opt out of mini entirely, so no escaping is needed at all:
`word('I like ~ squirrels?')` is one whole phrase, one hap.

The same rule applies to every text param, not just `word`/`w`: a bare space
inside a double-quoted value is a mini sequence separator, so
`.typeface("Times New Roman")` mints three one-third-cycle steps
(`Times`, `New`, `Roman`) rather than one font name — exactly the mistake this
doc used to make in its own example above. A value that must stay one atom
despite its own spaces needs single quotes: `.typeface('Times New Roman')`.

**Why escaping needs a Trussal rewrite.** JS itself discards unknown escapes
(`"\~"` is just `"~"`), and Strudel's transpiler reads the post-escape string,
so a backslash that reaches `evaluate()` is already gone. `text-cycles-core.js`
therefore runs over the raw source *before* the transpiler. It also mints every
literal atom into a placeholder token (`tc0`, `tc1`, …), because krill's grammar
cannot hold an emoji, a space or a literal `?` in an atom — the real characters
travel out-of-band in an atom table. Operators pass through untouched, so the
pattern still means what it looks like.

Consequence: `word(someVariable)` and interpolated templates cannot be rewritten
statically. They still render, but with no escaping and no mini.

## Arbitrary properties: use CSS Cycles

`css()` no longer belongs to Text Cycles — styling is its own capability, and
it addresses selectors rather than the words themselves. Text spans are
reachable from there by class:

```js
await initTextCycles()
await initCss()

$: word("I like squirrels").color("<#346234 #bfe968>")
$: css(`.tc-word`).letterSpacing("<1px 4px>").fast(2)
```

`.tc-word` is every text span; `.tc-p-<jitsiId>` is one performer's. Both sit
inside `#trussal-text-cycles`, which is a Trussal root, so the full property
set applies there. See [csscycles.md](csscycles.md).

## Borrowed controls

`size` and `color` already exist in Strudel — `size` is an alias of the reverb
`roomsize` control, and `color` is the visual one. Text Cycles **reuses** them
rather than re-registering, because overriding `Pattern.prototype.size` would
break `.size()` for every audio voice in the room. So `size` arrives on the hap
as `roomsize`. All other names (`word`/`w`, `typeface`/`t`, `weight`, `spacing`,
`slant`, `hover`, `hyperlink`, `underline`) are new controls.

Because they are reused, `.size()` and `.color()` are only rewritten inside
statements that contain a `word()` call — an audio voice's `.size(4)` still
means reverb size.

## Per-participant scoping

Every performer's words carry their own class, `tc-p-<jitsiId>`, on both the
bubble and each span. Generated `:hover` rules are scoped under it, so one
performer's styling can never restyle another's lines.

## Trust

Words, styles and links a peer writes are injected into **every** participant's
DOM, so none of it is trusted:

- text is set with `textContent`, never `innerHTML`;
- declarations are filtered — `url(`, `expression(`, `@import`, `javascript:`
  and any `{}<>;` that could break out of a generated rule are dropped, as are
  the legacy code-executing `behavior` and `-moz-binding`. Layout properties
  like `margin: 50%` are deliberately allowed: disruption is the instrument;
- `hyperlink` forces a scheme (a bare domain gets `https://`), permits only
  http/https/mailto, and emits `rel="noopener noreferrer"` with `target=_blank`.
  Jitsi's own chat already linkifies pasted URLs, so this adds no new
  capability to the room.

## Aggregator interaction

While a remote aggregator is present, `buildPeerBlock` drops remote humans'
audio voices from the local program (per-human publish isolation). Text voices
are kept: they make no sound, so they never ride the published track, and
dropping them would mean only ever seeing your own words. For a mixed program,
`keepSilentStatements` (in `css-cycles-core.js`) keeps the text and css
statements and drops the audio ones.

## Play state

Text flows only while the performer is playing — `buildPeerBlock` skips peers
who are not, the same as audio. Stopping leaves already-painted words in the
chat as history.

## The room's effects, applied to words

A JPattern `#` directive reaches text and styling as well as sound. By
default every effect acts on all four media, so `# room wcl 2` in the shared
metaprogram stretches the letter-spacing of every word this panel paints while
it reverberates the mix; `# room wcl 2 ["audio"]` leaves the words alone. See
`jpattern.md` for the medium argument and the full effect-by-medium table.

| effect | what happens to a word | what happens to its styling |
|---|---|---|
| `room` | letter-spacing grows, **added** to your `.spacing()` so what you wrote stays legible | the span blurs |
| `crush` | a scaled share of the letters is dropped; a word crushed away entirely paints nothing | sizes and spacings snap to a coarse step, colours posterize |
| `noise` | glyphs are prefixed, infixed and suffixed — the bed's colour picks the character band, from `.,'`-_` (brown) to `#@%&$!?` (white) | numeric declarations jitter |
| `echo` | the turn's **last** word repeats, each repeat quieter | each turn's declarations transition out of the previous turn's rather than switching hard |

Two properties are worth knowing when a mutation looks wrong:

**Every mutation is seeded, so all clients paint the same characters.** The
seed names the occurrence — the JPattern cycle, the performer, and the word's
position in the turn — so the third word of a turn mutates identically in every
browser while the first and second do not follow it. It is deliberately *not*
seeded from the Strudel cycle number: each browser starts its own scheduler at
its own moment, so that number is not a shared coordinate and would give every
viewer different text.

**A word can vanish, and that is the effect working.** `# crush` decides each
character on its own, so long words lose proportionally more than short ones,
and a word that loses every character paints nothing at all — the same
directive is dropping samples out of the audio at that moment.

Echo's repeats are appended when the turn **ends**, since that is the first
moment its last word is known to have been last.

## When nothing appears

The text is held in six places between the editor and a bubble, and each can
drop it without raising anything, so each one prints what it is holding
(`text-debug.js`, console prefix `[text-cycles]`):

| stage | question it answers |
|---|---|
| `peer-state:pattern-out` / `-in` | did the program leave this browser / arrive from that peer? |
| `peer-block:<jitsiId>` | is the peer playing, was a preamble split off, did the statements survive the aggregator exclusion? |
| `rewrite:<jitsiId>` | were the atoms minted, is `._tcRender()` attached? (without it there is no renderer) |
| `atoms` | does the token resolve back to characters? |
| `program` | what was handed to `evaluate()`, and did it throw? |
| `trigger` / `paint` | did the hap arrive, and did the span land somewhere **visible**? |
| `container` / `chat-entry` | is the chat log in the document, and if not, why |

Hap-rate lines are capped per second. `__trussalText.state()` dumps the last
record from every stage plus live probes (atom table, chat DOM, what the panel
is currently showing); `__trussalText.off()` silences the printing and keeps
the recording.

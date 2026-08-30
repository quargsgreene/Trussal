# CSS Cycles

Strudel patterns that play into the page's stylesheet instead of the speakers.

```js
await initCss()

$: css(`.ts-chip {
     &:hover { border-color: #ffffff }
   }`)
     .color("<#ffffff #eeeeee #34e3df>/4")
     .borderRadius("<^2em / 1em 3em 0.5em^ ^0.2em 1em 4em 1em^>")
     .backgroundColor("<#101014 #16161c>")
     .fast(3)
```

`await initCss()` declares a program's styling presence exactly as
`await initTextCycles()` declares its words: first line, then a blank line,
then the patterns. Any of the capability declarations may share one preamble.

`.ts-chip` above is a real selector — the participant strip inside
`#trussal-studio-overlay` — so the example is literally paste-able. A
selector that matches nothing in the DOM is not an error: the statement
compiles, the sheet installs, the custom properties update on schedule, and
none of it is visible, because there is nothing on the page for the rule to
land on. If a `css()` voice looks silently inert, check the selector matches
a real element before suspecting the pipeline.

## The two halves of a statement

**The backticked argument is SCSS** — nesting, `&`, `$variables`, `@media`,
`@keyframes`, `@mixin`. Backticks rather than double quotes for two reasons: a
double-quoted string is mini-parsed, so `.example` would hit `.` as the
subdivision operator; and `{}` never survives value sanitising.

**The chain carries the patterned properties.** Any camelCase name that is a
real CSS property becomes a patterned declaration on that block —
`borderRadius` → `border-radius`, `webkitTextFillColor` →
`-webkit-text-fill-color`. Everything else in the chain is left alone as
Strudel structure, so `.fast(3)`, `.slow(2)`, `.every(4, …)` and `.off(…)` mean
what they always mean.

Patterned declarations land in the block's **first** top-level selector. If the
SCSS has several top-level blocks, give each its own `css()` voice.

### Shadowed names

`filter`, `mask`, `scale`, `rotate`, `translate`, `transition`, `order`,
`offset`, `content`, `clip`, `direction` and `all` are both Strudel methods and
CSS properties. **Inside a `css()` chain the CSS meaning wins.** Reach for the
Strudel one outside the chain, or in a separate voice.

Nothing is registered under a bare CSS name — the controls are namespaced
`_cc_*` by the rewrite — so `.color()`, `.size()`, `.speed()` and `.delay()`
still mean reverb, gain and echo for every audio voice in the room.

## Multi-parameter values: the `^…^` fence

A double-quoted value is mini notation, so spaces are steps:

```js
.borderRadius("2em 1em")     // TWO steps: 2em, then 1em
```

Carets fence one literal CSS value. Inside them, spaces, commas and slashes are
CSS rather than mini operators — which is also the only way to write the slash
form of `border-radius`:

```js
.borderRadius("^2em / 1em 3em 0.5em^")                   // one value, all cycle
.borderRadius("<^2em 1em 3em 0.5em^ ^0.2em 1em 4em 1em^>") // two steps, each a full value
.boxShadow("^0 0 4px #f0f, 0 0 8px #0ff^")               // commas survive
```

A function call needs no fence — `rgb(255, 0, 0)` is already read as one value.

## Reach

The **full property set** applies only where a rule matches inside a Trussal
root (`#trussal-studio-overlay`, `#trussal-text-cycles`, the Hydra and keyboard
panels, the facial-gesture panel, the welcome overlays — see `TRUSSAL_ROOTS`).

Everywhere else on the page, the same rule is re-emitted carrying every
**colour**, **border** and **font** property — a performer may fully dictate
how the room's native UI (not only their own Trussal surfaces) is painted,
bordered and set:

- every `background*`, `color`, `filter`/`backdrop-filter`, `*-shadow`,
  `accent-color`, `caret-color`, `scrollbar-color`, `color-scheme`, and the
  `-webkit-text-fill/stroke-color` pair
- every `border*`, `outline*` and `column-rule*` property — width, style,
  colour, radius, `border-image`, all included
- every `font*` property, plus `letter-spacing`, `line-height`,
  `word-spacing`, `text-transform`, `text-decoration*`, `text-emphasis`,
  `text-underline-offset`, `text-wrap` and `-webkit-text-stroke-width`

Layout, position, size and visibility (`width`, `display`, `position`,
`opacity`, `margin`…) stay Trussal-surface-only — a performer can repaint the
whole page but cannot move or hide anything outside their own panel.

So `css(\`body\`).backgroundImage("^url(https://…)^")` and
`css(\`.watermark\`).fontWeight("700")` both work; `css(\`body\`)
.display("flex")` is refused. Every guardrail below applies to both copies.

Each statement compiles to two rules: one nested under the Trussal roots, whose
extra id gives it the specificity to win there, and one bare with the allowlist.

**Patterned declarations — the ones a `.color()`/`.backgroundColor()`/
`.fontFamily()`/`.fontSize()`/… call puts on the chain — carry `!important`.**
That is the entire point of chaining a property onto `css()`: the performer set
it precisely so it visibly tracks the pattern, and losing it to an app default
is indistinguishable from the pipeline being broken. Specificity and source
order are not enough to guarantee that on their own — most of Trussal's own UI
gives its text/background/font colour a direct, non-inherited rule on the
*exact* element (`.ts-name`, `.ts-chip`, `.ts-title`, …), and CSS always prefers
a directly-declared property over one inherited from a same- or
higher-specificity ancestor rule, `!important` or not. A performer's `css()`
selector has to still match a real element for anything to happen (an
ancestor-only match has nothing to override, per the silent-selector note
above) — `!important` fixes losing the cascade, not losing the match.

Hand-authored declarations written directly in the backticked SCSS (not
chained) are unaffected and keep the normal cascade — for those, the fix for
"stuck at defaults" is still to drop `!important` from the app's own rule
(in `docker-jitsi-meet/jitsi-web/custom.css`, or a Trussal panel's own injected
`<style>`), since it is a default, not a forced override; the app CSS this repo
owns should never need `!important` outside of two genuine exceptions: an
intentional `display: none`/hide (which CSS Cycles is refused from touching
anyway), or defeating upstream Jitsi's own component CSS whose specificity this
repo does not control (the video-tile transparency rules in `custom.css` are
the one place that applies).

## Guardrails

A statement is **refused whole** if any value its pattern can produce is
illegal — including one that only surfaces on the third cycle of
`<1 0.5 0>`. Refusal is reported to the performer and the statement contributes
nothing to the sheet.

| Refused | |
|---|---|
| `display: none` | |
| `overflow`/`overflow-x`/`overflow-y`, `visibility`, `content-visibility` set to hidden | |
| any size property at `0` | except `margin`, `padding`, every `*radius`, and border/outline widths |
| `opacity: 0`, or an alpha of 0 on `color` | a transparent *background* is ordinary |
| `z-index`, on any selector | no layering at all, including your own overlays |
| off-screen positions | `top`/`left`/`inset`/negative margins/`text-indent`, and `translate()` inside a `transform` |
| `filter: opacity(0)`, `brightness(0)`, `contrast(0)`, `blur()` over 8px | other filter functions are unrestricted |
| `clip-path` shapes that enclose nothing | |
| `pointer-events: none` | *not* in the original specification — an unclickable UI is as non-functional as an invisible one |
| `url()` outside background/border-image properties, or on a scheme other than http(s)/`data:image`/same-origin | |
| `expression()`, `javascript:`, `@import`, `behavior`, `-moz-binding` | |

**Media queries** are walked and their contents held to the same rules, so a
breakpoint cannot hide the UI for a screen-size range this browser does not
currently have. **`@keyframes`** are walked too, so an animation cannot travel
somewhere a static rule may not go; they are namespaced per performer
(`tc-p-<jitsiId>-<name>`) and references in `animation`/`animation-name` are
rewritten to match, so two performers animating `spin` do not collide.

### Values that only exist at runtime

`.opacity(sliderWithID(…))`, a JS variable, a facial-gesture-driven value —
none can be enumerated when the statement is accepted. These are allowed, and
**clamped per hap** instead: `opacity: 0` becomes `0.04`, a zero size becomes
`1px`, `blur(80px)` becomes `blur(8px)`. Where there is nothing sensible to
clamp to (an off-screen position, a z-index) the declaration is dropped and the
previous value stands.

### Text against its container

This one is a two-party, runtime property: your text colour is legal until
another performer sets a matching background, and neither statement is illegal
alone. So it is **not** refused — the colliding text colour is walked away from
the background in lightness until it clears a 3:1 contrast ratio. A ratio
rather than exact equality, because `#fffffe` on `#ffffff` is not an accident.

## Two speeds

SCSS cannot be compiled per hap, so the work splits:

- **cold**, once per code-state update: the chained properties are transpiled
  into the SCSS block as `var()` references, the whole sheet goes to the latency
  sidecar over the peer bus, and the compiled CSS is broadcast back to the room.
- **hot**, per hap: the trigger reassigns a CSS custom property on `:root`. No
  compile, no round-trip, no re-evaluation.

The custom property name (`--cc-<token>-<property>`) is derived from the
statement's own token, so the sheet the sidecar compiled and the trigger running
in every browser agree on it without coordinating.

Only the authoring browser sends its SCSS. One compile serves the whole room,
and no browser ships a Sass compiler — the bundle Jitsi loads on every join
would have grown by several megabytes.

## Trust

Guardrails run **twice**, and the second time is the one that counts:

- **outbound**, in the authoring browser, so the performer gets an error naming
  the rule that will not run;
- **inbound**, in every receiving browser, before a peer's compiled sheet enters
  the document.

The sidecar compiles whatever it is handed and cannot tell an honest client from
a patched one, so a sheet that never passed an outbound check still has to fail
on the way in. Inbound refusal takes the whole sheet. A selector must genuinely
stay inside a Trussal root to earn the full property set —
`#trussal-studio-overlay ~ *` starts there but selects everything beside it, so
sibling combinators disqualify it, and one escaping alternative in a selector
list holds the whole rule to the allowlist.

The sidecar defends itself separately: `@use`, `@import`, `@forward` and
`meta.load-css` are refused before the compiler sees them (Sass resolves those
against the container's filesystem), and sources over 64KB are rejected.

**One thing the allowlist opens on purpose:** `background-image` outside Trussal
surfaces permits `url(https://…)`, so a performer can make every participant's
browser fetch a URL of their choosing, disclosing IP addresses to a third-party
host. That follows directly from background images being allowed page-wide;
restrict `URL_OK_PROPS` to `data:` and same-origin if that trade is not wanted.

## No sound, by construction

The renderer attaches with `onTrigger(fn, dominant = true)`, and `repl.mjs`
skips `defaultOutput` for any hap carrying a dominant trigger — so a css voice
cannot reach superdough even if it also names a sound. Tempo still works
(`fast`, `slow`, `*2`, `@2`) because that is pattern structure, not output.

The renderer is attached **per statement**, never per block, since landing a
dominant trigger on an audio voice would silence it. A program can mix audio,
text and css voices freely.

## Mutual exclusion

Two performers' `css()` statements can both target the same selector — nothing
stops two people from both writing `css('.ts-chip')`. Left alone, the room's
ordinary cascade would decide the winner (sheets install in a fixed order, both
copies carry `!important` — see Trust below), which is not "the last performer
to touch it wins" so much as "whichever peer's jitsiId sorts last always wins,
forever, regardless of who actually played most recently."

Instead, only ONE peer's declared values for a given statement are ever
live at a time — everyone else's custom properties are pinned to the room's own
captured default: what `getComputedStyle` reported for that selector+property
the moment BEFORE any CSS Cycles rule ever referencing it was installed,
cached forever from there. That timing matters — a compiled rule's declaration
always carries `!important` on a `var()` reference (see Trust below), and a
property computed from a still-unset custom property resolves to CSS's own
*initial* value, not to whatever lower-priority rule (Trussal's own studio
styling, say) would otherwise apply. Capturing "the default" from a page that
already has such a rule installed — even one that has never fired a real
value yet — would silently record that initial value instead of the room's
actual original look, so the capture happens at INSTALL time (`installPeerCss`
warms every property a peer's sheet is about to declare, for every peer, not
just whichever one's own hap happens to fire first), never later. A benched
peer's styling behaves exactly as if their program had never run: their
contribution reverts to the untouched page, not to some other peer's current
value or to CSS's own defaults.

Ownership is decided by whoever the Net Cycles ring's current slot belongs to —
the same ring Strudel/Hydra/Text Cycles use. But unlike those three, CSS
Cycles' gate **never fails open**: those three show every peer at once whenever
no ring is actively scheduling turns (no aggregator has reported in yet, or the
room has no `$ participants` schedule), whereas CSS Cycles keeps exclusivity
even then, falling back to the room's own default schedule (`$ participants
<0>`) rather than opening every peer's styling to the shared cascade. Opening
every peer's CSS at once is rarely what a room wants.

Pinning a benched peer's properties back to their baseline normally only
happens the next time THAT peer's own hap fires — fine for a fast pattern, but
a slow or sparse one could keep showing what they last painted well after
their turn actually ended, reading as "the styling froze where the previous
performer left it" rather than resetting. So every currently-declared property
is proactively re-pinned to its baseline the instant the ring's token changes
(`resetAllCssToBaseline`, fired off the same event the turn highlighter uses)
rather than waiting on each peer's own next cycle — so a turn handoff always
starts from the room's original CSS, and the new owner's own next hap is what
moves it on from there.

## Play state

Styling flows only while the performer is playing, and — unlike text, which
stays in the chat as history — **stopping pulls every sheet and releases every
custom property**. That is the deliberate way back to a usable UI, and it works
for a peer's styling as well as your own.

## Aggregator interaction

While a remote aggregator is present, `buildPeerBlock` drops remote humans'
audio voices from the local program. `keepSilentStatements` keeps the text and
css statements: they make no sound, never ride the published track, and dropping
them would mean only ever seeing your own styling.

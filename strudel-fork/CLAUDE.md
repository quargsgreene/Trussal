# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Strudel is a JavaScript port of [TidalCycles](https://tidalcycles.org/) — a live coding language for music — running in the browser. It is hosted at https://strudel.cc and organized as a pnpm monorepo with ~30 packages.

**AI/LLM policy**: The project does not accept wholly LLM-generated PRs. If code involves LLM assistance, it must be disclosed in the PR description.

## Commands

```sh
pnpm i              # install all dependencies (also symlinks workspace packages)
pnpm dev            # start local REPL (runs website dev server)
pnpm start          # same as dev
pnpm test           # run all tests
pnpm test-ui        # run tests with Vitest UI
pnpm snapshot       # regenerate test snapshots (run when adding/changing pattern functions)
pnpm lint           # run ESLint
pnpm codeformat     # format all files with Prettier
pnpm format-check   # check formatting without writing
pnpm check          # run format-check + lint + test (same as CI)
pnpm run osc        # start OSC server
pnpm tauri build    # build standalone desktop app
```

Run tests for a single package:
```sh
cd packages/core && pnpm test
# or from root:
pnpm --filter @strudel/core test
```

Run a specific test file with Vitest:
```sh
npx vitest run packages/core/test/pattern.test.mjs
```

The `pretest`/`prestart`/`prebuild` hooks all regenerate `doc.json` via jsdoc before running — this is expected and required.

## Architecture

### Core Data Model (`packages/core`)

Three fundamental classes underpin everything:

- **`TimeSpan`** (`timespan.mjs`) — An interval `[begin, end)` measured in cycles, using exact rational arithmetic (`Fraction` from `fraction.js`). The key method `spanCycles` splits a span across cycle boundaries.

- **`Hap`** (`hap.mjs`) — A pattern event. Has `whole` (the full onset span), `part` (the active fragment — smaller when split), `value` (an object with sound parameters), and `context` (source code locations for highlighting). The `part` must always lie within `whole`.

- **`Pattern`** (`pattern.mjs`) — A function `State → Hap[]`. The constructor takes a `query` function and an optional `_steps` count. All pattern combinators are methods on `Pattern` and are also registered as standalone functions via `register()`. The global `strudelScope` is populated by `evalScope()` so user code can call them without imports.

### Evaluation Pipeline

User code in the REPL goes through:
1. **Transpiler** (`packages/transpiler`) — Rewrites JS to inject mini-notation parsing and widget support, using Acorn for AST manipulation. Plugins: `plugin-mini.mjs`, `plugin-sample.mjs`, `plugin-widgets.mjs`, `plugin-kabelsalat.mjs`.
2. **`evaluate()`** (`packages/core/evaluate.mjs`) — Runs transpiled code in `strudelScope` (a shared global), returns the resulting pattern.
3. **Scheduler** (`Cyclist` / `NeoCyclist` in `packages/core`) — Queries the pattern at regular clock ticks (via `zyklus.mjs` clock), then calls `onTrigger` for each `Hap` in the queried window.
4. **Output** — Each `Hap.value` is sent to an output backend (WebAudio, OSC, MIDI, etc.).

### Mini Notation (`packages/mini`)

Mini notation strings (e.g. `"bd sd [hh hh]"`) are parsed by a PEG.js grammar (`krill.pegjs`), compiled to `krill-parser.js`, and converted to patterns in `mini.mjs`. The transpiler plugin automatically wraps bare strings passed to pattern functions through this parser.

### Audio Engine (`packages/superdough`, `packages/webaudio`)

`superdough` is the Web Audio synthesis engine — handles synths, samples, effects, and AudioWorklets. `packages/webaudio` wraps it for strudel use, providing `webaudioOutput` (the default trigger callback) and `renderPatternAudio` for offline rendering.

### Website / REPL (`website/`)

Built with [Astro](https://astro.build/) and React. Key files:
- `website/src/repl/useReplContext.jsx` — Main React hook; instantiates `StrudelMirror` from `@strudel/codemirror`, wires up audio init, pattern loading, and sharing.
- `website/src/repl/prebake.mjs` — Preloads all sample banks (CDN-hosted) before playback.
- `website/src/settings.mjs` — Nanostores-based persistent settings (audio device, CPS, etc.).
- `website/src/repl/Repl.jsx` — Top-level REPL component; renders `ReplEditor` or `EmbeddedReplEditor` depending on context.

### CodeMirror Integration (`packages/codemirror`)

Provides `StrudelMirror` — a CodeMirror 6 editor with Strudel-specific extensions: mini notation highlighting, inline sliders/widgets, flash-on-eval, Vim mode, themes, and autocomplete.

### Output Packages

Each output adapter follows the same interface (`(hap, deadline, hapDuration, cps, t) => void`):
- `packages/midi` — Web MIDI API
- `packages/osc` — OSC via WebSocket server (`packages/osc/osc-server.mjs`)
- `packages/csound` — Csound integration
- `packages/hydra` — Hydra visual synth
- `packages/mqtt` — MQTT output
- `packages/serial` — Web Serial API

### Package Conventions

- All packages use ES modules (`.mjs` extension), `"type": "module"` in `package.json`.
- Local packages import each other as `@strudel/<name>` (resolved via pnpm workspace symlinks in dev, from `dist/` on publish).
- Each package builds with `vite build` before publishing; `publishConfig.main` points to `dist/index.mjs`.
- Tests live in `packages/<name>/test/` and use Vitest with `describe`/`it`/`expect`.

## Code Style

Prettier is enforced: 120-char line width, 2-space indent, single quotes, trailing commas. Run `pnpm codeformat` before committing. ESLint enforces `no-unused-vars` (warn) and no extraneous dependencies.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Project Is

Trussal is a networked algorave platform — a customization of Jitsi Meet that adds a live-coding instrument (Strudel), per-peer audio effects chains driven by network conditions (RTT/jitter), facial gesture control via MediaPipe, Hydra visual synthesis, and Jamulus integration for low-latency audio. All custom JavaScript is bundled into a single `custom-config.js` that Jitsi loads on page start.

## Commands

```bash
# Run the root test suite (node:test — pure Net Cycles modules + sidecar integration)
npm test

# Build custom-config.js (esbuild, ESM)
npm run build

# Watch mode (incremental rebuilds)
npm run watch

# Build + copy into the Jitsi web container directory
npm run deploy:local

# Full redeploy: build, deploy:local, then rebuild + restart Docker services
./run.sh

# Rebuild vendored strudel-fork packages (only needed when strudel-fork source changes;
# dist files are committed so a normal clone + `npm run build` does not need this)
# Requires pnpm@8 (fetched automatically via npm exec) and Node >=18
npm run build:strudel-fork

# Clean dist/
npm run clean
```

The Docker stack lives in `docker-jitsi-meet/`. To rebuild only one service:
```bash
cd docker-jitsi-meet
docker compose build --no-cache web && docker compose rm -sf web && docker compose up -d web
```

Set `JAMULUS_HOST` in the environment (or `docker-jitsi-meet/.env`) before building to override the default Jamulus hostname baked into the bundle.

## Architecture

### Build pipeline
`src/index.js` → esbuild → `dist/custom-config.js`. The build aliases `@strudel/web` and `@strudel/soundfonts` to the vendored fork at `strudel-fork/` and copies Strudel's SharedWorker asset files into `dist/assets/`. `@strudel/core` and `@strudel/webaudio` are pinned to the repo's own `node_modules` to avoid esbuild walking into the pnpm workspace.

### Deployment
`dist/custom-config.js` is volume-mounted into the Jitsi `web` Docker container and served as `/custom-config.js`. A second container (`latency`) runs the Node.js WebSocket sidecar from `latency-instrument/`.

### Source modules (`src/`)

| File | Role |
|---|---|
| `index.js` | Entry point — initialises all top-level renderers |
| `studio.js` | Main overlay UI: participant strip + Latency Effects + Strudel editor cards |
| `strudel.js` | Strudel engine: stacks all peers' patterns into one `$:` program and re-evaluates on every state change |
| `peer-state.js` | WebSocket bus to the latency sidecar — tracks roster, RTT/jitter metrics, patterns, effects, and play state for every peer |
| `participants.js` | Polls `window.APP.conference` (Jitsi internals) to read the participant roster; emits `local`, `local-update`, `join`, `leave` events |
| `latency-instrument.js` | WebAudio engine: one per-peer effects chain (AudioWorklet → limiter → optional reverb) per participant; routes remote mic `<audio>` tags and Strudel output through those chains |
| `facial-gesture.js` | MediaPipe face-tracking: smile → play, thumbs-up → stop, head cursor for UI dwell |
| `hydra-video.js` | Hydra visual synthesis with two modes: `split` (camera panel + independent Hydra canvas) and `direct` (camera fed to `s0` for `src(s0)` patterns) |
| `on-screen-keyboard.js` | On-screen QWERTY with head-cursor dwell, drag, and trie-based Strudel keyword autocomplete |
| `user-samples.js` | IndexedDB-backed local sample loading; users upload folders, reference them as `s("foldername")` in Strudel patterns |
| `jamulus.js` | Jamulus room map + welcome panel/banner injection; `JAMULUS_ROOM_MAP` is exported to `window` |
| `welcome-page.js` | Jitsi welcome-page and prejoin-screen customizations |
| `meeting.js` | In-meeting customizations (e.g. no-audio toast) |
| `prejoin.js` | Prejoin screen logic |
| `editor-router.js` | Routes head-cursor/keyboard input to whichever editor is focused (personal Strudel vs shared Net Cycles) |
| `audio-net/` | Net Cycles: metaprogram parser + deterministic scheduler + AV buffer queues (`Metaprogrammer*.js`, `MetaprogramScheduler.js`), O2lite/ClockSync, CRDT sync (Yjs over the sidecar), worst-case metrics + artificial modulation (`network-modulation/`), RTCStats + spectrum observability (`observability/`), network-modulated effects (`av-effects/`), bot cluster orchestration, room health |
| `bridges/XMPPtoO2Mapper.js` | jitsiId ↔ room index ↔ O2 service name |
| `mcp-agent/` | Standalone MCP server (own package.json): AI-composed pattern updates via per-bot ordered queues + metaprogram apply |

Top-level: `components/` (vanilla-DOM Net Cycles editor/highlighter/cluster video), `public/lib/o2lite-web.js` (O2lite WS client), `server/O2Relay.js` (re-export of the sidecar's O2 relay).

### Key design constraints

- **No framework.** All Trussal code is vanilla JS injected into Jitsi's existing React app. DOM manipulation is always direct; there is no shadow DOM or component lifecycle to rely on.
- **Participants are polled, not evented.** `participants.js` polls `window.APP.conference` on a 1-second interval because Jitsi's internal event API is unstable. Code that needs the participant list should subscribe via `subscribeParticipants()`, not read `APP.conference` directly.
- **Strudel is evaluated once per browser, combining all peers.** `strudel.js` builds one program from every playing peer's pattern using `$:` labeled-voice syntax and re-evaluates whenever any peer's state changes. Local peer effects are applied via WebAudio post-mix; remote peer effects are injected as `.distort()/.crush()/.room()` calls into the combined program.
- **Audio effects are deterministic from network metrics.** RTT and jitter values (broadcast over the peer-state bus) are used identically on every client to compute effect parameters, so all browsers produce the same processed audio for the same peer.
- **The latency sidecar WebSocket** connects at `wss://<host>/ws?room=<name>&role=player` (nginx proxies it). `peer-state.js` owns this connection and buffers outbound messages until the `hello` handshake completes.
- **Hydra `direct` mode** redirects user `.out()` calls to `o1` and composites with the live camera (`s0`) into `o0`, driven by blend/color globals (`window._hvBlendAmt`, `_hvR/G/B`) that `hydra-video.js` updates from peer state.

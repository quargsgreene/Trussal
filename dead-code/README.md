# dead-code/

Quarantined dead and unreachable code, moved out of the live tree starting
2026-08-28.

Nothing in this directory is imported, built, or tested. `src/index.js`
(the bundle entry), `latency-instrument/server.js` (the sidecar), the bots
runtime, the MCP servers and `test/*.test.js` were all traced transitively;
every symbol below had **zero reachable callers** — either never referenced
at all, or only from a call site that is itself commented out. The files
here mirror their original paths under `src/`, `bots/` and `test/` so a
symbol can be put back where it came from.

The 2026-08-29 batch is different from the rest: those features were live,
not dead. They were removed on request. See "Removed features (2026-08-29)"
below — the archived files there import from live-tree relative paths that no
longer resolve from `dead-code/`, which is fine (nothing here runs); each
file's header lists what to restore alongside it.

These archived files are **not** standalone modules — most of the moved
functions closed over module-private state (`_mode`, `anyPlaying`,
`pollTimer`, `audioRouted`, `myPeerId`, …) that stayed behind in the live
module. Each file's header lists what it needs if it is ever revived.

## What moved, and why it was dead

| Original | Symbols | Reason |
|---|---|---|
| `src/hydra-video.js` (panel UI) | `injectHydraVideoToggle`, `setMode`, `_autoStartVideo`, `_clearAllEffects`, `_stream`, `_panelOpen` | `injectHydraVideoToggle`'s call in `studio.js` is commented out. `setMode` had no caller. `getMode` / `setVideoStream` / the `_ensurePanel`+`_injectStyles`+`_updatePanelStatus` panel builders stayed — `strudel.js` uses `getMode`, and `facial-gesture.js` calls `setVideoStream` (which lazily builds the panel). |
| `src/jamulus.js` | `addJamulusWelcomePanel`, `startJamulusWelcomePanel`, `startJamulusBannerPolling`, `attachJamulusBanner`, `renderJamulusWelcomePanelAndBanner`, `ensureRelayWorklet`, `connectJamulusRelay`, `disconnectJamulusRelay`, `isRelayConnected`, `_relayWs`, `_relayWorklet`, `_relayWorkletLoaded` | Jamulus welcome-panel + in-page relay client. The panel call in `index.js` and the relay UI handler in `studio.js` are both commented out. `getRoomNameFromUrl` and `JAMULUS_ROOM_MAP` stayed — they are still used. |
| `src/latency-instrument.js` | `getRoutedPeerIds`, `isAudioRoutedFor`, `isJamulusMode` | No callers. `studio.js` imported `isAudioRoutedFor`/`isJamulusMode` but never called them. |
| `src/participants.js` | `getRemoteParticipants` | Imported by `studio.js`, never called. Consumers use `subscribeParticipants()`. |
| `src/peer-state.js` | `getMyPeerId` | No callers. |
| `src/strudel.js` | `syncStrudelFromPeers`, `isStrudelPlaying` | No callers. |
| `src/text-cycles.js` | `isTextCyclesActive` | No callers. |
| `src/facial-gesture.js` | `BLINK_THRESHOLD`, `JAW_OPEN_THRESHOLD`, `COOLDOWN_MS`, `_lastFired` | Leftovers from a cooldown/blink path replaced by the `_latch` + `LATCH_RESET` logic. |
| `src/studio.js` | `parseVoiceButtons`, `renderVoiceButtons`, `BTN_MARKER`, and the commented-out `onRelayClick` | "Voice buttons" widget: no template ever renders `.ts-voice-btns`, so `renderVoiceButtons` early-returns; nothing calls it anyway. The `.ts-voice-btn*` rules in `src/studio.css` are now unused but were left in place (shared-selector risk). |
| `src/user-samples.js` | `compressImage` | `# crush` on an uploaded image was never wired to it. Needs `compressedSize` (still exported). |
| `src/audio-net/EffectMedia.js` | `chainForMedium` | No callers. |
| `src/audio-net/MetaprogrammerParser.js` | `EFFECT_DEFAULTS` | Superseded by the per-effect param resolvers; nothing reads it. |
| `src/audio-net/RoomHealthService.js` | `stopRoomHealth` | Teardown counterpart to `startRoomHealth`; never called. |
| `src/audio-net/observability/NetStats.js` | `stopNetStatsPolling` | Teardown counterpart to `startNetStatsPolling`; never called. |
| `src/audio-net/observability/PipelineLatency.js` | `stopPipelineLatencyMeasurement` | Teardown counterpart to `startPipelineLatencyMeasurement`; never called. |
| `bots/src/shared/config.js` | `STRATIFICATION_ROLES` | Frozen enum with no importers; the role flags actually used are the lowercase keys of `defaultConfig.roles`. |

## Revived

- **`src/on-screen-keyboard.js`** — brought back to `src/`. The toggle now
  lives in the Trussal Studio header (`injectKeyboardToggle`, beside the Face
  button) instead of a page-corner button, and `studio.js`'s `tickUi()` calls
  `tickKbdUi()` again. Word autocomplete moved to a pure `on-screen-keyboard-core.js`
  (trie + prefix + prediction) with tests.

## Deliberately NOT moved

- **`src/audio-net/Metaprogrammer.js`** carries a large block of currently
  dormant Net Cycles machinery (VLANs, induced metrics, epoch/clock sync,
  buffer replay, the local scheduler). Project guidance is to keep
  in-progress capabilities dormant rather than delete them, so it was left
  untouched even though ~38 of its top-level symbols have no live caller
  yet. Several `latency-instrument.js` exports (`setChainGate`,
  `insertMasterChain`, `removeMasterChain`, `resetChainGates`,
  `attachNodeToChain`) are only reached through that dormant code and were
  likewise left in place.
- **`src/latency-instrument.js` `detachNodeFromChain`** lost its only caller
  with the Jamulus relay, but was kept as the symmetric half of the
  still-used `attachNodeToChain`.
- **`src/published-video.js` `resetPublishedVideo`** looks unused to a
  static import scan but `test/published-video.test.js` calls it via a
  namespace import in `afterEach`.

## Removed features (2026-08-29)

Five live features removed on request. Most of the change was scattered edits
across the metaprogram parser, the av-effects, the studio readout and the
bot-config surface (see the git diff for those); only the whole modules and
test files are archived here.

| Archived here | Feature | What else was removed / changed |
|---|---|---|
| `src/mcp-agent/` (whole package), `test/mcp-agent.test.js` | **MCP Cycles** — the standalone MCP server exposing Strudel control to an external Claude, with per-bot ordered update queues | root `package.json` `pretest` hook (`npm --prefix src/mcp-agent install`); the `mcp-agent/` row in `CLAUDE.md`; the `mcp-agent/` subtree + diagram box in `src/features/netcycles.md` |
| `bots/src/llm/` (script-composer, claude-client, tinyllama-client, everything-mcp), `bots/test/fleet-mcp.test.js`, `bots/test/script-composer.test.js` | **`botConfig({ mcp: "…" })`** — fleet-side LLM composition of a cluster's master from a prompt | `mcp` dropped from `BOT_CONFIG_PROPS` (`src/bot-config.js`); `compose` / `#composeOwnerSource` / the spawn-path `composed` block removed from `bots/src/orchestrator/{index,fleet-service}.js`; the `mcp` rows + "Model access for `mcp`" section in `src/features/botconfig.md` |
| `src/audio-net/network-modulation/IncreaseJitter.js`, `IncreaseRTT.js` | **WCJ and WCRTT** — removed as metrics from Net Cycles entirely | dropped from `TIMING_METRICS` / `EFFECT_METRICS` / `CRUSH_METRICS` / `ECHO_METRICS` (parser + av-effects); `computeWorstCaseMetrics` no longer returns `wcj`/`wcrtt`; `INDUCTIONS` and the CRDT `modulation` channel lose them; `RoomHealth.avDecouplingSeconds` repointed to `wcl`; `Room.js`'s cascaded lowpass cutoff repointed from `wcrtt` to the room's own decay length; the studio "Network Metrics" readout drops the `WCJ`/`WCRTT` fields (the raw per-peer `jitter` / `media jitter` readings stay). WCL and WCPL remain. |
| — (scattered edits only) | **`# disjointCss`** — the metaprogram directive toggling CSS Cycles' room-wide mutual exclusion | the `disjointCss` entry in `EFFECTS`, `disjointCssEnabled` / `DISJOINT_CSS_ENABLED_BY_DEFAULT` (`MetaprogrammerParser.js`), `isDisjointCssEnabled` (`Metaprogrammer.js`); `css-cycles.js`'s `ownsCssTurn` / `handleNetCyclesTokenChange` drop the `isDisjointCssEnabled()` guard, so the disjoint (never-fail-open) behaviour — which was the default — is now unconditional; the `### disjointCss` section in `netcycles.md`, the `# disjointCss` mentions in `csscycles.md`, and the parser test section |
| — (scattered edits only) | **`colorScheme: "split-complementary"`** — one value of the bot-cluster `colorScheme` enum | dropped from `BOT_CONFIG_PROPS.colorScheme.values` (`src/bot-config.js`), the `COLOR_SCHEMES` map (`bots/src/script-gen/bot-config-transform.js`), the `botconfig.md` value list, and the accept/loop tests. The other schemes are unchanged. |

To revive any of these, move the archived files back and reverse the
corresponding edits above (each archived file's header repeats them).

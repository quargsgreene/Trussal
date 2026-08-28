# dead-code/

Quarantined dead and unreachable code, moved out of the live tree on
2026-08-28.

Nothing in this directory is imported, built, or tested. `src/index.js`
(the bundle entry), `latency-instrument/server.js` (the sidecar), the bots
runtime, the MCP servers and `test/*.test.js` were all traced transitively;
every symbol below had **zero reachable callers** — either never referenced
at all, or only from a call site that is itself commented out. The files
here mirror their original paths under `src/` and `bots/` so a symbol can be
put back where it came from.

These archived files are **not** standalone modules — most of the moved
functions closed over module-private state (`_mode`, `anyPlaying`,
`pollTimer`, `audioRouted`, `myPeerId`, …) that stayed behind in the live
module. Each file's header lists what it needs if it is ever revived.

## What moved, and why it was dead

| Original | Symbols | Reason |
|---|---|---|
| `src/on-screen-keyboard.js` | **whole file** | Its only export `tickKbdUi` was imported by `studio.js`, but the one call (`// tickKbdUi();`) is commented out — the panel was never built. `trussal-kbd-eval` (the event it fired) is still produced by `jitsi-bot.js` and handled in `studio.js`. |
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

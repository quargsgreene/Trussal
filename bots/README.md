# Trussal Bots

Ten headless-browser bots join a shared Jitsi meeting (`http://localhost/0`) and a Jamulus
server (`trussal.duckdns.org:22000`), each playing an individualized variation of a master
Strudel + Hydra script under a centralized conductor.

## Layout

```
bots/
  src/shared/        config, dog-breed names, percentile/WCL stats, gain & fx math
  src/script-gen/    master script generation, JSON validation, per-bot variation
  src/bot/           Puppeteer bot, page-injected scripts, ffmpeg/Jamulus sidecars
  src/orchestrator/  conductor (health policy, lifecycle), docker runner, entrypoint
  src/config-api/    admin HTTP server + unstyled admin page
  test/              node:test suites (45 tests, no external deps)
  docker/            bot + conductor Dockerfiles, container entrypoint
  docker-compose.yml
```

## Prerequisites

- Docker with the compose plugin.
- Jitsi reachable on the VM at `http://localhost/0`.
- ALSA loopback kernel module, loaded **on the host** once per boot
  (two cards × 8 substreams cover 10 bots; each bot claims its own subdevice):

  ```sh
  sudo modprobe snd-aloop enable=1,1 index=10,11 pcm_substreams=8,8
  ```

## Run

```sh
cd bots
docker compose --profile build-only build   # builds conductor AND the trussal-bot image
                                            # (plain `docker compose build` skips the
                                            # profiled bot-image service!)
docker compose up -d conductor              # conductor spawns/replaces bot containers itself
```

Admin page: `http://<vm-address>:7777` from any GUI browser outside the VM.
(If the VM sits behind NAT or is only reachable over SSH, forward the port:
`ssh -L 7777:localhost:7777 <vm>`.)

## Home-network load

Bots are senders, not viewers, so by default they are configured to be gentle on a
self-hosted Jitsi bridge:

- `config.channelLastN=0` — bots download **zero** remote video (kills the n×(n−1) fan-out;
  the bridge only sends streams to human viewers);
- send capped at 360p, start bitrate 800 kbps, Hydra canvas captured at 15 fps.

Worst case with 10 bots: ≈ 8 Mbps total upload into the bridge, near-zero bot download.
Each Jamulus client adds ~0.2 Mbps both ways to the Jamulus server. The health policy is
also a circuit-breaker: if median bot latency exceeds 400 ms the fleet automatically
scales down.

Point the fleet at your Jitsi by setting `JITSI_URL` (e.g. in a `.env` next to
docker-compose.yml: `JITSI_URL=http://your-jitsi-host/0`). Tune the guards via the
conductor env (`JITSI_CHANNEL_LAST_N`, `JITSI_VIDEO_HEIGHT`, `JITSI_START_BITRATE_KBPS`,
`CAPTURE_FPS`).

## Admin page

- **Bot count slider** (1–10) and **role checkboxes** — the four non-mutually-exclusive
  stratification roles: frequency bands, staggered round (worst-case-latency subdivisions),
  unison, stereo image/Hydra tiles. Applying changes resizes the fleet and redistributes
  scripts live.
- **Health thresholds** — minimum fps cutoff and per-bot memory ceiling. Violations shrink
  the session's max bot count from 10 proportionally (never below 1).
- **Master script upload** — a JSON file `{"strudel": "...", "hydra": "await initHydra()..."}`.
  It is validated (shape, `await initHydra(` prefix, JS syntax) before distribution;
  errors are shown inline.
- **Per-bot code inspector** — one button per bot opens a modal (`<dialog>`) showing the
  exact Strudel/Hydra code and entry delay that bot is running.

## How it works

- **Conductor** (`src/orchestrator/conductor.js`) owns the master script (seeded-random or
  uploaded), derives each bot's variation, serves `GET /assignment/:id`, collects
  `POST /metrics`, and applies the health policy every tick:
  - any runtime/syntax eval error → terminate and replace immediately;
  - latency or RAM above the fleet's 95th percentile (≥4 bots reporting) → replace;
  - fleet median fps under the cutoff, RAM over the ceiling, or median latency over
    400 ms → scale the ceiling down from 10.
- **Worst-case latency (WCL)** is computed by the conductor as the max of all bots'
  reported latencies; role 2 staggers each bot's entry by `index × WCL/subdivisions`
  (Global Drum Circle model).
- **Bots** run host-networked containers (the spec's `http://localhost/0` must resolve to
  the VM). Chromium launches with the four spec-required flags plus
  `--use-fake-device-for-media-stream`; a `getUserMedia` override hands Jitsi a video track
  captured from the Hydra canvas and an audio track tapped from Strudel's WebAudio output.
  The bot joins unmuted, so Jitsi carries the music directly to listeners. The same tap is
  also fanned out to the bot's own ALSA loopback subdevice, where — alongside an ffmpeg
  pink-noise bed (band-limited to the bot's frequency band, gain-staged `0.7/√N`) — a
  per-container `jackd` bridges into the Jamulus client. Each bot is named after a dog breed,
  deterministic per `(botId, sessionSeed)`.

## Develop

Host needs Node ≥ 20 (this VM: `~/.local/node/bin` is on PATH via `.bashrc`).

```sh
cd bots
npm test                                  # all 45 tests, no Docker/Chromium needed
node --test test/orchestrator.test.js     # one suite
```

Tests follow TDD: pure policy/math (stats, health, gain, variation) is tested directly;
the Bot and Conductor take injected fakes (Puppeteer launcher, container runner), so the
full replace/scale/lifecycle logic runs in-process.

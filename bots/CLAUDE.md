# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Context

This directory is part of the Trussal networked algorave platform. See the parent [`../CLAUDE.md`](../CLAUDE.md) for full project architecture, build commands, and design constraints.

Bots are automated participants in Trussal/Jitsi sessions. They interact with the same WebSocket peer-state sidecar (`wss://<host>/ws?room=<name>&role=player`) that browser clients use, so they must complete the `hello` handshake before sending any messages.

## Bots

| File | Role |
|---|---|
| `strudel-bot.js` | Sidecar-only: joins the WebSocket bus and plays a pattern. Does NOT appear in the Jitsi video grid. |
| `jitsi-bot.js` | Full participant: headless Chrome joins Jitsi via WebRTC, visible in the video grid. |

### First-time setup for jitsi-bot (host only)

There is **no `install-chrome` npm script** — `package.json` defines only `test`,
`test:one`, `start` and `bot`. Do it by hand. `jitsi-bot.js:27` hardcodes
`bots/chrome/opt/google/chrome/chrome`, which is exactly the layout you get by
extracting a Google Chrome .deb into `bots/chrome/`:

```bash
cd bots
curl -sSLO https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
# resolve Chrome's GTK/audio dependencies (Ubuntu 24.04+ renamed several to *t64,
# so let apt work the names out rather than listing them)
sudo apt-get install -y ./google-chrome-stable_current_amd64.deb
# extract the same .deb to the path jitsi-bot.js expects (no root needed)
dpkg-deb -x google-chrome-stable_current_amd64.deb chrome/
rm google-chrome-stable_current_amd64.deb
./chrome/opt/google/chrome/chrome --version   # verify the hardcoded path resolves
```

To avoid the system-wide install, extract only and chase the libraries directly:
`ldd ./chrome/opt/google/chrome/chrome | grep 'not found'`.

`bots/chrome/` is gitignored (~250 MB) and must be recreated after cloning.

**The containerized fleet does NOT need any of this.** Bots spawned by the
conductor use Debian's packaged Chromium inside the image
(`docker/Dockerfile.bot`), located via `CHROMIUM_PATH`
(`src/bot/index.js:33`, default `/usr/bin/chromium`). Only running
`jitsi-bot.js` directly on a host needs `bots/chrome/`, so a production bots-VM
deploy can skip it entirely.

### Running strudel-bot (sidecar only)

```bash
# Against the local Docker stack (direct to sidecar port)
node strudel-bot.js --url ws://localhost:32769 --room myroom --pattern 's("bd ~ sd ~")'

# Against a deployed instance (via nginx proxy)
node strudel-bot.js --url wss://trussal.com/ws --room 0 --name "drone"
```

SIGINT sends `stop` and closes cleanly.

### Running jitsi-bot (full Jitsi participant)

```bash
node jitsi-bot.js --room 0 --name "drone" --pattern 's("bd ~ sd ~")'
# custom base URL:
node jitsi-bot.js --url https://trussal.com --room 0 --name "drone"
```

The bot:
1. Launches headless Chrome and navigates to `<url>/<room>#config.prejoinPageEnabled=false&userInfo.displayName=<name>`
2. Joins the Jitsi conference — visible in the participant list and video grid
3. Waits for the Trussal Studio toggle button to appear (confirms `isInMeeting()` is true), then clicks it (user gesture for `AudioContext.resume()`)
4. Dispatches `trussal-kbd-eval` → `studio.js` calls `onEvalAndPlay()`, which sends the pattern to the sidecar and starts Strudel
5. Stays connected until SIGINT (Ctrl+C)

## Peer-state protocol

The sidecar source is `../latency-instrument/server.js`; the browser client side is `../src/peer-state.js`. A bot that wants to play a Strudel pattern:

1. Connect WebSocket to `wss://<host>/ws?room=<name>&role=player`.
2. Server immediately sends `{ type: "welcome", peerId: "<uuid>" }` — this is the bot's assigned ID.
3. Send `{ type: "hello", jitsiId: "<any-string>", displayName: "<name>" }`. Server broadcasts `peer-join` to other clients and replies with the current roster.
4. Send `{ type: "pattern", code: "<strudel-code>" }` to set the pattern.
5. Send `{ type: "play" }` / `{ type: "stop" }` to start/stop.
6. Optionally send `{ type: "metrics", rtt: <ms>, jitter: <ms> }` — these drive the per-peer audio effects that all clients hear.

# Contributing to Trussal

Trussal is a networked algorave platform built on top of Jitsi Meet. It adds a live-coding instrument (Strudel), per-peer audio effects driven by network conditions, facial gesture control, Hydra visual synthesis, and Jamulus integration for low-latency audio. All custom browser code is bundled into a single `custom-config.js` that Jitsi loads on page start.

This guide covers everything you need to go from a fresh clone to deploying a change across the three production VMs.

---

## Repository layout

```
Trussal/
  src/                  browser JS source — one file per feature
  strudel-fork/         vendored Strudel packages (pre-built; see "Strudel fork" below)
  docker-jitsi-meet/    Jitsi Meet Docker stack + Trussal overrides
  latency-instrument/   WebSocket sidecar (Node) — peer state bus
  jamulus-relay/        WebSocket audio bridge for Jamulus → browser
  jamulus/scripts/      Jamulus server setup scripts
  system/               systemd unit files for the audio VM
  bots/                 headless-browser bots + conductor
  custom-config/        Jitsi config overrides (nginx, jicofo, jvb)
  build.mjs             esbuild pipeline
  run.sh                full video-VM redeploy script
  Makefile              SSH deploy targets for all three VMs
```

---

## Three-VM architecture

The platform runs across three VMs. Each is a standalone machine; there is no shared filesystem.

| VM | What it runs | Key entry point |
|---|---|---|
| **video** | Jitsi Meet stack, latency sidecar, jamulus-relay, nginx | `docker-jitsi-meet/docker-compose.yml` |
| **audio** | Jamulus server instances (one per room/port) | `system/jamulus@.service` (systemd template) |
| **bots** | Conductor + up to 10 headless-Chrome bot containers | `bots/docker-compose.yml` |

All three VMs clone this same repo. Deployment pushes changes by SSHing into each VM and running service-specific commands — the `Makefile` at the repo root automates this.

---

## Dev-machine prerequisites

- **Node ≥ 18** and npm
- **Git**
- **SSH access** to all three VMs (key-based; passwords are not supported by the Makefile targets)
- **make** (GNU Make)

You do not need Docker locally. All Docker operations happen on the VMs.

---

## First-time setup

```bash
git clone <repo-url> Trussal
cd Trussal
npm install
```

That installs esbuild and the Strudel peer dependencies. The strudel-fork packages ship pre-built (`strudel-fork/**/dist/` is committed), so a plain `npm install` is enough — you do not need pnpm or a separate build step unless you are changing Strudel itself.

### Configure deploy targets

```bash
cp .env.deploy.example .env.deploy
```

Edit `.env.deploy` and fill in the SSH connection string and repo path for each VM:

```bash
VIDEO_VM=ubuntu@1.2.3.4
AUDIO_VM=ubuntu@5.6.7.8
BOTS_VM=ubuntu@9.10.11.12
REPO_PATH=/home/trussal/Trussal
```

`.env.deploy` is gitignored and never committed.

### First-time VM setup

Each VM needs the repo cloned once and its prerequisites installed. These steps are done once per machine, not on every deploy.

**All VMs:**
```bash
git clone <repo-url> ~/Trussal
```

**Video VM** (docker group membership required for Docker commands without sudo):
```bash
sudo usermod -aG docker $USER   # then log out and back in
cd ~/Trussal/docker-jitsi-meet
cp env.example .env             # fill in PUBLIC_URL, JVB_ADVERTISE_IPS, LETSENCRYPT_EMAIL, etc.
./gen-passwords.sh              # generates XMPP/JVB credentials into .env
docker compose up -d            # first boot
```

**Audio VM** (Jamulus installed as a service):
```bash
cd ~/Trussal/jamulus/scripts
sudo bash setup_repo.sh         # adds the Jamulus apt repo
sudo apt install jamulus-headless
sudo cp ~/Trussal/system/jamulus@.service /etc/systemd/system/
sudo systemctl daemon-reload
# Enable the instance ports you need, e.g.:
sudo systemctl enable --now jamulus@22000 jamulus@22001 jamulus@22002
```

**Bots VM** (Docker + ALSA loopback required):
```bash
sudo modprobe snd-aloop enable=1,1 index=10,11 pcm_substreams=8,8
# Add the above to /etc/modules or a udev rule to survive reboots.

cd ~/Trussal/bots
cp .env.example .env            # fill in JITSI_URL and JAMULUS_SERVER
docker compose --profile build-only build
docker compose up -d conductor
```

---

## Building

```bash
npm run build       # produces dist/custom-config.js
npm run watch       # incremental rebuilds on save
npm run clean       # removes dist/
```

The build pulls `@strudel/web` and `@strudel/soundfonts` from `strudel-fork/` and copies Strudel's SharedWorker asset files into `dist/assets/`. The output is a single ESM bundle.

To set the Jamulus hostname baked into the bundle:
```bash
JAMULUS_HOST=your-jamulus-server.example.com npm run build
```

---

## Deploying

Run from your dev machine after committing and pushing your changes. Each target SSHes into the relevant VM, pulls the latest commit, and restarts the affected services.

```bash
make deploy-video   # rebuild + restart Jitsi stack
make deploy-audio   # update Jamulus unit + restart instances
make deploy-bots    # rebuild bot images + restart conductor
make deploy-all     # all three in sequence
```

### What each target does

**`deploy-video`** — SSHes to the video VM and runs `./run.sh`, which:
1. `npm run clean && npm run deploy:local` — rebuilds `custom-config.js` and copies it into `docker-jitsi-meet/jitsi-web/`
2. Rebuilds the `web` and `latency` Docker images and restarts them
3. Brings the full compose stack back up (`docker compose down && docker compose up -d`)

The `web` and `latency` images are rebuilt without cache on every deploy, so changes to `src/`, `latency-instrument/`, or `jamulus-relay/` are always picked up.

**`deploy-audio`** — SSHes to the audio VM and:
1. Pulls latest from git
2. Copies `system/jamulus@.service` to `/etc/systemd/system/`
3. Reloads systemd and restarts all active `jamulus@*` instances

**`deploy-bots`** — SSHes to the bots VM and:
1. Pulls latest from git
2. Rebuilds both the `conductor` and `trussal-bot` Docker images
3. Restarts the conductor with `docker compose up -d conductor`; the conductor manages the bot containers itself

---

## Environment variables

### Video VM (`docker-jitsi-meet/.env`)

Copy `docker-jitsi-meet/env.example` to `docker-jitsi-meet/.env`. The minimum required fields for Trussal:

| Variable | Purpose |
|---|---|
| `PUBLIC_URL` | Public HTTPS URL of your Jitsi instance, e.g. `https://trussal.com` |
| `JVB_ADVERTISE_IPS` | Public IP(s) of the video VM for WebRTC ICE |
| `LETSENCRYPT_EMAIL` | Email for Let's Encrypt cert auto-renewal |
| `CF_API_TOKEN` | Cloudflare API token for the DDNS updater |
| `JAMULUS_HOST` | Hostname of the audio VM, used by `jamulus-relay` |

Run `./gen-passwords.sh` once to generate XMPP/JVB credentials and append them to `.env`.

### Build-time (`JAMULUS_HOST`)

The Jamulus hostname is also baked into `custom-config.js` at build time via `process.env.JAMULUS_HOST`. On the video VM, set it in the shell before calling `run.sh`, or export it in the VM's `.bashrc`:

```bash
export JAMULUS_HOST=audio.example.com
./run.sh
```

### Bots VM (`bots/.env`)

Copy `bots/.env.example` to `bots/.env`:

| Variable | Purpose |
|---|---|
| `JITSI_URL` | Full URL to the Jitsi room, e.g. `https://trussal.com/0` |
| `JAMULUS_SERVER` | `host:port` of the Jamulus server, e.g. `audio.example.com:22000` |

---

## Working on specific parts

### Browser UI and Strudel patterns (`src/`)

Edit source files under `src/`, then run `npm run watch` for fast incremental builds. The output lands in `dist/custom-config.js`. To test against a running Jitsi instance without a full VM deploy, run `npm run deploy:local` on the video VM directly after pulling your branch.

Key source files and their roles are documented in `CLAUDE.md`.

### Strudel fork (`strudel-fork/`)

The vendored Strudel packages live in `strudel-fork/`. Their built outputs (`dist/`) are committed, so most contributors never need to touch them. If you are changing Strudel itself:

```bash
npm run build:strudel-fork   # requires Node ≥ 18; fetches pnpm@8 automatically
npm run build                # rebuild custom-config.js against the new strudel dist
```

Commit the updated `strudel-fork/**/dist/` files alongside your source changes.

### Latency sidecar (`latency-instrument/`)

`latency-instrument/server.js` is the WebSocket peer-state bus. It runs as the `latency` Docker service on the video VM. Changes here are picked up by `make deploy-video` (the latency image is rebuilt without cache).

The protocol: browser clients and bots connect at `wss://<host>/ws?room=<name>&role=player`. After a `welcome` → `hello` handshake, clients exchange `pattern`, `play`, `stop`, and `metrics` messages that are fanned out to every peer in the same room.

### Bots (`bots/`)

The bots stack has its own test suite (45 unit tests, no Docker or Chrome required):

```bash
cd bots
npm test                            # all tests
node --test test/orchestrator.test.js   # single suite
```

See `bots/CLAUDE.md` for the full bot architecture, the peer-state protocol, and first-time Chrome installation instructions.

### Jamulus / audio VM

The audio VM runs one `jamulus-headless` process per room port via `system/jamulus@.service`. To add or remove room ports, enable/disable the corresponding systemd instance:

```bash
sudo systemctl enable --now jamulus@22003
sudo systemctl disable --now jamulus@22003
```

`jamulus/scripts/` contains helper scripts for enabling/disabling port ranges in the firewall.

---

## MCP observer (LLM tool access to all three VMs)

`mcp-observer/` is an MCP server that gives Claude (or any MCP-capable LLM) live read access to all three VMs simultaneously. It maintains a persistent WebSocket connection to the peer-state bus, polls the conductor admin API, and can SSH into each VM for health checks — all exposed as tools the LLM can call in a single session.

### Setup

```bash
cd mcp-observer
npm install
cp .env.example .env
```

Edit `.env` with your VM addresses. The minimum required fields are `VIDEO_WS_URL` and `BOTS_ADMIN_URL`; the `*_VM_SSH` fields are optional and only needed for `check_vm_health`.

### Register with Claude Code

```bash
claude mcp add trussal-observer -- node /absolute/path/to/Trussal/mcp-observer/server.js
```

Or add to your project's `.claude/settings.json`:

```json
{
  "mcpServers": {
    "trussal-observer": {
      "command": "node",
      "args": ["/absolute/path/to/Trussal/mcp-observer/server.js"]
    }
  }
}
```

Environment variables from `.env` are loaded automatically from the script's own directory, so you do not need to inline them in the settings entry.

### Available tools

| Tool | What it returns |
|---|---|
| `get_peer_state(room?)` | Every peer's pattern, play state, effects, RTT, jitter — from the live WebSocket buffer |
| `list_rooms()` | All observed rooms with peer counts and play counts |
| `get_recent_events(room?, type?, limit?)` | Last N events (pattern changes, play/stop, joins/leaves, metrics) |
| `get_bot_metrics()` | Per-bot Strudel script, start time, and last health metrics (FPS, RAM, latency) |
| `get_conductor_config()` | Conductor's active config: maxBots, roles, thresholds, Jitsi URL |
| `check_vm_health(vm)` | SSH health check: service status, disk, memory for `video`, `audio`, or `bots` |

### Notes

- The observer joins as a passive peer (`displayName: "[MCP Observer]"`); it appears in peer rosters but never sends patterns or plays audio.
- Rooms in `OBSERVE_ROOMS` are tracked persistently with auto-reconnect. Rooms outside that list return an error from `get_peer_state` until added to the env var.
- The event buffer holds the last 300 state changes. Use `get_recent_events` to correlate what happened across peers — e.g., which peer's pattern changed right before a bot was replaced.

---

## Commit and PR conventions

- Keep commits focused: one logical change per commit.
- The `dist/` directory is gitignored, but `strudel-fork/**/dist/` is committed. Only include Strudel dist changes if you actually modified the Strudel source.
- `.env`, `.env.deploy`, and any `*.key`/`*.pem` files are gitignored — do not commit secrets.

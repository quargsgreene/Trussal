#!/usr/bin/env bash
#
# One-time local dev bootstrap (idempotent — safe to re-run). Configures the
# bundled docker-jitsi-meet stack to run a FULL Trussal deployment on this one
# machine — no video/audio/bot VM access needed (the old Jamulus `audio` VM is
# gone; audio now lives entirely inside the conference).
#
# Everything here is user-space: a repo-local config tree, a repo-local .env, a
# generated compose override, and Docker containers we can tear down again. It
# never touches the host itself — no sudo, no kernel modules (snd-aloop etc.),
# no system services, no cron, no package installs, no writes outside the repo.
#
#   npm run dev:setup     # this script
#   npm run dev           # build + start + watch
#   npm run dev:down      # stop/remove the containers
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DJM="$REPO/docker-jitsi-meet"
ENV_FILE="$DJM/.env"
OVERRIDE_FILE="$DJM/docker-compose.override.yml"
# Repo-local config tree (gitignored). Kept under docker-jitsi-meet so compose
# resolves the relative CONFIG path against the compose project directory.
CFG="$DJM/.jitsi-meet-cfg"

# Marker delimiters the generated block is written between. On a re-run we
# replace everything from the marker to EOF, so changing a DEV_* value below is
# honoured without touching anything else in the file.
MARKER="# --- Trussal local-dev overrides (scripts/dev-setup.sh) ---"

# Host ports the dev stack publishes on. Deliberately non-privileged and NOT the
# production 80/443/10000: a real deployment (or another checkout) may already
# hold those, and this stack must be able to run alongside it undisturbed.
DEV_HTTPS_PORT="${DEV_HTTPS_PORT:-8443}"
# Plain-HTTP port, for the bots. Bots join via http://localhost:<port> so every
# URL they derive (their own page, the /ws sidecar, /o2, XMPP) is plain http/ws:
# no self-signed certificate has to be trusted anywhere in the fleet. This is
# safe because http://localhost is a secure context in every browser, so WebRTC
# (getUserMedia) is still available. Humans keep using HTTPS above.
DEV_HTTP_PORT="${DEV_HTTP_PORT:-8000}"
DEV_JVB_PORT="${DEV_JVB_PORT:-10001}"
DEV_JVB_COLIBRI_PORT="${DEV_JVB_COLIBRI_PORT:-8085}"

log() { printf '[dev-setup] %s\n' "$*"; }
die() { printf '[dev-setup] FATAL: %s\n' "$*" >&2; exit 1; }

# --- 0. Preflight --------------------------------------------------------------
command -v docker >/dev/null || die "docker not found on PATH"
docker info >/dev/null 2>&1 || die "cannot talk to the Docker daemon (is it running? are you in the docker group?)"
command -v node >/dev/null || die "node not found on PATH"
command -v npm >/dev/null || die "npm not found on PATH"
command -v openssl >/dev/null || die "openssl not found on PATH (gen-passwords.sh needs it)"

# --- 1. docker-jitsi-meet/.env -------------------------------------------------
OWNS_ENV=0
if [ ! -f "$ENV_FILE" ]; then
	log "creating $ENV_FILE from env.example"
	cp "$DJM/env.example" "$ENV_FILE"
	sed -i 's#^CONFIG=.*#CONFIG=./.jitsi-meet-cfg#' "$ENV_FILE"
	# The template ships the component passwords empty; fill them in.
	bash "$DJM/gen-passwords.sh"
	OWNS_ENV=1
elif grep -qF "$MARKER" "$ENV_FILE"; then
	log "$ENV_FILE already managed by dev-setup — refreshing the dev block"
	OWNS_ENV=1
else
	log "WARNING: $ENV_FILE exists and was not created by dev-setup; leaving it as-is"
	log "         Point ${ENV_FILE}.bak aside and re-run to get a managed dev .env."
fi

# The fleet control-channel secret, shared by the latency sidecar (which gates
# room discovery on it) and the bots conductor (bots/.env FLEET_CONTROL_TOKEN,
# written below). Read before the managed block is rewritten so an existing
# value always survives a re-run: if the two sides ever drift apart, room
# discovery fails CLOSED and no aggregator ever spawns — the exact silent
# failure this file pair exists to prevent.
CONTROL_TOKEN="$(sed -n 's/^SIDECAR_CONTROL_TOKEN=//p' "$ENV_FILE" | tail -n1)"
if [ -z "$CONTROL_TOKEN" ]; then
	log "generating SIDECAR_CONTROL_TOKEN (fleet room discovery)"
	CONTROL_TOKEN="$(openssl rand -hex 32)"
fi

if [ "$OWNS_ENV" -eq 1 ]; then
	# Drop a previous generated block (it is always appended last), then write a
	# fresh one with the current DEV_* values so re-runs stay consistent.
	sed -i "/^${MARKER//\//\\/}\$/,\$d" "$ENV_FILE"
	sed -i 's#^CONFIG=.*#CONFIG=./.jitsi-meet-cfg#' "$ENV_FILE"
	cat >>"$ENV_FILE" <<EOF

$MARKER
# A distinct Compose project keeps this stack's containers, network and images
# from colliding with a real deployment (or another checkout) that also uses
# docker-jitsi-meet/ as its project directory.
COMPOSE_PROJECT_NAME=trussal-dev

# HTTPS with the locally trusted dev certificate: scripts/dev-certs.sh
# generates a localhost cert and the override below mounts it into web,
# replacing the image's own self-signed default that every browser flags.
# Browsers expose getUserMedia (camera/mic) only in a secure context;
# http://localhost counts as secure in Chrome/Firefox, but
# docker-jitsi-meet's config template derives its BOSH/WS URLs by trimming
# only an "https://" prefix, so a plain-http PUBLIC_URL yields
# 'https://http://host/...' and signalling breaks. Use HTTPS on a free port.
PUBLIC_URL=https://localhost:${DEV_HTTPS_PORT}
ENABLE_LETSENCRYPT=0

# Don't restart-loop a broken dev container; a failed start should stay failed
# and visible in 'docker compose logs'.
RESTART_POLICY=no

# JVB_ADVERTISE_IPS=127.0.0.1 is required, not cosmetic. With it unset, JVB
# STUN-discovers this machine's public-facing IP and offers only that as a media
# candidate; a browser on the SAME machine then needs NAT hairpinning to reach
# it (usually unsupported), ICE fails, and Jitsi tears the room down right after
# join — the meeting "connects" then drops instantly. jvb's UDP port is
# published on all host interfaces, so 127.0.0.1 is always reachable locally.
JVB_ADVERTISE_IPS=127.0.0.1

# Keep the bridge's ports off the production defaults (10000/udp and 8080) so a
# real deployment can hold those simultaneously.
JVB_PORT=${DEV_JVB_PORT}
JVB_COLIBRI_PORT=${DEV_JVB_COLIBRI_PORT}

# No coturn/ddns: everything is on one host, so there is nothing to relay or to
# publish in DNS. (They are also behind the 'local-turn' profile, which this
# flow never activates.)

# Shared secret for the sidecar's control channel. It lists every live meeting
# to the bots conductor (room discovery) and fails CLOSED without it: no token
# or a token that disagrees with bots/.env FLEET_CONTROL_TOKEN means room
# discovery is refused and NO aggregator ever spawns, with no other symptom.
# dev-setup writes both sides; don't change one without the other.
SIDECAR_CONTROL_TOKEN=${CONTROL_TOKEN}
EOF

	EFFECTIVE_HTTPS_PORT="$DEV_HTTPS_PORT"
else
	# Respect a hand-maintained .env: derive the published port from its
	# PUBLIC_URL so the override matches, and never activate the LE/coturn paths
	# that would reach out to the network.
	url="$(sed -n 's/^PUBLIC_URL=//p' "$ENV_FILE" | tail -n1)"
	EFFECTIVE_HTTPS_PORT="$(printf '%s' "$url" | sed -n 's#^https\{0,1\}://[^:/]*:\([0-9]\{1,\}\).*#\1#p')"
	EFFECTIVE_HTTPS_PORT="${EFFECTIVE_HTTPS_PORT:-8443}"
	log "using PUBLIC_URL=https://localhost:${EFFECTIVE_HTTPS_PORT} from $ENV_FILE"
fi
EFFECTIVE_HTTP_PORT="$DEV_HTTP_PORT"

if [ "$OWNS_ENV" -eq 0 ] && ! grep -q '^SIDECAR_CONTROL_TOKEN=..*' "$ENV_FILE"; then
	log "adding SIDECAR_CONTROL_TOKEN to the hand-maintained $ENV_FILE"
	printf '\n# Added by scripts/dev-setup.sh: fleet room discovery (no aggregator spawns without it).\nSIDECAR_CONTROL_TOKEN=%s\n' "$CONTROL_TOKEN" >>"$ENV_FILE"
fi

# --- 2. Port preflight ---------------------------------------------------------
# Only worth checking while nothing of ours is up: on a re-run the (still
# running) dev stack legitimately holds these ports.
ours_up() { docker ps --filter "label=com.docker.compose.project=trussal-dev" --format '{{.Names}}' 2>/dev/null | grep -q .; }
port_in_use() {
	local port="$1"
	if command -v ss >/dev/null 2>&1; then ss -ltn "sport = :$port" 2>/dev/null | grep -q LISTEN
	elif command -v lsof >/dev/null 2>&1; then lsof -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
	else return 1; fi
}
if ! ours_up; then
	for p in "$EFFECTIVE_HTTPS_PORT" "$EFFECTIVE_HTTP_PORT" "$DEV_JVB_COLIBRI_PORT"; do
		port_in_use "$p" && die "host port $p is already in use — set DEV_HTTPS_PORT / DEV_HTTP_PORT / DEV_JVB_COLIBRI_PORT to free ports and re-run"
	done
fi

# --- 3. Generated compose override --------------------------------------------
# web's ports are hardcoded to 80/443 in docker-compose.yml. Compose CONCATENATES
# port lists across files, so an additive override would still try to bind 80
# and collide with a running deployment; `!override` replaces the list instead
# (needs Compose >= 2.24). jvb's ports are already env-driven, so only web needs
# this. Regenerated every run so port changes take effect.
log "writing $OVERRIDE_FILE (web -> ${EFFECTIVE_HTTPS_PORT}:443, ${EFFECTIVE_HTTP_PORT}:80)"
cat >"$OVERRIDE_FILE" <<EOF
# GENERATED by scripts/dev-setup.sh — local dev only, safe to delete.
# Compose auto-loads this file; docker-jitsi-meet/.gitignore keeps it out of git.
services:
  web:
    # HTTPS is the human entry point; the plain-HTTP port exists for the bots,
    # which join via http://localhost:${EFFECTIVE_HTTP_PORT} so every URL they
    # derive (the page itself, /ws, /o2, XMPP) is plain http/ws — no
    # self-signed certificate has to be trusted anywhere in the fleet.
    # http://localhost still counts as a secure context, so WebRTC works there.
    ports: !override
      - "${EFFECTIVE_HTTPS_PORT}:443"
      - "${EFFECTIVE_HTTP_PORT}:80"
    volumes:
      # Locally trusted localhost certificate (scripts/dev-certs.sh), mounted
      # over the self-signed pair the image would otherwise generate on first
      # boot — that default is what browsers flag as "not private". The CONFIG
      # variable comes from this directory's .env.
      - \${CONFIG}/dev-certs/cert.crt:/config/keys/cert.crt:ro,Z
      - \${CONFIG}/dev-certs/cert.key:/config/keys/cert.key:ro,Z
EOF

# --- 4. Config tree ------------------------------------------------------------
# The web service bind-mounts individual files/dirs under CONFIG. If a bind
# source is missing, Docker silently creates it as a root-owned DIRECTORY, which
# then breaks nginx (a "file" that is really a directory). Seed them explicitly;
# the base image regenerates the rest of the localhost config on first boot.
log "seeding config tree at $CFG"
mkdir -p \
	"$CFG/web/nginx" "$CFG/web/crontabs" "$CFG/web/load-test" "$CFG/web/letsencrypt" \
	"$CFG/transcripts" \
	"$CFG/prosody/config" "$CFG/prosody/prosody-plugins-custom" \
	"$CFG/jicofo" "$CFG/jvb"

# The Trussal nginx routes (/css/src for the live modules, ^~/assets for
# Strudel's SharedWorker) live in the tracked custom-config seed. Without them
# the bundle's assets are served as text/html and no pattern ever ticks.
cp "$REPO/custom-config/web/nginx/custom-routes.conf" "$CFG/web/nginx/custom-routes.conf"

# --- 4b. Dev TLS certificate ---------------------------------------------------
# HTTPS is the human entry point, and the web image only ships a self-signed
# certificate — the "not private" warning. dev-certs.sh generates a localhost
# certificate signed by a repo-local CA and installs that CA into this user's
# Chrome/Firefox trust stores; the override above mounts the pair into web.
# Must run before the first `docker compose up` (see `npm run dev`): Docker
# creates a DIRECTORY for a missing bind-mount source, which then breaks nginx.
log "ensuring the local dev TLS certificate"
bash "$REPO/scripts/dev-certs.sh"

# --- 5. Bundle -----------------------------------------------------------------
# The web image COPYs custom-config.js + assets at build time, so they must
# exist before the first `docker compose build`.
log "building custom-config.js"
( cd "$REPO" && node build.mjs --deploy )

# --- 6. Bots fleet (conductor: aggregator + players) ---------------------------
# The conductor is the orchestrator that watches room activity over the
# sidecar's control channel. It spawns ONE aggregator per active room — the
# aggregator taps every participant's audio inside its own page and streams
# the assembled mix back — plus the player clusters the studio's Spawn button
# asks for. No bot needs host audio: each publishes through its own in-page
# tap, and where the production snd-aloop cards are absent the entrypoint
# falls back to a silent null ALSA device instead of a real card, so the whole
# fleet runs on this one machine.
BOTS_DIR="$REPO/bots"
BOTS_ENV="$BOTS_DIR/.env"
BOTS_OVERRIDE="$BOTS_DIR/docker-compose.override.yml"
BOTS_MARKER="# --- Trussal local-dev overrides (scripts/dev-setup.sh) ---"

# The sidecar runs on the dev stack's own compose network; attaching the
# conductor there lets it discover rooms via `latency` by service name over
# plain ws (no TLS certificates involved). Derived from the dev project name so
# the two can never drift apart.
DEV_PROJECT="$(sed -n 's/^COMPOSE_PROJECT_NAME=//p' "$ENV_FILE" | tail -n1)"
DEV_PROJECT="${DEV_PROJECT:-trussal-dev}"

OWNS_BOTS_ENV=0
if [ ! -f "$BOTS_ENV" ]; then
	log "creating $BOTS_ENV"
	OWNS_BOTS_ENV=1
elif grep -qF "$BOTS_MARKER" "$BOTS_ENV"; then
	log "$BOTS_ENV already managed by dev-setup — refreshing"
	OWNS_BOTS_ENV=1
else
	log "WARNING: $BOTS_ENV exists and was not created by dev-setup; leaving it as-is"
fi

if [ "$OWNS_BOTS_ENV" -eq 1 ]; then
	# Drop a previous generated block (always appended last), then write a fresh
	# one. A brand-new file has nothing to drop.
	[ -f "$BOTS_ENV" ] && sed -i "/^${BOTS_MARKER//\//\\/}\$/,\$d" "$BOTS_ENV"
	cat >>"$BOTS_ENV" <<EOF
$BOTS_MARKER
# compose-level variables for bots/docker-compose.yml. The conductor must join
# the peer-state sidecar bus to discover rooms at all.
#
# Plain http on the dev stack's published HTTP port: tokens derived from it
# (/ws, /o2, the page itself) are all plain ws/http, so nothing in the fleet
# has to trust the dev stack's HTTPS certificate. The "/0" is only a
# template — the conductor rewrites the room segment per meeting.
JITSI_URL=http://localhost:${EFFECTIVE_HTTP_PORT}/0

# Sidecar's per-room bus, addressed by SERVICE NAME over the dev stack's own
# network (see docker-compose.override.yml). Room discovery is gated on the
# control token below; with no token, or one that disagrees with
# docker-jitsi-meet/.env SIDECAR_CONTROL_TOKEN, the relay refuses discovery
# and NO aggregator ever spawns (fail closed, nothing else reports it).
SIDECAR_WS_URL=ws://latency:8081/ws
FLEET_CONTROL_TOKEN=${CONTROL_TOKEN}
EOF
fi

log "writing $BOTS_OVERRIDE (conductor -> ${DEV_PROJECT}_meet.jitsi)"
cat >"$BOTS_OVERRIDE" <<EOF
# GENERATED by scripts/dev-setup.sh — local dev only, safe to delete.
# Compose auto-loads this file next to bots/docker-compose.yml.
#
# Attach the conductor to the dev stack's own network so it reaches the latency
# sidecar by service name (ws://latency:8081/ws — plain ws, so the dev stack's
# HTTPS certificate is irrelevant here). It is the conductor's ONLY network:
# the bot containers it spawns run with host networking and reach both it
# (localhost:7700) and the dev stack (http://localhost:${EFFECTIVE_HTTP_PORT})
# directly.
services:
  conductor:
    networks:
      - dev-fleet
networks:
  dev-fleet:
    external: true
    name: ${DEV_PROJECT}_meet.jitsi
EOF

cat <<EOF

[dev-setup] done.

  Start the dev stack:   npm run dev
  Then open:             https://localhost:${EFFECTIVE_HTTPS_PORT}/<any-room-name>
                         (certificate already trusted — no warning; restart a
                         browser that was already running when this setup ran)

  Bots: each room gets an "Aggregator" a few seconds after a human joins it,
  and the studio's Spawn button grows player-bot clusters ("Tyrolean Hound",
  …) that play into the room through their in-page audio tap. Both are reaped
  a few seconds after the last human leaves; no host audio device is used.

  Tear it down with:     npm run dev:down

  Two tabs (or two browser profiles) exercise multi-participant behaviour.

EOF

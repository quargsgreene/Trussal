#!/bin/bash
set -e
REPO=$(cd "$(dirname "$0")" && pwd)
cd "$REPO"

#  check for secrets
DJM="$REPO/docker-jitsi-meet"
ENV_FILE="$DJM/.env"

[ -f "$ENV_FILE" ] || { echo "FATAL: $ENV_FILE missing"; exit 1; }
[ -s "$ENV_FILE" ] || { echo "FATAL: $ENV_FILE is 0 bytes"; exit 1; }

CONFIG=$(sed -n 's/^CONFIG=//p' "$ENV_FILE" | tail -n1)
[ -n "$CONFIG" ] || { echo "FATAL: CONFIG unset/empty — every \${CONFIG} bind resolves to /"; exit 1; }
case "$CONFIG" in '~'*) echo "FATAL: CONFIG starts with '~'; compose does not expand it"; exit 1;; esac

# compose resolves relative bind paths against the project directory
CFG_REAL=$(cd "$DJM" && realpath -m "$CONFIG")
REPO_REAL=$(realpath "$REPO")

case "$CFG_REAL/" in "$REPO_REAL"/*)
  echo "FATAL: CONFIG resolves inside the repo"
  echo "  CONFIG   = $CONFIG"
  echo "  resolves = $CFG_REAL"
  echo "  repo     = $REPO_REAL"
  echo "Runtime secrets would land in a tracked tree. Point CONFIG outside"
  echo "the work tree and seed it (see scripts/dev-setup.sh)."
  exit 1;; esac

[ -d "$CFG_REAL" ] || { echo "FATAL: CONFIG dir missing: $CFG_REAL"; exit 1; }
[ -f "$CFG_REAL/web/body.html" ] || { echo "FATAL: $CFG_REAL/web/body.html missing or icate a directory and web will fail to start"; exit 1; }

echo "CONFIG OK: $CFG_REAL"

# `npm ci` below replaces node_modules wholesale. A Vite dev server or the
# build watcher already running from this checkout would lose those files out
# from under it (Vite starts returning empty replies; the esbuild watcher can
# no longer rebuild), so refuse instead of breaking the live session. This is
# a no-op for the normal `make deploy-all`, which runs this script on the video
# VM, where neither process exists.
if command -v pgrep >/dev/null 2>&1; then
  live_pid=""
  live_pattern=""
  for pattern in \
    "node_modules/vite/bin/vite.js" \
    "node_modules/.bin/vite" \
    "build.mjs --watch"; do
    for pid in $(pgrep -f -- "$pattern" 2>/dev/null || true); do
      [ "$pid" = "$$" ] && continue
      # Match this checkout only: `npm run watch` starts `node build.mjs` with
      # a relative path, so the command line alone cannot identify the repo.
      [ "$(readlink "/proc/$pid/cwd" 2>/dev/null || true)" = "$REPO_REAL" ] || continue
      live_pid="$pid"
      live_pattern="$pattern"
      break 2
    done
  done
  if [ -n "$live_pid" ]; then
    echo "FATAL: a dev/build process is running from this checkout:"
    echo "  pid $live_pid — $live_pattern"
    echo "  npm ci would replace its node_modules underneath it."
    echo "  Stop the dev session first (npm run dev:down), then re-run the deploy."
    exit 1
  fi
fi

# EDGE_MODE=shard: this host is one shard of a rack behind the edge LB
# (edge/README.md), so the DNS updater and the TURN relay run once on the edge,
# not here. Anything else (unset / "standalone") is the single-box / full-stack
# deploy — activate the `local-turn` compose profile so coturn + ddns come up
# exactly as before. Every `docker compose` call below inherits COMPOSE_PROFILES.
EDGE_MODE=$(sed -n 's/^EDGE_MODE=//p' "$ENV_FILE" | tail -n1)
if [ "$EDGE_MODE" = "shard" ]; then
  echo "EDGE_MODE=shard — coturn + ddns come from the edge host, not this shard"
else
  export COMPOSE_PROFILES="${COMPOSE_PROFILES:+$COMPOSE_PROFILES,}local-turn"
  echo "COMPOSE_PROFILES=$COMPOSE_PROFILES (coturn + ddns run here)"
fi

# The runtime CONFIG tree is created once and is gitignored, so nginx routes
# added in later commits never reach it on their own. Without this sync,
# /about and /documentation fall through meet.conf's room catch-all and open a
# prejoin for a room named "about"/"documentation" instead of the static pages.
# scripts/dev.sh performs the same copy for the local stack.
NGINX_CFG_DIR="$CFG_REAL/web/nginx"
mkdir -p "$NGINX_CFG_DIR"
cp "$REPO/custom-config/web/nginx/custom-routes.conf" "$NGINX_CFG_DIR/custom-routes.conf"
echo "Synced nginx routes: $NGINX_CFG_DIR/custom-routes.conf"

# Repair prosody's /config ownership. The image only ever fixes this on a FIRST
# run, because its cont-init guard keys off the top-level dir:
#
#   if [[ ! -d /config/data ]]; then mkdir -pm 750 /config/data; fi   # root:root
#   if [[ "$(stat -c %U /config)" != "prosody" ]]; then chown -R prosody /config; fi
#
# Once /config is prosody-owned that second line never fires again, so anything
# root writes inside it afterwards — a regenerated cert, a recreated data/ —
# stays root-owned and unreadable by the prosody user. Prosody then dies at
# startup ("Couldn't write pidfile" / "No TLS context available for c2s") while
# the container still reports "Up", jicofo and jvb cannot reach 5222, and nginx
# answers 502 on /xmpp-websocket. The failure looks like an auth or Cloudflare
# problem and is not; it cost a full debugging session on 2026-07-29.
#
# Done in a throwaway container so it needs no host sudo, and resolves the user
# by name inside the image rather than hardcoding uid 100. Fatal on failure:
# continuing here just deploys a prosody that will 502 every join.
PROSODY_CFG_DIR="$CFG_REAL/prosody/config"
if [ -d "$PROSODY_CFG_DIR" ]; then
  JITSI_TAG=$(sed -n 's/^JITSI_IMAGE_VERSION=//p' "$ENV_FILE" | tail -n1)
  JITSI_TAG=${JITSI_TAG:-stable-11031}
  echo "Repairing prosody /config ownership (jitsi/prosody:$JITSI_TAG)…"
  docker run --rm -u 0 -v "$PROSODY_CFG_DIR:/config" \
    --entrypoint sh "jitsi/prosody:$JITSI_TAG" \
    -c 'chown -R prosody /config' \
    || { echo "FATAL: prosody /config chown failed; deploying now would 502 on /xmpp-websocket"; exit 1; }
fi

# Install deps to match the committed lockfile before building. `npm ci` reads
# (never writes) package-lock.json, so it won't dirty the working tree for the
# next `git pull --ff-only`, and it installs newly-added deps (e.g. yjs) that a
# plain `git pull` leaves absent from node_modules. --include=dev keeps esbuild
# et al. even if NODE_ENV=production on the host.
# The web container bind-mounts this path; if it was removed while a container
# was running, Docker recreates it as a DIRECTORY, which then blocks the
# `cp dist/custom-config.js ...` below ("cannot overwrite directory with
# non-directory"). Clear any stale file or directory before (re)building so a
# fresh bundle can always land.
rm -rf docker-jitsi-meet/jitsi-web/custom-config.js docker-jitsi-meet/jitsi-web/custom-config.css
npm ci --include=dev
npm run clean
npm run deploy:local

# Stamp the static-asset `?v=` from the commit, not the wall clock, so a rack's
# shards that build the same commit serve byte-identical files at identical URLs
# (see jitsi-web/Dockerfile). `-dirty` if the tree carries uncommitted changes.
# export ASSET_VERSION="$(git -C "$REPO" rev-parse --short=12 HEAD 2>/dev/null || true)"
# [ -n "$ASSET_VERSION" ] && ! git -C "$REPO" diff --quiet 2>/dev/null && ASSET_VERSION="${ASSET_VERSION}-dirty"
# echo "ASSET_VERSION=${ASSET_VERSION:-<none, will use build timestamp>}"
ASSET_VERSION="cc-$(cat docker-jitsi-meet/jitsi-web/custom-config.js docker-jitsi-meet/jitsi-web/custom-config.css | sha256sum | cut -c1-12)"
export ASSET_VERSION

cd "$REPO/docker-jitsi-meet"
docker compose build --no-cache web && docker compose rm -sf web && docker compose up -d web
docker compose build --no-cache latency && docker compose rm -sf latency && docker compose up -d latency
docker compose down && docker compose up -d

# Keep coturn's TURN_EXTERNAL_IP self-healing on this dynamic/residential WAN
# IP (see scripts/refresh-turn-external-ip.sh for why coturn can't just resolve
# a hostname itself). No root on this box, so cron rather than a systemd timer.
# Idempotent: drop any prior entry for this script before re-adding it, so a
# moved checkout doesn't leave a stale path running alongside the new one.
# Skipped on a shard — its coturn is inactive; the edge host runs this instead
# (make deploy-edge). Drop any stale entry there too.
REFRESH_TURN_SCRIPT="$REPO/scripts/refresh-turn-external-ip.sh"
if [ "$EDGE_MODE" = "shard" ]; then
  ( crontab -l 2>/dev/null | grep -vF "refresh-turn-external-ip.sh" ) | crontab - || true
  echo "EDGE_MODE=shard — TURN_EXTERNAL_IP refresh cron not installed here"
else
  REFRESH_TURN_CRON="*/5 * * * * $REFRESH_TURN_SCRIPT >> \$HOME/turn-ip-refresh.log 2>&1"
  ( crontab -l 2>/dev/null | grep -vF "refresh-turn-external-ip.sh"; echo "$REFRESH_TURN_CRON" ) | crontab -
  echo "Installed cron: $REFRESH_TURN_CRON"
  "$REFRESH_TURN_SCRIPT"
fi

# Fleet control-channel secret, checked LAST so it lands at the bottom of the
# screen rather than under a full docker build, and after the stack is up so it
# can read the value the fresh container actually got.
bash "$REPO/scripts/check-control-token.sh" video \
  || echo "WARNING: deploy finished, but fleet room discovery is off — no aggregator will spawn."

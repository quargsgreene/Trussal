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

# Install deps to match the committed lockfile before building. `npm ci` reads
# (never writes) package-lock.json, so it won't dirty the working tree for the
# next `git pull --ff-only`, and it installs newly-added deps (e.g. yjs) that a
# plain `git pull` leaves absent from node_modules. --include=dev keeps esbuild
# et al. even if NODE_ENV=production on the host.
npm ci --include=dev
npm run clean
npm run deploy:local
cd "$REPO/docker-jitsi-meet"
docker compose build --no-cache web && docker compose rm -sf web && docker compose up -d web
docker compose build --no-cache latency && docker compose rm -sf latency && docker compose up -d latency
docker compose down && docker compose up -d

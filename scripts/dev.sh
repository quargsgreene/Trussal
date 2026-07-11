#!/usr/bin/env bash
#
# Local dev server. Brings up a minimal Trussal Jitsi stack on this laptop and
# watches src/ — on every save it rebuilds custom-config.js and copies it into
# the container's bind mount, so you just hard-refresh the browser to test.
#
# Run scripts/dev-setup.sh once first (npm run dev:setup).
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DJM="$REPO/docker-jitsi-meet"

[ -f "$DJM/.env" ] || { echo "No docker-jitsi-meet/.env — run: npm run dev:setup" >&2; exit 1; }

# Only the services needed to serve the app + signalling. Skips ddns and
# jamulus-relay (the latter needs a real Jamulus host and isn't required to
# exercise the browser code).
SERVICES="web prosody jicofo jvb latency"

echo "[dev] building bundle + seeding jitsi-web/"
( cd "$REPO" && node build.mjs --deploy )

echo "[dev] starting Docker stack: $SERVICES"
( cd "$DJM" && docker compose up -d --build $SERVICES )

cat <<EOF

  Trussal dev stack is up.
    App:       http://localhost/<any-room-name>
    Signalling: /ws + /o2 proxied to the latency container

  Watching src/ — edit, save, then hard-refresh the browser (Ctrl-Shift-R) to
  pick up the rebuilt bundle. Container config (env/nginx) changes still need a
  restart: npm run dev:down && npm run dev.

  Ctrl-C stops the watcher (containers keep running).
  Tear the stack down with: npm run dev:down

EOF

exec node "$REPO/build.mjs" --watch --deploy

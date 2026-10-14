#!/usr/bin/env bash
#
# Tear down the local dev Jitsi stack (containers only — the config tree and
# .env are left in place so `npm run dev` comes straight back up).
#
set -euo pipefail

DJM="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/docker-jitsi-meet"
cd "$DJM"
docker compose down

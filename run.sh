#!/bin/bash
set -e
REPO=$(cd "$(dirname "$0")" && pwd)
cd "$REPO"
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

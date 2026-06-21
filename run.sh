#!/bin/bash
set -e
REPO=$(cd "$(dirname "$0")" && pwd)
cd "$REPO"
npm run clean
npm run deploy:local
cd "$REPO/docker-jitsi-meet"
docker compose build --no-cache web && docker compose rm -sf web && docker compose up -d web
docker compose build --no-cache latency && docker compose rm -sf latency && docker compose up -d latency
docker compose down && docker compose up -d

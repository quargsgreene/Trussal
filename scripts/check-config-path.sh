#!/usr/bin/env bash
# Refuse to start if CONFIG would put container-written runtime state
# (acme.sh private keys, rendered jicofo/jvb configs carrying live XMPP
# passwords, prosody's account store) inside the git work tree. That
# layout is how the 2026-05 secret leak happened.
set -euo pipefail

REPO=$(git rev-parse --show-toplevel)
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

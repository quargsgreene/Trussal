#!/usr/bin/env bash
#
# Preflight for the fleet control-channel shared secret.
#
# Room discovery — and therefore EVERY aggregator — is gated on one secret that
# must hold the same value in two gitignored files on two different VMs:
#
#   video VM   docker-jitsi-meet/.env   SIDECAR_CONTROL_TOKEN
#   bots  VM   bots/.env                FLEET_CONTROL_TOKEN
#
# Neither file is in git, so no deploy can install them, and both compose files
# default the variable to EMPTY (`${VAR:-}`) rather than failing. An absent or
# mismatched pair therefore produces no error anywhere: the relay fails closed
# exactly as designed, and the only symptom is that no aggregator ever appears
# in any room. This makes that state visible where you are already looking.
#
# Usage:  scripts/check-control-token.sh video|bots
#
# Checks the token TWICE, because they fail differently:
#   * configured — what the .env holds, i.e. what the next container will get.
#   * effective  — what the RUNNING container actually holds. Container env is
#                  fixed at create time, so an .env edited and then followed by
#                  `docker compose restart` (which does not re-read .env) leaves
#                  the old value live. That reads as "I set it and it still
#                  doesn't work" and is invisible from the file alone.
#
# On success prints `FINGERPRINT <sha12>` on stdout — a sha256 prefix, never the
# secret — so `make check-tokens` can compare the two VMs without either value
# leaving its host. Human-readable diagnosis goes to stderr.
#
# Exit 0 = a non-empty token is in effect. Exit 1 = it is not, or the running
# container disagrees with the file. Exit 2 = bad usage.
#
set -uo pipefail

SIDE="${1:-}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$SIDE" in
  video)
    ENV_FILE="$REPO/docker-jitsi-meet/.env"; KEY=SIDECAR_CONTROL_TOKEN
    COMPOSE_DIR="$REPO/docker-jitsi-meet";   SERVICE=latency
    PEER="bots/.env's FLEET_CONTROL_TOKEN on the bots VM" ;;
  bots)
    ENV_FILE="$REPO/bots/.env";              KEY=FLEET_CONTROL_TOKEN
    COMPOSE_DIR="$REPO/bots";                SERVICE=conductor
    PEER="docker-jitsi-meet/.env's SIDECAR_CONTROL_TOKEN on the video VM" ;;
  *)
    echo "usage: $(basename "$0") video|bots" >&2
    exit 2 ;;
esac

# A sha256 prefix. Safe to print and to ship between hosts: it identifies the
# token well enough to tell "these two agree" from "these two don't", and a
# 32-byte random secret is not recoverable from it.
fingerprint() { printf %s "$1" | sha256sum | cut -c1-12; }

# The value compose would load. Last definition wins (as in compose itself);
# surrounding quotes and a trailing CR from a .env edited on Windows are
# stripped, because compose would not treat either as part of the secret.
configured_value() {
  [ -f "$ENV_FILE" ] || return 1
  local v
  v=$(sed -n "s/^[[:space:]]*${KEY}=//p" "$ENV_FILE" | tail -n1)
  v=${v%$'\r'}
  v=${v%\"}; v=${v#\"}
  v=${v%\'}; v=${v#\'}
  printf %s "$v"
}

# What the running container actually holds — the ground truth for a process
# that is already up. Absent container (or no docker here) is not a failure:
# the configured value is then the whole story.
effective_value() {
  command -v docker >/dev/null 2>&1 || return 1
  local cid
  cid=$(cd "$COMPOSE_DIR" && docker compose ps -q "$SERVICE" 2>/dev/null | head -n1) || return 1
  [ -n "$cid" ] || return 1
  docker inspect "$cid" --format "{{range .Config.Env}}{{println .}}{{end}}" 2>/dev/null \
    | sed -n "s/^${KEY}=//p" | tail -n1
}

fail_missing() {
  cat >&2 <<EOF

  ✗ $KEY is missing or empty in $ENV_FILE

    Room discovery is authenticated and fails CLOSED, so with no token the
    relay refuses the fleet's control channel, no room is ever discovered,
    and NO AGGREGATOR SPAWNS IN ANY ROOM. Nothing else reports this — the
    conductor just logs the same refusal every ~2s.

    Fix (the same value must be on both VMs):
      openssl rand -hex 32                    # generate once
      echo "$KEY=<that value>" >> $ENV_FILE
      # then set the identical value in $PEER
      cd $COMPOSE_DIR && docker compose up -d --force-recreate $SERVICE

EOF
}

configured=$(configured_value) || configured=""
if [ -z "$configured" ]; then
  fail_missing
  exit 1
fi

effective=$(effective_value) || effective=""

if [ -z "$effective" ]; then
  # Nothing running to contradict the file (container down, or docker absent
  # because this ran off the deploy host).
  echo "  ✓ $KEY configured in $ENV_FILE (sha $(fingerprint "$configured")) — $SERVICE not running, file value not yet verified against a container" >&2
  echo "FINGERPRINT $(fingerprint "$configured")"
  exit 0
fi

if [ "$effective" != "$configured" ]; then
  cat >&2 <<EOF

  ✗ $SERVICE is RUNNING WITH A DIFFERENT $KEY than $ENV_FILE holds
      file      sha $(fingerprint "$configured")
      container sha $(fingerprint "$effective")

    Container environment is fixed when the container is CREATED, and
    \`docker compose restart\` does not re-read .env. The file is right and the
    running process is stale. Recreate it:
      cd $COMPOSE_DIR && docker compose up -d --force-recreate $SERVICE

EOF
  exit 1
fi

echo "  ✓ $KEY in effect on $SERVICE (sha $(fingerprint "$effective")) — must equal $PEER" >&2
echo "FINGERPRINT $(fingerprint "$effective")"

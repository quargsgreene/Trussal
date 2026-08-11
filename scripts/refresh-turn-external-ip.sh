#!/usr/bin/env bash
#
# Keep coturn's advertised relay address correct on a dynamic/residential WAN IP.
#
# coturn has no self-discovery for its own public address the way JVB does (JVB
# STUNs itself at candidate-harvest time and always reports whatever address the
# outside world currently sees); coturn's -X/--external-ip only accepts a literal
# IP baked in at container start (confirmed against `turnserver --help` — no
# hostname support). So whenever the WAN IP changes, TURN_EXTERNAL_IP in .env
# goes stale silently: coturn keeps answering STUN fine, but every relay
# candidate it hands out points at a dead address, and ICE has no working
# fallback once a mobile client's direct UDP path drops (root-caused 2026-08-10,
# after 98e5f5f's coturn addition already went stale once before anyone noticed).
#
# TURN_HOST already tracks the current WAN IP via the same DNS the deployment's
# own --realm relies on (verified against `curl ifconfig.me` run on this host),
# so resolving it is the primary source of truth; a public IP-echo service is a
# fallback only for the rare case DNS itself is unreachable from here.
#
# Meant to run unattended and often (cron — see below), so failures to determine
# the current IP must no-op rather than write a bad value or crash a caller's
# script; only an actual, confirmed drift touches .env or recreates coturn.
#
# Install (no root required — the video VM has no passwordless sudo):
#   crontab entry, e.g.: */5 * * * * REPO/scripts/refresh-turn-external-ip.sh >> ~/turn-ip-refresh.log 2>&1
# run.sh installs/refreshes this crontab entry on every deploy.
#
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO/docker-jitsi-meet/.env"

[ -f "$ENV_FILE" ] || { echo "[turn-ip] $ENV_FILE missing, nothing to do"; exit 0; }

TURN_HOST=$(sed -n 's/^TURN_HOST=//p' "$ENV_FILE" | tail -n1)
TURN_HOST=${TURN_HOST:-meet.trussal.com}

current_ip=$(getent ahostsv4 "$TURN_HOST" 2>/dev/null | awk '{print $1; exit}')
if [ -z "$current_ip" ]; then
  current_ip=$(curl -s4 --max-time 5 https://ifconfig.me 2>/dev/null || true)
fi
if [ -z "$current_ip" ]; then
  echo "[turn-ip] could not determine current public IP (DNS and ifconfig.me both failed) — leaving TURN_EXTERNAL_IP untouched"
  exit 0
fi

configured_ip=$(sed -n 's/^TURN_EXTERNAL_IP=//p' "$ENV_FILE" | tail -n1)

if [ "$current_ip" = "$configured_ip" ]; then
  exit 0
fi

echo "[turn-ip] TURN_EXTERNAL_IP drifted: '$configured_ip' -> '$current_ip' — updating .env and recreating coturn"
sed -i "s/^TURN_EXTERNAL_IP=.*/TURN_EXTERNAL_IP=$current_ip/" "$ENV_FILE"
if ! grep -q '^TURN_EXTERNAL_IP=' "$ENV_FILE"; then
  echo "TURN_EXTERNAL_IP=$current_ip" >> "$ENV_FILE"
fi

cd "$REPO/docker-jitsi-meet"
docker compose up -d --force-recreate coturn
echo "[turn-ip] coturn recreated with TURN_EXTERNAL_IP=$current_ip"

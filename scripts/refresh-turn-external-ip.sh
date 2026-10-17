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
# The WAN IP is learned from public IP-echo services. It used to be read by
# resolving TURN_HOST, which only works while that name is a direct
# (grey-cloud) A record: once meet.trussal.com moved behind Cloudflare's proxy,
# its DNS began returning Cloudflare edge IPs, which are never coturn's own
# address. On 2026-10-17 that had put 172.67.173.3 into TURN_EXTERNAL_IP and
# broken relaying. So: IP echoes only, and no DNS fallback — a proxied
# TURN_HOST can only ever resolve to edge IPs, and a bad value is worse than
# none.
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
# Standalone / single-box: docker-jitsi-meet/.env + that compose dir. On the
# edge host of a sharded rack, coturn lives in edge/ — point both there:
#   TURN_ENV_FILE=edge/.env TURN_COMPOSE_DIR=edge scripts/refresh-turn-external-ip.sh
ENV_FILE="${TURN_ENV_FILE:-$REPO/docker-jitsi-meet/.env}"
COMPOSE_DIR="${TURN_COMPOSE_DIR:-$REPO/docker-jitsi-meet}"
case "$ENV_FILE" in /*) : ;; *) ENV_FILE="$REPO/$ENV_FILE" ;; esac
case "$COMPOSE_DIR" in /*) : ;; *) COMPOSE_DIR="$REPO/$COMPOSE_DIR" ;; esac

[ -f "$ENV_FILE" ] || { echo "[turn-ip] $ENV_FILE missing, nothing to do"; exit 0; }

current_ip=""
for url in ${TURN_IP_ECHO_URLS:-https://api.ipify.org https://ifconfig.me https://icanhazip.com}; do
  candidate=$(curl -s4 --max-time 5 "$url" 2>/dev/null | tr -d '[:space:]' || true)
  case "$candidate" in
    ''|*[!0-9.]*) continue ;;   # empty or not a bare dotted-quad -> try next
  esac
  current_ip=$candidate
  break
done
if [ -z "$current_ip" ]; then
  echo "[turn-ip] could not determine current public IP (all IP echoes failed) — leaving TURN_EXTERNAL_IP untouched"
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

cd "$COMPOSE_DIR"
docker compose up -d --force-recreate coturn
echo "[turn-ip] coturn recreated with TURN_EXTERNAL_IP=$current_ip"

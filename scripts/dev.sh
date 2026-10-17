#!/usr/bin/env bash
#
# Local dev server. Brings up a full Trussal Jitsi stack (web, prosody, jicofo,
# jvb, latency) plus the bots conductor — every room a human joins then gets its
# aggregator automatically — and watches src/ — on every save it rebuilds
# custom-config.js and copies it into the container's bind mount, so you just
# hard-refresh the browser to test.
#
# Run scripts/dev-setup.sh once first (npm run dev:setup).
#
# Everything runs in the repo: no VM access, no audio VM (Jamulus is gone), and
# nothing outside the work tree is touched. See scripts/dev-setup.sh.
#
#   npm run dev               start + watch (Ctrl-C stops the watcher; the
#                             containers keep running)
#   npm run dev -- --no-watch build + start, then exit (no file watcher)
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DJM="$REPO/docker-jitsi-meet"
ENV_FILE="$DJM/.env"
OVERRIDE_FILE="$DJM/docker-compose.override.yml"

# Only the services needed to serve the app + signalling. Skips coturn + ddns
# (the 'local-turn' profile, for real WAN clients) — everything is on one host.
SERVICES="web prosody jicofo jvb latency"

WATCH=1
for arg in "$@"; do
	case "$arg" in
		--no-watch) WATCH=0 ;;
		-h|--help) sed -n '2,20p' "$0"; exit 0 ;;
		*) echo "[dev] unknown argument: $arg (try --no-watch)" >&2; exit 2 ;;
	esac
done

[ -f "$ENV_FILE" ] || { echo "No docker-jitsi-meet/.env — run: npm run dev:setup" >&2; exit 1; }
[ -f "$OVERRIDE_FILE" ] || { echo "No docker-jitsi-meet/docker-compose.override.yml — run: npm run dev:setup" >&2; exit 1; }

# What the browser will hit. Comes from PUBLIC_URL in the generated .env so the
# two can never drift.
PUBLIC_URL="$(sed -n 's/^PUBLIC_URL=//p' "$ENV_FILE" | tail -n1)"
PUBLIC_URL="${PUBLIC_URL:-https://localhost:8443}"

echo "[dev] building bundle + seeding jitsi-web/"
( cd "$REPO" && node build.mjs --deploy )

echo "[dev] starting Docker stack: $SERVICES"
( cd "$DJM" && docker compose up -d --build $SERVICES )

# Wait for the web front-end to answer before declaring victory, so a config
# mistake surfaces here instead of as a blank tab.
echo -n "[dev] waiting for $PUBLIC_URL "
ready=0
for _ in $(seq 1 60); do
	if curl -ksf -o /dev/null "$PUBLIC_URL/"; then ready=1; break; fi
	echo -n "."
	sleep 2
done
echo
if [ "$ready" -ne 1 ]; then
	echo "[dev] WARNING: web did not answer at $PUBLIC_URL within ~2 min." >&2
	echo "      Check the logs:  ( cd $DJM && docker compose logs --tail=60 web )" >&2
fi

# --- Bots fleet: the conductor that spawns each room's aggregator --------------
# The conductor discovers rooms over the sidecar's control channel and starts
# one aggregator per active room. It runs from bots/ as its own compose project;
# dev-setup generated its .env + override, and its bot containers reach this
# stack via http://localhost:<DEV_HTTP_PORT>.
BOTS_DIR="$REPO/bots"
FLEET_UP=0
if [ -f "$BOTS_DIR/.env" ] && [ -f "$BOTS_DIR/docker-compose.override.yml" ]; then
	# The control token fails CLOSED: if the sidecar and the conductor disagree
	# (or either side is empty), room discovery is refused and NO aggregator
	# ever spawns — with no other symptom. Both files are local, so compare
	# directly and say so loudly.
	stack_token="$(sed -n 's/^SIDECAR_CONTROL_TOKEN=//p' "$ENV_FILE" | tail -n1)"
	fleet_token="$(sed -n 's/^FLEET_CONTROL_TOKEN=//p' "$BOTS_DIR/.env" | tail -n1)"
	if [ -z "$stack_token" ] || [ "$stack_token" != "$fleet_token" ]; then
		echo "[dev] WARNING: control-token mismatch between docker-jitsi-meet/.env" >&2
		echo "      and bots/.env — room discovery fails closed, so NO aggregator" >&2
		echo "      will spawn. Fix it with: npm run dev:setup" >&2
	else
		echo "[dev] building + starting the bots fleet (first run can take a few minutes)…"
		( cd "$BOTS_DIR" && docker compose --profile build-only build && docker compose up -d conductor )
		FLEET_UP=1
	fi
else
	echo "[dev] bots fleet not configured (no bots/.env) — run npm run dev:setup to enable the aggregator" >&2
fi

if [ "$FLEET_UP" -eq 1 ]; then
	cat <<EOF

  Trussal dev stack is up — with the aggregator fleet.
    App:          $PUBLIC_URL/<any-room-name>
                  (accept the self-signed certificate warning once)
    Aggregator:   joins each room automatically once a human is present
                  (look for the "Aggregator" participant). Its admin page:
                  http://localhost:7777
    Signalling:   /ws + /o2 + /xmpp-websocket proxied through the web container

  Watching src/ — edit, save, then hard-refresh the browser (Ctrl-Shift-R) to
  pick up the rebuilt bundle. Container config (env/nginx) changes still need a
  restart: npm run dev:down && npm run dev.

  Ctrl-C stops the watcher (containers keep running).
  Tear the stack down with: npm run dev:down

EOF
else
	cat <<EOF

  Trussal dev stack is up (WITHOUT the aggregator fleet).
    App:        $PUBLIC_URL/<any-room-name>
                (accept the self-signed certificate warning once)
    Signalling: /ws + /o2 + /xmpp-websocket proxied through the web container

  Watching src/ — edit, save, then hard-refresh the browser (Ctrl-Shift-R) to
  pick up the rebuilt bundle. Container config (env/nginx) changes still need a
  restart: npm run dev:down && npm run dev.

  Ctrl-C stops the watcher (containers keep running).
  Tear the stack down with: npm run dev:down

EOF
fi

if [ "$WATCH" -eq 1 ]; then
	exec node "$REPO/build.mjs" --watch --deploy
else
	echo "[dev] --no-watch: leaving the stack running; use 'npm run dev:down' to stop it."
fi

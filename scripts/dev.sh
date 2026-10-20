#!/usr/bin/env bash
#
# Local dev server. Brings up a full Trussal Jitsi stack (web, prosody, jicofo,
# jvb, latency) plus the bots conductor — every room a human joins then gets its
# aggregator automatically. Uses Vite dev server for full HMR (custom-config.js
# + docs/about pages).
#
# Run scripts/dev-setup.sh once first (npm run dev:setup).
#
# Everything runs in the repo: no VM access, no audio VM (Jamulus is gone), and
# nothing outside the work tree is touched. See scripts/dev-setup.sh.
#
#   npm run dev               start + watch + full HMR (Ctrl-C stops the watcher,
#                             the bots fleet and the containers)
#   (no flags — HMR and file watching are always on)
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DJM="$REPO/docker-jitsi-meet"
ENV_FILE="$DJM/.env"
OVERRIDE_FILE="$DJM/docker-compose.override.yml"

# Only the services needed to serve the app + signalling. Skips coturn + ddns
# (the 'local-turn' profile, for real WAN clients) — everything is on one host.
SERVICES="web prosody jicofo jvb latency"

# `npm run dev` owns the whole session: Ctrl-C (or any other exit once the
# stack is up) tears down Vite, the bots fleet and the compose stack, so a
# normal stop needs no second command. dev-down stays available for a stack
# left behind by a crash or a hard kill.
STACK_STARTED=0
CLEANING_UP=0
VITE_PID=""
cleanup() {
	status=$?
	if [ "$CLEANING_UP" -eq 1 ]; then
		return
	fi
	CLEANING_UP=1
	# Don't let a second Ctrl-C interrupt the teardown half-way through.
	trap - EXIT
	trap '' INT TERM

	if [ -n "$VITE_PID" ] && kill -0 "$VITE_PID" 2>/dev/null; then
		kill "$VITE_PID" 2>/dev/null || true
	fi

	if [ "$STACK_STARTED" -eq 1 ]; then
		echo
		echo "[dev] stopping Vite, the bots fleet and the containers…"
		bash "$REPO/scripts/dev-down.sh" || true
	fi

	exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Only accept --help
for arg in "$@"; do
	case "$arg" in
		-h|--help) sed -n '2,20p' "$0"; exit 0 ;;
		*) echo "[dev] unknown argument: $arg (no flags supported — HMR and file watching are always on)" >&2; exit 2 ;;
	esac
done

[ -f "$ENV_FILE" ] || { echo "No docker-jitsi-meet/.env — run: npm run dev:setup" >&2; exit 1; }
[ -f "$OVERRIDE_FILE" ] || { echo "No docker-jitsi-meet/docker-compose.override.yml — run: npm run dev:setup" >&2; exit 1; }
# The override must mount the locally trusted dev certificate
# (scripts/dev-certs.sh) into the web container; one generated before that
# wiring existed would leave the browser warning in place with no other
# symptom, so fail here with the fix rather than serve a warning.
grep -q 'dev-certs' "$OVERRIDE_FILE" \
	|| { echo "docker-compose.override.yml predates the trusted dev certificate — run: npm run dev:setup" >&2; exit 1; }

# What the browser will hit. Comes from PUBLIC_URL in the generated .env so the
# two can never drift.
PUBLIC_URL="$(sed -n 's/^PUBLIC_URL=//p' "$ENV_FILE" | tail -n1)"
PUBLIC_URL="${PUBLIC_URL:-https://localhost:8443}"

# Extract host:port from PUBLIC_URL for Vite proxy target
# e.g. https://localhost:8443 -> localhost:8443
PROXY_TARGET="${PUBLIC_URL#https://}"

# Resolve the config dir once: used to re-sync the Trussal nginx routes below
# and for the dev certificates just before Vite starts.
CONFIG_REL="$(sed -n 's/^CONFIG=//p' "$ENV_FILE" 2>/dev/null | tail -n1)"
CONFIG_REL="${CONFIG_REL:-./.jitsi-meet-cfg}"
case "$CONFIG_REL" in
	/*) CFG="$(realpath -m "$CONFIG_REL")" ;;
	*) CFG="$(realpath -m "$DJM/$CONFIG_REL")" ;;
esac

# --- port lifecycle ---------------------------------------------------------
# Two kinds of stray listeners have caused mix-ups here:
#   * a Vite server left behind by an earlier run (3456/3457), and
#   * another checkout's Jitsi stack publishing the same web ports.
# Check before the (slow) build, not halfway through compose up. Vite itself
# uses strictPort for the same reason: every URL printed below assumes 3456.
HTTP_PORT="$(sed -n 's/^HTTP_PORT=//p' "$ENV_FILE" | tail -n1)"
HTTPS_PORT="$(sed -n 's/^HTTPS_PORT=//p' "$ENV_FILE" | tail -n1)"
HTTP_PORT="${HTTP_PORT:-8000}"
HTTPS_PORT="${HTTPS_PORT:-8443}"
VITE_PIDFILE="$CFG/dev-vite.pid"

_port_line() {
	ss -H -ltnp "sport = :$1" 2>/dev/null | head -n1 || true
}

for port in 3456 3457; do
	line="$(_port_line "$port")"
	if [ -n "$line" ]; then
		echo "[dev] port $port is already in use:" >&2
		echo "      $line" >&2
		echo "[dev] stale Vite server? stop it with: npm run dev:down" >&2
		exit 1
	fi
done

for port in "$HTTPS_PORT" "$HTTP_PORT"; do
	names="$(docker ps --filter "publish=$port" --format '{{.Names}}' 2>/dev/null || true)"
	for name in $names; do
		case "$name" in
			trussal-dev-*) ;; # this stack; compose up recreates it
			*)
				info="$(docker inspect "$name" --format '{{index .Config.Labels "com.docker.compose.project"}} from {{index .Config.Labels "com.docker.compose.project.working_dir"}}' 2>/dev/null || true)"
				echo "[dev] port $port is already published by container '$name' ($info) — not this checkout's trussal-dev stack." >&2
				echo "[dev] stop that stack first, then re-run npm run dev." >&2
				exit 1
				;;
		esac
	done
done

# Not a conflict (the other checkout uses :80/:443), but the easiest way to end
# up looking at the wrong app is another Trussal stack answering on the default
# HTTPS port. Report it; never touch it from this checkout.
_other_stacks() {
	docker ps --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null \
		| sort -u \
		| while IFS='|' read -r project dir; do
			[ -n "$project" ] || continue
			case "$project" in trussal-dev|bots) continue ;; esac
			case "$dir" in "$DJM"|"$REPO/bots") continue ;; esac
			case "$dir" in */docker-jitsi-meet) ;; *) continue ;; esac
			ports="$(docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -- '-web-' | head -n1 || true)"
			echo "[dev] note: another Trussal stack '$project' is running from $dir"
			echo "      ${ports:-$project} — that is not this checkout; use https://localhost:3456 here."
		done || true
}
_other_stacks

echo "[dev] building initial bundle + seeding jitsi-web/"
( cd "$REPO" && node build.mjs --deploy )

# Certificate before containers: the web service bind-mounts dev-certs/*, and
# Docker turns a missing mount source into a directory (nginx then fails).
# dev-certs.sh is idempotent — it only regenerates when something is stale/missing.
bash "$REPO/scripts/dev-certs.sh"

echo "[dev] starting Docker stack: $SERVICES"
# Mark the stack as owned before compose runs: if it fails part-way through,
# the EXIT trap still removes whatever was created.
STACK_STARTED=1
( cd "$DJM" && docker compose up -d --build $SERVICES )

# Keep the container's copy of the Trussal nginx routes in sync with the repo
# (dev-setup.sh seeds ${CONFIG}/web/nginx/custom-routes.conf once; edits after
# that — e.g. the /css/src no-cache headers — must reach the container too),
# then reload nginx so a regenerated certificate AND the routes take effect
# without a container restart. Best-effort — web may still be starting.
mkdir -p "$CFG/web/nginx"
cp "$REPO/custom-config/web/nginx/custom-routes.conf" "$CFG/web/nginx/custom-routes.conf" 2>/dev/null || true
( cd "$DJM" && docker compose exec -T web nginx -s reload ) >/dev/null 2>&1 || true

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
    App (Vite HMR):      https://localhost:3456/<any-room-name>
                         ^ the URL to use while editing: every src/ save hot-updates.
                         (proxies to the container at $PUBLIC_URL)
    Container (static):  $PUBLIC_URL/
                         nginx's startup build; no HMR. For checking the deployed
                         bundle only — it will not see your edits.
    Aggregator:          joins each room automatically once a human is present
                         (look for the "Aggregator" participant). Its admin page:
                         http://localhost:7777
    Signalling:          /ws + /o2 + /xmpp-websocket proxied through Vite to web container

  Watching src/ — edit, save:
    • Full HMR: custom-config.js updates without reload (preserves WebRTC/Yjs)
    • /documentation & /about pages hot-reload automatically
  Container config (env/nginx) changes still need a restart: Ctrl-C, then npm run dev.

  Ports: 3456+3457 Vite/HMR, $HTTPS_PORT web TLS, $HTTP_PORT web HTTP, 7777/7700 bots
  Ctrl-C stops everything: Vite, the bots fleet, and the containers.
  npm run dev:down is only for a stack left behind by a crash or hard kill.

EOF
else
	cat <<EOF

  Trussal dev stack is up (WITHOUT the aggregator fleet).
    App (Vite HMR):      https://localhost:3456/<any-room-name>
                         ^ the URL to use while editing: every src/ save hot-updates.
                         (proxies to the container at $PUBLIC_URL)
    Container (static):  $PUBLIC_URL/
                         nginx's startup build; no HMR. For checking the deployed
                         bundle only — it will not see your edits.
    Signalling:          /ws + /o2 + /xmpp-websocket proxied through Vite to web container

  Watching src/ — edit, save:
    • Full HMR: custom-config.js updates without reload (preserves WebRTC/Yjs)
    • /documentation & /about pages hot-reload automatically
  Container config (env/nginx) changes still need a restart: Ctrl-C, then npm run dev.

  Ports: 3456+3457 Vite/HMR, $HTTPS_PORT web TLS, $HTTP_PORT web HTTP, 7777/7700 bots
  Ctrl-C stops everything: Vite, the bots fleet, and the containers.
  npm run dev:down is only for a stack left behind by a crash or hard kill.

EOF
fi

# Start Vite dev server with HMR
# Use the dev certs so Vite serves HTTPS (avoids mixed content with Jitsi container)
CERT_DIR="$CFG/dev-certs"
if [ -f "$CERT_DIR/cert.crt" ] && [ -f "$CERT_DIR/cert.key" ]; then
	export VITE_HTTPS_KEY="$CERT_DIR/cert.key"
	export VITE_HTTPS_CERT="$CERT_DIR/cert.crt"
fi

# Set proxy target for Vite config
export VITE_PROXY_TARGET="$PROXY_TARGET"

# Start Vite directly (not through npx): the pidfile must name the process that
# owns 3456/3457, otherwise dev-down kills a wrapper and leaves the listener
# behind. Keep the shell in the foreground so its EXIT trap (installed above)
# can stop Vite and remove the file.
VITE_BIN="$REPO/node_modules/vite/bin/vite.js"
if [ ! -f "$VITE_BIN" ]; then
	echo "[dev] missing $VITE_BIN — run npm install" >&2
	exit 1
fi
mkdir -p "$CFG"
node "$VITE_BIN" --config "$REPO/vite.config.js" &
VITE_PID=$!
echo "$VITE_PID" > "$VITE_PIDFILE"

wait "$VITE_PID"

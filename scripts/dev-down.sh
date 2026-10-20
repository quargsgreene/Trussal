#!/usr/bin/env bash
#
# Tear down the local dev Trussal stack: the Vite dev server (3456/3457), the
# bots fleet, and the compose stack. `scripts/dev.sh` runs this automatically on
# Ctrl-C, so it is normally only needed to clean up a stack left behind by a
# crash or hard kill. The config tree, .env, generated overrides and built
# bundle are left in place so `npm run dev` comes straight back up.
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DJM="$ROOT/docker-jitsi-meet"
ENV_FILE="$DJM/.env"

# Resolve the config dir the same way dev.sh does, so the pidfile is found no
# matter which directory this is run from.
CONFIG_REL="$(sed -n 's/^CONFIG=//p' "$ENV_FILE" 2>/dev/null | tail -n1)"
CONFIG_REL="${CONFIG_REL:-./.jitsi-meet-cfg}"
case "$CONFIG_REL" in
	/*) CFG="$(realpath -m "$CONFIG_REL")" ;;
	*) CFG="$(realpath -m "$DJM/$CONFIG_REL")" ;;
esac
VITE_PIDFILE="$CFG/dev-vite.pid"

HTTP_PORT="$(sed -n 's/^HTTP_PORT=//p' "$ENV_FILE" 2>/dev/null | tail -n1)"
HTTPS_PORT="$(sed -n 's/^HTTPS_PORT=//p' "$ENV_FILE" 2>/dev/null | tail -n1)"
HTTP_PORT="${HTTP_PORT:-8000}"
HTTPS_PORT="${HTTPS_PORT:-8443}"

# ---------------------------------------------------------------------------
# Vite / file watcher.
#
# They are host processes, not containers, so `docker compose down` by itself
# leaves 3456/3457 listening. Check that a pid still belongs to this checkout
# before killing it: a stale pidfile must never hit an unrelated process after
# pid reuse.
# ---------------------------------------------------------------------------
_stop_owned() {
	pid="$1"
	label="$2"
	expect="$3"
	[ -n "$pid" ] || return 0
	kill -0 "$pid" 2>/dev/null || return 0
	cmd="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
	case "$cmd" in
		*"$expect"*) ;;
		*)
			echo "[dev-down] pid $pid ($label) does not belong to this checkout — leaving it alone." >&2
			return 0
			;;
	esac
	echo "[dev-down] stopping $label (pid $pid)"
	kill "$pid" 2>/dev/null || true
	for _ in $(seq 1 20); do
		kill -0 "$pid" 2>/dev/null || break
		sleep 0.25
	done
	if kill -0 "$pid" 2>/dev/null; then
		echo "[dev-down] $label ignored SIGTERM; sending SIGKILL." >&2
		kill -9 "$pid" 2>/dev/null || true
	fi
}

_stop_pidfile() {
	file="$1"
	label="$2"
	expect="$3"
	[ -f "$file" ] || return 0
	pid="$(tr -d '[:space:]' < "$file" 2>/dev/null || true)"
	_stop_owned "$pid" "$label" "$expect"
	rm -f "$file"
}

_stop_matching() {
	pattern="$1"
	label="$2"
	expect="$3"
	while IFS= read -r pid; do
		if [ -n "$pid" ]; then
			_stop_owned "$pid" "$label" "$expect"
		fi
	done < <(pgrep -f -- "$pattern" 2>/dev/null || true)
}

_stop_pidfile "$VITE_PIDFILE" "Vite dev server" "$ROOT/vite.config.js"
# Fallbacks for a server started before the pidfile existed, or killed hard
# enough that the pidfile went stale. Match this checkout's paths only, so the
# other checkout's Vite/build watcher is never touched.
_stop_matching "$ROOT/node_modules/.bin/vite" "Vite dev server" "$ROOT/vite.config.js"
_stop_matching "$ROOT/node_modules/vite/bin/vite.js" "Vite dev server" "$ROOT/vite.config.js"
_stop_matching "node $ROOT/build.mjs --watch" "build watcher" "$ROOT/build.mjs"

# The bots fleet next: stopping the conductor SIGTERMs every bot it spawned so
# they leave their meetings cleanly (its stop_grace_period covers the whole
# teardown; the compose network is external, so it is left alone).
if [ -f "$ROOT/bots/.env" ]; then
	( cd "$ROOT/bots" && docker compose down --remove-orphans )
fi

# Belt and braces: a conductor that died in an unusual way (SIGKILL, daemon
# restart) cannot run its own teardown, and would leave trussal-bot-*
# containers — including a room's aggregator — running against a dead stack.
leftovers="$(docker ps -aq --filter 'name=^trussal-bot-' 2>/dev/null || true)"
if [ -n "$leftovers" ]; then
	# shellcheck disable=SC2086 — word splitting is intentional (one id per arg).
	docker rm -f $leftovers >/dev/null
	echo "[dev-down] removed leftover bot container(s): $(echo "$leftovers" | tr '\n' ' ')"
fi

if [ -f "$DJM/.env" ]; then
	( cd "$DJM" && docker compose down --remove-orphans )
else
	echo "[dev-down] no docker-jitsi-meet/.env — no stack to tear down." >&2
fi

# ---------------------------------------------------------------------------
# Verify the promise: after dev-down nothing from this checkout should still be
# listening. (Other checkouts are reported but never stopped from here.)
# ---------------------------------------------------------------------------
busy=0
for port in 3456 3457 "$HTTPS_PORT" "$HTTP_PORT" 7777 7700; do
	line="$(ss -H -ltnp "sport = :$port" 2>/dev/null | head -n1 || true)"
	if [ -n "$line" ]; then
		echo "[dev-down] WARNING: port $port is still in use:" >&2
		echo "            $line" >&2
		busy=1
	fi
done
if [ "$busy" -eq 0 ]; then
	echo "[dev-down] dev ports 3456, 3457, $HTTPS_PORT, $HTTP_PORT, 7777, 7700 are free."
fi

_other_stacks() {
	docker ps --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}' 2>/dev/null \
		| sort -u \
		| while IFS='|' read -r project dir; do
			[ -n "$project" ] || continue
			case "$project" in trussal-dev|bots) continue ;; esac
			case "$dir" in "$DJM"|"$ROOT/bots") continue ;; esac
			case "$dir" in */docker-jitsi-meet) ;; *) continue ;; esac
			ports="$(docker ps --filter "label=com.docker.compose.project=$project" --format '{{.Names}} {{.Ports}}' 2>/dev/null | grep -- '-web-' | head -n1 || true)"
			echo "[dev-down] note: another Trussal stack '$project' is still running from $dir"
			echo "            ${ports:-$project} — stop it in that checkout if it is stale."
		done || true
}
_other_stacks

echo "[dev-down] containers removed; .env + .jitsi-meet-cfg + bots config left in place."

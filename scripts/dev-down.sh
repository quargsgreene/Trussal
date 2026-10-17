#!/usr/bin/env bash
#
# Tear down the local dev Trussal stack (containers + network only — the config
# tree, .env, generated overrides and built bundle are left in place so
# `npm run dev` comes straight back up).
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DJM="$ROOT/docker-jitsi-meet"

# The bots fleet first: stopping the conductor SIGTERMs every bot it spawned so
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
	cd "$DJM"
	docker compose down --remove-orphans
else
	echo "[dev-down] no docker-jitsi-meet/.env — nothing else to tear down." >&2
fi

echo "[dev-down] containers removed; .env + .jitsi-meet-cfg + bots config left in place."

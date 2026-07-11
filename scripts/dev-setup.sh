#!/usr/bin/env bash
#
# One-time local dev bootstrap. Configures the docker-jitsi-meet stack to run a
# full Trussal deployment on this laptop, independent of the video/audio/bot
# VMs, so you can test changes before pushing. Idempotent — safe to re-run; it
# won't clobber an existing .env.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DJM="$REPO/docker-jitsi-meet"
ENV_FILE="$DJM/.env"
# Repo-local config tree (gitignored). Kept under docker-jitsi-meet so the
# relative CONFIG path resolves against the compose project dir.
CFG="$DJM/.jitsi-meet-cfg"

command -v docker >/dev/null || { echo "[dev-setup] docker not found on PATH" >&2; exit 1; }

# --- 1. docker-jitsi-meet/.env -------------------------------------------------
if [ -f "$ENV_FILE" ]; then
	echo "[dev-setup] $ENV_FILE already exists — leaving it untouched"
else
	echo "[dev-setup] creating docker-jitsi-meet/.env from env.example"
	cp "$DJM/env.example" "$ENV_FILE"

	# Point CONFIG at the repo-local tree and give component passwords real values.
	sed -i 's#^CONFIG=.*#CONFIG=./.jitsi-meet-cfg#' "$ENV_FILE"
	bash "$DJM/gen-passwords.sh"

	# Local single-laptop overrides appended last so they win over the template.
	# The web container binds 80/443 directly and browsers treat http://localhost
	# as a secure context, so getUserMedia (camera/mic) works over plain HTTP.
	cat >> "$ENV_FILE" <<-'EOF'

	# --- Trussal local-dev overrides (scripts/dev-setup.sh) ---
	PUBLIC_URL=http://localhost
	RESTART_POLICY=no
	EOF
fi

# --- 2. Config tree ------------------------------------------------------------
# The web service bind-mounts a few individual files (body.html, custom-routes)
# — if they don't pre-exist Docker silently creates them as directories and
# nginx / the page break. Seed them explicitly; the base image regenerates the
# rest of the localhost config on first boot.
echo "[dev-setup] seeding config tree at $CFG"
mkdir -p \
	"$CFG/web/nginx" "$CFG/web/crontabs" "$CFG/web/load-test" "$CFG/web/letsencrypt" \
	"$CFG/transcripts" \
	"$CFG/prosody/config" "$CFG/prosody/prosody-plugins-custom" \
	"$CFG/jicofo" "$CFG/jvb"

# body.html is SSI-included into the Jitsi page — this is what loads the bundle.
cp "$REPO/custom-config/web/body.html" "$CFG/web/body.html"
cp "$REPO/custom-config/web/nginx/custom-routes.conf" "$CFG/web/nginx/custom-routes.conf"

# --- 3. Bundle -----------------------------------------------------------------
# The web image COPYs custom-config.js + assets at build time, so they must
# exist before the first `docker compose build`.
echo "[dev-setup] building custom-config.js"
( cd "$REPO" && node build.mjs --deploy )

cat <<EOF

[dev-setup] done.

  Start the dev stack:   npm run dev
  Then open:             http://localhost/<any-room-name>

EOF

#!/usr/bin/env bash
#
# Local dev HTTPS certificate. Run by scripts/dev-setup.sh and scripts/dev.sh —
# safe to run directly, too.
#
# The docker-jitsi-meet web image boots with a self-signed certificate, which
# every browser flags as "not private". This script replaces it with a
# certificate for `localhost` signed by a repo-local development CA, and
# installs that CA into the current user's browser trust stores, so
# https://localhost:<port>/ loads without a warning.
#
# Files (gitignored, under the compose config tree):
#   .jitsi-meet-cfg/dev-certs/ca.pem       development CA certificate
#   .jitsi-meet-cfg/dev-certs/ca.key       its private key — for this machine only
#   .jitsi-meet-cfg/dev-certs/cert.crt     the leaf the web container serves
#   .jitsi-meet-cfg/dev-certs/cert.key     its private key (read by nginx)
#
# Trust: the CA is added (via `certutil`) to every NSS shared database the
# browsers on this machine consult — Chrome/Chromium (legacy ~/.pki/nssdb or
# the M146+ ~/.local/share/pki/nssdb) and Firefox (regular, Snap and Flatpak
# profiles). This is user-level only: no sudo, no system trust store, nothing
# outside the user's own browser data and this repo is touched. Browsers that
# were already running cache their trust store at startup, so they need a
# restart once to pick the CA up.
#
# `certutil` comes from libnss3-tools (Debian/Ubuntu), nss-tools (Fedora) or
# `brew install nss`. Without it the stack still serves the certificate, but
# browsers keep warning; the script prints the install command and moves on.
# Set DEV_CERTS_SKIP_TRUST=1 to leave the trust stores alone entirely.
#
# Certificates are kept while valid and renewed when under 30 days remain.
# DEV_CERT_EXTRA_SANS="DNS:other.host,IP:10.0.0.2" adds subjectAltNames for
# reaching the stack from further away.
#
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DJM="$REPO/docker-jitsi-meet"
ENV_FILE="$DJM/.env"

log() { printf '[dev-certs] %s\n' "$*"; }
warn() { printf '[dev-certs] WARNING: %s\n' "$*" >&2; }
die() { printf '[dev-certs] FATAL: %s\n' "$*" >&2; exit 1; }

command -v openssl >/dev/null || die "openssl not found on PATH (needed to generate the certificate)"

# Same CONFIG resolution as run.sh: the .env value, resolved against the
# compose project directory (docker-jitsi-meet/). The override dev-setup writes
# mounts $CONFIG/dev-certs, so this is the one place the certs can live.
CONFIG_REL="$(sed -n 's/^CONFIG=//p' "$ENV_FILE" 2>/dev/null | tail -n1)"
CONFIG_REL="${CONFIG_REL:-./.jitsi-meet-cfg}"
case "$CONFIG_REL" in
	/*) CFG="$(realpath -m "$CONFIG_REL")" ;;
	*) CFG="$(realpath -m "$DJM/$CONFIG_REL")" ;;
esac
CERT_DIR="$CFG/dev-certs"

# The web image serves whatever is at /config/keys, so the leaf must be named
# cert.crt/cert.key to be picked up without touching the image itself.
CA_KEY="$CERT_DIR/ca.key"
CA_PEM="$CERT_DIR/ca.pem"
LEAF_KEY="$CERT_DIR/cert.key"
LEAF_CRT="$CERT_DIR/cert.crt"

CA_DAYS=3650
LEAF_DAYS=825
RENEW_WITHIN=$((30 * 24 * 60 * 60)) # regenerate when under 30 days remain

SAN="DNS:localhost,IP:127.0.0.1,IP:::1"
[ -n "${DEV_CERT_EXTRA_SANS:-}" ] && SAN="$SAN,${DEV_CERT_EXTRA_SANS}"

# Keys land 0600, the directory 0700: the CA key must never leave this machine.
umask 077
mkdir -p "$CERT_DIR"

expires_after() { # file seconds
	openssl x509 -in "$1" -noout -checkend "$2" >/dev/null 2>&1
}

ca_ready() {
	[ -s "$CA_KEY" ] && [ -s "$CA_PEM" ] && expires_after "$CA_PEM" "$RENEW_WITHIN"
}

leaf_ready() {
	[ -s "$LEAF_KEY" ] && [ -s "$LEAF_CRT" ] || return 1
	expires_after "$LEAF_CRT" "$RENEW_WITHIN" || return 1
	# Must chain to the *current* CA and carry the localhost SANs, so neither
	# an old CA nor one of the image's own self-signed certs can pass.
	openssl verify -CAfile "$CA_PEM" "$LEAF_CRT" >/dev/null 2>&1 || return 1
	openssl x509 -in "$LEAF_CRT" -noout -ext subjectAltName 2>/dev/null | grep -q 'DNS:localhost'
}

GENERATED=0

if ! ca_ready; then
	log "generating local dev CA (${CA_DAYS} days): $CA_PEM"
	openssl req -x509 -newkey rsa:2048 -sha256 -days "$CA_DAYS" -nodes \
		-keyout "$CA_KEY" -out "$CA_PEM" \
		-subj "/CN=Trussal local development CA" \
		-addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
		-addext "keyUsage=critical,keyCertSign,cRLSign" \
		|| die "openssl could not generate the dev CA"
	GENERATED=1
fi

if ! leaf_ready; then
	log "issuing localhost certificate (${LEAF_DAYS} days): $LEAF_CRT"
	# A previous Docker mishap (a bind-mount source that did not exist) can
	# leave a DIRECTORY where a cert file should be; clear it first.
	for p in "$LEAF_CRT" "$LEAF_KEY"; do [ -d "$p" ] && rm -rf "$p"; done
	EXT="$CERT_DIR/leaf.ext"
	cat >"$EXT" <<EOF
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=$SAN
EOF
	openssl req -newkey rsa:2048 -sha256 -nodes \
		-keyout "$LEAF_KEY.tmp" -out "$CERT_DIR/leaf.csr" -subj "/CN=localhost" \
		|| die "openssl could not create the certificate request"
	openssl x509 -req -in "$CERT_DIR/leaf.csr" -CA "$CA_PEM" -CAkey "$CA_KEY" \
		-CAcreateserial -out "$LEAF_CRT.tmp" -days "$LEAF_DAYS" -sha256 -extfile "$EXT" \
		|| die "openssl could not sign the localhost certificate"
	mv "$LEAF_KEY.tmp" "$LEAF_KEY"
	mv "$LEAF_CRT.tmp" "$LEAF_CRT"
	rm -f "$CERT_DIR/leaf.csr" "$EXT"
	GENERATED=1
fi

chmod 600 "$CA_KEY" "$LEAF_KEY"
chmod 644 "$CA_PEM" "$LEAF_CRT"

# --- Browser trust stores ------------------------------------------------------

CA_NICKNAME="Trussal local-dev CA"

install_ca() { # db-directory
	local db="$1"
	# Replace any previous copy so a regenerated CA never lingers.
	certutil -d "sql:$db" -D -n "$CA_NICKNAME" >/dev/null 2>&1 || true
	certutil -d "sql:$db" -A -n "$CA_NICKNAME" -t "C,," -i "$CA_PEM"
}

install_ca_everywhere() {
	local dbs=() db installed=0

	# Chrome/Chromium read the NSS shared DB: the legacy ~/.pki/nssdb when it
	# exists, otherwise (since M146) ~/.local/share/pki/nssdb. Install into
	# whichever exist; create the legacy location when neither does, because
	# every Chrome version consults that path.
	for db in "$HOME/.pki/nssdb" "$HOME/.local/share/pki/nssdb"; do
		[ -d "$db" ] && dbs+=("$db")
	done
	if [ "${#dbs[@]}" -eq 0 ]; then
		log "creating $HOME/.pki/nssdb (Chrome/Chromium trust store)"
		mkdir -p "$HOME/.pki/nssdb" \
			&& certutil -N -d "sql:$HOME/.pki/nssdb" --empty-password >/dev/null 2>&1 \
			&& dbs+=("$HOME/.pki/nssdb") \
			|| warn "could not create $HOME/.pki/nssdb"
	fi

	# Firefox: every install flavour (deb/snap/flatpak) and profile.
	for base in \
		"$HOME/.mozilla/firefox" \
		"$HOME/snap/firefox/common/.mozilla/firefox" \
		"$HOME/.var/app/org.mozilla.firefox/.mozilla/firefox"; do
		[ -d "$base" ] || continue
		for profile in "$base"/*; do
			[ -f "$profile/cert9.db" ] && dbs+=("$profile")
		done
	done

	for db in "${dbs[@]}"; do
		if install_ca "$db"; then
			installed=$((installed + 1))
		else
			warn "could not install the CA into $db (master password?) — try: certutil -d sql:$db -A -t 'C,,' -n '$CA_NICKNAME' -i '$CA_PEM'"
		fi
	done

	log "dev CA installed into $installed browser trust store(s) (nickname: '$CA_NICKNAME')"
}

if [ "${DEV_CERTS_SKIP_TRUST:-0}" = "1" ]; then
	log "DEV_CERTS_SKIP_TRUST=1 — leaving the browser trust stores alone"
elif command -v certutil >/dev/null 2>&1; then
	install_ca_everywhere
	[ "$GENERATED" -eq 1 ] && log "a browser that is already running caches its trust store — restart it once to pick the CA up"
else
	warn "certutil not found — browsers will keep showing the certificate warning."
	warn "Install it once (any of these), then re-run \`npm run dev:setup\`:"
	warn "  Debian/Ubuntu:  sudo apt install libnss3-tools"
	warn "  Fedora/RHEL:    sudo dnf install nss-tools"
	warn "  Arch:           sudo pacman -S nss"
	warn "  with Homebrew:  brew install nss"
fi

log "ready: $LEAF_CRT (SANs: $SAN)"

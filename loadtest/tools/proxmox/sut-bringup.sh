#!/usr/bin/env bash
# Checkpoint-A SUT bring-up on 192.168.1.41 (sut-explicit).
# Runs as trussal (NOPASSWD sudo). Logs everything; safe to re-run.
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
SUT_IP=192.168.1.41
REPO=/home/trussal/Trussal
GH=https://github.com/quargsgreene/Trussal.git
step(){ echo; echo "==================== $* ===================="; }
die(){ echo "FATAL: $*" >&2; exit 1; }

step "0. apt sanity"
sudo apt-get update || die "apt-get update failed — see error above"
sudo apt-get install -y ca-certificates curl gnupg git make g++ jq iproute2 rsync || die "base pkg install"

step "1. Docker CE"
if ! command -v docker >/dev/null; then
  sudo install -m0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/debian/gpg | sudo gpg --batch --yes --dearmor -o /etc/apt/keyrings/docker.gpg
  sudo chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=amd64 signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/debian bookworm stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update || die "apt-get update (docker repo) failed"
  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin || die "docker install"
fi
sudo usermod -aG docker trussal
sudo systemctl enable --now docker
sudo docker version | head -5
sudo docker compose version

step "2. Node 20 (NodeSource)"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - || die "nodesource setup"
  sudo apt-get install -y nodejs || die "nodejs install"
fi
node -v; npm -v

step "3. clone repo"
if [ ! -d "$REPO/.git" ]; then
  rm -rf "$REPO"; git clone "$GH" "$REPO" || die "git clone"
fi
cd "$REPO"
git config --global --add safe.directory "$REPO"
git fetch origin && git checkout main && git pull --ff-only || die "repo update"
echo "HEAD: $(git rev-parse --short HEAD) $(git log -1 --format=%s)"

step "4. npm ci"
export JAMULUS_HOST=jamulus.trussal.com
npm ci --include=dev || die "npm ci"

step "5. dev:setup (creates docker-jitsi-meet/.env + config tree + bundle)"
npm run dev:setup || die "dev:setup"

step "6. patch .env for networked HTTPS + harness requirements"
ENV="$REPO/docker-jitsi-meet/.env"
setkv(){ # key value
  if grep -qE "^#?$1=" "$ENV"; then sed -i -E "s|^#?$1=.*|$1=$2|" "$ENV"; else printf '%s=%s\n' "$1" "$2" >> "$ENV"; fi
}
setkv PUBLIC_URL "https://$SUT_IP"
setkv ENABLE_LETSENCRYPT 0
setkv ENABLE_HTTP_REDIRECT 1
setkv ENABLE_P2P 0
setkv ENABLE_XMPP_WEBSOCKET 1
setkv COLIBRI_REST_ENABLED 1
setkv JVB_ADVERTISED_IPS "$SUT_IP"
setkv DOCKER_HOST_ADDRESS "$SUT_IP"
setkv RESTART_POLICY no
echo "--- effective overrides ---"
grep -E '^(PUBLIC_URL|ENABLE_LETSENCRYPT|ENABLE_HTTP_REDIRECT|ENABLE_P2P|ENABLE_XMPP_WEBSOCKET|COLIBRI_REST_ENABLED|JVB_ADVERTISED_IPS|DOCKER_HOST_ADDRESS|CONFIG|RESTART_POLICY)=' "$ENV"

step "7. rebuild bundle with prod Jamulus host, then bring the stack up"
cd "$REPO"
node build.mjs --deploy || die "bundle build"
grep -c JAMULUS_ROOM_MAP docker-jitsi-meet/jitsi-web/custom-config.js
cd "$REPO/docker-jitsi-meet"
sudo -E docker compose up -d --build web prosody jicofo jvb latency || die "compose up"

step "8. wait for web + verify served surfaces"
for i in $(seq 1 30); do
  code=$(curl -sk -o /dev/null -w '%{http_code}' "https://$SUT_IP/" || true)
  [ "$code" = "200" ] && break
  sleep 3
done
echo "GET / -> $code"
echo -n "custom-config.js JAMULUS_ROOM_MAP count: "; curl -sk "https://$SUT_IP/custom-config.js" | grep -c JAMULUS_ROOM_MAP || true
echo -n "http-bind: "; curl -sk -o /dev/null -w '%{http_code}\n' "https://$SUT_IP/http-bind"
echo -n "xmpp-websocket: "; curl -sk -o /dev/null -w '%{http_code}\n' "https://$SUT_IP/xmpp-websocket"
echo -n "sidecar /ws: "; curl -sk -o /dev/null -w '%{http_code}\n' "https://$SUT_IP/ws"
echo
sudo docker compose ps
echo
echo "DONE."

#!/usr/bin/env bash
# preflight.sh <inventory.yaml> — verify everything the campaign needs, and
# REFUSE to target production unless ALLOW_PROD=1.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${LOADTEST_PY:-python3}"
INV=${1:?inventory.yaml}
fail=0
note() { printf '  %-8s %s\n' "$1" "$2"; [[ "$1" == "FAIL" ]] && fail=1; }

HOST="$($PY "$HERE/cfg.py" inv "$INV" target.host)"
SCHEME="$($PY "$HERE/cfg.py" inv "$INV" target.scheme)"
echo "target: $SCHEME://$HOST"
case "$HOST" in
  meet.trussal.com|trussal.com|www.trussal.com)
    if [[ "${ALLOW_PROD:-}" == "1" ]]; then note "WARN" "production host, ALLOW_PROD=1 set — proceeding"
    else note "FAIL" "refusing production host $HOST (export ALLOW_PROD=1 to override)"; fi ;;
  *) note "ok" "non-production host" ;;
esac

echo "ssh reachability:"
for path in vms.video.ssh vms.audio.ssh vms.bots.ssh; do
  s="$($PY "$HERE/cfg.py" inv "$INV" "$path" 2>/dev/null)" || continue
  if ssh -o BatchMode=yes -o ConnectTimeout=8 "$s" true 2>/dev/null; then note "ok" "$s"; else note "FAIL" "$s unreachable"; fi
done
while IFS=$'\t' read -r name ssh iface _r _b _g _n; do
  [[ -z "${name:-}" ]] && continue
  if ssh -o BatchMode=yes -o ConnectTimeout=8 "$ssh" true 2>/dev/null; then note "ok" "$name $ssh"; else note "FAIL" "$name $ssh unreachable"; fi
done < <($PY "$HERE/cfg.py" generators "$INV")

echo "sidecar handshake:"
if RUN_ID=preflight PROFILE=p0 SCENARIO=S0 TRUSSAL_HOST="$HOST" TRUSSAL_SCHEME="$SCHEME" \
   "$PY" - "$HERE" <<'PYEOF'
import sys, time, uuid
sys.path.insert(0, sys.argv[1] + "/..")
from harness.common import RunContext
from harness.sidecar import SidecarClient
ctx = RunContext.from_env()
sc = SidecarClient(ctx.sidecar_url(f"preflight-{uuid.uuid4().hex[:6]}", "player"), display_name="preflight",
                   stable_id=uuid.uuid4().hex, name="preflight")
sc.connect(timeout=15)
ok = sc.wait_roster(timeout=15)
sc.close()
sys.exit(0 if ok else 1)
PYEOF
then note "ok" "wss://$HOST/ws roster received"; else note "FAIL" "sidecar /ws handshake failed"; fi

echo "conductor:"
CADMIN="$($PY "$HERE/cfg.py" inv "$INV" vms.bots.conductor_admin 2>/dev/null)"
BOTS_SSH="$($PY "$HERE/cfg.py" inv "$INV" vms.bots.ssh 2>/dev/null)"
if [[ -n "$CADMIN" ]]; then
  MB=$(ssh -o BatchMode=yes "$BOTS_SSH" "curl -s --max-time 6 $CADMIN/api/config" 2>/dev/null \
        | $PY -c 'import sys,json;print(json.load(sys.stdin).get("maxBots","?"))' 2>/dev/null || echo "?")
  note "ok" "conductor reachable, maxBots=$MB (S2 raises this per cell)"
fi

echo "generator tooling:"
REPO_DIR="$($PY "$HERE/cfg.py" inv "$INV" campaign.repo_dir)"
VENV="$($PY "$HERE/cfg.py" inv "$INV" campaign.venv)"
while IFS=$'\t' read -r name ssh iface _r browsers _g _n; do
  [[ -z "${name:-}" ]] && continue
  out=$(ssh -o BatchMode=yes "$ssh" bash -lc "'
    command -v node >/dev/null && echo node:ok || echo node:MISSING
    test -d $REPO_DIR/node_modules/yjs && echo yjs:ok || echo yjs:MISSING
    test -x $VENV/bin/locust && echo locust:ok || echo locust:MISSING
    $VENV/bin/python -c \"import playwright\" 2>/dev/null && echo pw:ok || echo pw:MISSING
    test -s $REPO_DIR/loadtest/media/seeds/camera.y4m && echo seeds:ok || echo seeds:MISSING
    tc -V >/dev/null 2>&1 && echo tc:ok || echo tc:MISSING
    df -PBG $REPO_DIR | awk \"NR==2{print \\\"disk:\\\" \\\$4}\"
  '" 2>/dev/null)
  echo "  [$name] $(echo "$out" | tr '\n' ' ')"
  echo "$out" | grep -q MISSING && note "FAIL" "$name missing tooling (see above)"
done < <($PY "$HERE/cfg.py" generators "$INV")

echo
[[ $fail -eq 0 ]] && echo "PREFLIGHT OK" || echo "PREFLIGHT FAILED"
exit $fail

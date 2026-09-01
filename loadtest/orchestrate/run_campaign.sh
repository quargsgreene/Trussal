#!/usr/bin/env bash
# run_campaign.sh <inventory.yaml> <scenarios.yaml>
#
# The matrix runner. For every (profile, scenario) cell it:
#   1. raises the conductor MAX_BOTS if the scenario needs it (restored on exit)
#   2. starts the collectors (host_stats, jvb_stats, sidecar_observer) for the
#      cell's duration
#   3. applies the WWAN profile on every generator (+ handover overlay for the
#      extra cells)
#   4. runs distributed.sh (locust master + workers) for the scenario duration
#   5. clears netem, stops collectors, tears the room down, settles
#
# Idempotent-ish: safe to Ctrl-C — the EXIT trap clears netem, restores
# MAX_BOTS, and kills collectors. Re-run `netem.sh clear` if a hard kill
# skipped the trap.
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${LOADTEST_PY:-python3}"
LT_DIR="$(cd "$HERE/.." && pwd)"

INV=${1:?inventory.yaml}
SCEN_YAML=${2:?scenarios.yaml}
RUN_ID="${RUN_ID:-campaign-$(date +%Y%m%d-%H%M%S)}"
STEP_HOLD_SCALE="${STEP_HOLD_SCALE:-1.0}"

# Single-target by default. Set TRUSSAL_TARGET=<name> to point the whole grid at
# one of a Layout-C inventory's `targets.<name>` (and, with SNAPSHOT_ROLLBACK=1,
# cold-roll it between cells).
TARGET="${TRUSSAL_TARGET:-}"
if [[ -n "$TARGET" ]]; then
  HOST="$($PY "$HERE/cfg.py" inv "$INV" "targets.$TARGET.host")"
  COLD_SNAP="$($PY "$HERE/cfg.py" inv "$INV" campaign.sut_cold_snapshot 2>/dev/null || echo '')"
else
  HOST="$($PY "$HERE/cfg.py" inv "$INV" target.host)"
  COLD_SNAP=""
fi
SCHEME="$($PY "$HERE/cfg.py" inv "$INV" target.scheme)"
ROOM_PREFIX="$($PY "$HERE/cfg.py" inv "$INV" campaign.room_prefix)"
CADMIN="$($PY "$HERE/cfg.py" inv "$INV" vms.bots.conductor_admin 2>/dev/null || true)"
BOTS_SSH="$($PY "$HERE/cfg.py" inv "$INV" vms.bots.ssh 2>/dev/null || true)"
eval "$($PY "$HERE/cfg.py" matrix "$SCEN_YAML")"    # -> profiles= scenarios= settle=

case "$HOST" in
  meet.trussal.com|trussal.com|www.trussal.com)
    [[ "${ALLOW_PROD:-}" == "1" ]] || { echo "refusing production host $HOST (ALLOW_PROD=1 to override)"; exit 2; } ;;
esac

RESDIR="$LT_DIR/results/$RUN_ID"
mkdir -p "$RESDIR/raw" "$RESDIR/logs"
echo "RUN_ID=$RUN_ID  target=$SCHEME://$HOST  profiles=[$profiles]  scenarios=[$scenarios]"

ORIG_MAXBOTS=""
COLLECTOR_PIDS=()

conductor_maxbots() { ssh -o BatchMode=yes "$BOTS_SSH" "curl -s --max-time 6 $CADMIN/api/config" \
  | $PY -c 'import sys,json;print(json.load(sys.stdin).get("maxBots",""))' 2>/dev/null; }
set_maxbots() { [[ -n "$CADMIN" ]] || return 0
  ssh -o BatchMode=yes "$BOTS_SSH" \
    "curl -s --max-time 6 -XPOST -H 'content-type: application/json' -d '{\"maxBots\":$1}' $CADMIN/api/config" >/dev/null 2>&1 \
    && echo "  conductor maxBots -> $1"; }

cleanup() {
  echo ">> cleanup"
  for p in "${COLLECTOR_PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  bash "$HERE/netem.sh" clear "$INV" || true
  [[ -n "$ORIG_MAXBOTS" ]] && set_maxbots "$ORIG_MAXBOTS" || true
}
trap cleanup EXIT INT TERM

start_collectors() {
  local dur=$1 room=$2
  RUN_ID=$RUN_ID PROFILE=$PROFILE SCENARIO=$SCENARIO TRUSSAL_HOST=$HOST TRUSSAL_SCHEME=$SCHEME TRUSSAL_TARGET="$TARGET" INVENTORY=$INV \
    "$PY" "$LT_DIR/collectors/host_stats.py" --inventory "$INV" --duration "$dur" \
    >"$RESDIR/logs/host_stats-$CELL.log" 2>&1 & COLLECTOR_PIDS+=($!)
  RUN_ID=$RUN_ID PROFILE=$PROFILE SCENARIO=$SCENARIO TRUSSAL_HOST=$HOST TRUSSAL_SCHEME=$SCHEME TRUSSAL_TARGET="$TARGET" INVENTORY=$INV \
    "$PY" "$LT_DIR/collectors/jvb_stats.py" --inventory "$INV" --duration "$dur" \
    >"$RESDIR/logs/jvb_stats-$CELL.log" 2>&1 & COLLECTOR_PIDS+=($!)
  RUN_ID=$RUN_ID PROFILE=$PROFILE SCENARIO=$SCENARIO TRUSSAL_HOST=$HOST TRUSSAL_SCHEME=$SCHEME TRUSSAL_TARGET="$TARGET" INVENTORY=$INV \
    "$PY" "$LT_DIR/collectors/sidecar_observer.py" --room "$room" --duration "$dur" \
    >"$RESDIR/logs/observer-$CELL.log" 2>&1 & COLLECTOR_PIDS+=($!)
}
stop_collectors() {
  for p in "${COLLECTOR_PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true
  COLLECTOR_PIDS=()
}

cell_duration() {  # sum(step hold_s)*scale + settle + ramp buffer
  local sid=$1
  "$PY" - "$SCEN_YAML" "$sid" "$STEP_HOLD_SCALE" "$settle" <<'PYEOF'
import sys, yaml
y = yaml.safe_load(open(sys.argv[1]))
sid, scale, settle = sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
scen = next(v for v in y["scenarios"].values() if v["id"] == sid)
hold = sum(float(s["hold_s"]) for s in scen["steps"]) * scale
print(int(hold + settle + 180))
PYEOF
}

run_cell() {   # $1 profile  $2 scenario  $3 handover(0/1)
  export PROFILE=$1 SCENARIO=$2
  local handover=$3
  CELL="${PROFILE}-${SCENARIO}"; [[ $handover == 1 ]] && CELL="${CELL}-handover"
  local room="${ROOM_PREFIX}-${CELL}-$(date +%s)"
  local dur; dur=$(cell_duration "$SCENARIO")
  echo
  echo "================ CELL $CELL  room=$room  ~${dur}s ================"

  if [[ "$SCENARIO" == "S2" && -n "$CADMIN" ]]; then
    local want; want=$($PY "$HERE/cfg.py" scenario "$SCEN_YAML" S2 require_max_bots)
    set_maxbots "$want"
  fi

  if [[ "${SNAPSHOT_ROLLBACK:-}" == "1" && -n "$TARGET" && -n "$COLD_SNAP" ]]; then
    echo ">> rollback $TARGET to snapshot '$COLD_SNAP'"
    bash "$LT_DIR/tools/proxmox/snapshot.sh" rollback "$COLD_SNAP" "$TARGET" || true
    sleep 45
  fi

  start_collectors "$dur" "$room"
  sleep 3
  if [[ $handover == 1 ]]; then
    bash "$HERE/netem.sh" apply "$PROFILE" "$INV" --handover
  else
    bash "$HERE/netem.sh" apply "$PROFILE" "$INV"
  fi

  STEP_HOLD_SCALE=$STEP_HOLD_SCALE \
    bash "$HERE/distributed.sh" "$INV" "$SCENARIO" "$PROFILE" "$RUN_ID" "$dur" "$room" "$TARGET" \
    2>&1 | tee "$RESDIR/logs/distributed-$CELL.log"

  bash "$HERE/netem.sh" clear "$INV"
  stop_collectors
  [[ "$SCENARIO" == "S2" && -n "$ORIG_MAXBOTS" ]] && set_maxbots "$ORIG_MAXBOTS"
  echo "---- settle ${settle}s ----"; sleep "$settle"
}

# ---- record run metadata ----
[[ -n "$CADMIN" ]] && ORIG_MAXBOTS="$(conductor_maxbots)"
"$PY" - "$RESDIR/meta.json" "$RUN_ID" "$HOST" "$profiles" "$scenarios" <<'PYEOF'
import json, subprocess, sys, time
out, run_id, host, profiles, scenarios = sys.argv[1:6]
try:
    rev = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
except Exception:
    rev = None
json.dump({"run_id": run_id, "target_host": host, "git_rev": rev,
           "profiles": profiles.split(","), "scenarios": scenarios.split(","),
           "started": time.strftime("%Y-%m-%dT%H:%M:%S%z")}, open(out, "w"), indent=2)
PYEOF

# ---- the grid ----
IFS=',' read -ra PROFS <<< "$profiles"
IFS=',' read -ra SCENS <<< "$scenarios"
for p in "${PROFS[@]}"; do
  for s in "${SCENS[@]}"; do
    run_cell "$p" "$s" 0
  done
done

# ---- extra cells (handover overlay) ----
mapfile -t EXTRA < <($PY - "$SCEN_YAML" <<'PYEOF'
import yaml, sys
m = yaml.safe_load(open(sys.argv[1]))["matrix"]
for c in m.get("extra_cells", []):
    if c.get("handover"):
        for s in c["scenarios"]:
            print(f"{c['profile']} {s}")
PYEOF
)
for line in "${EXTRA[@]:-}"; do
  [[ -z "$line" ]] && continue
  run_cell $line 1
done

trap - EXIT INT TERM
cleanup
echo
echo "CAMPAIGN $RUN_ID COMPLETE"
echo "  $PY analysis/ingest.py  results/$RUN_ID"
echo "  $PY analysis/metrics.py results/$RUN_ID"
echo "  $PY figures/render_all.py --run results/$RUN_ID --column single"

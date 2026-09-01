#!/usr/bin/env bash
# run_turnstudy.sh <inventory.proxmox-C.yaml> <scenarios.yaml>
#
# Layout C — the consistent-hash vs maintained-literal turn-assignment study.
# For each profile in scenarios.yaml `turn_study.profiles`:
#
#   S5 (matched load)  apply netem once, run distributed.sh for BOTH targets
#                      concurrently (identical schedule + wall clock + link), so
#                      the only difference is turn_mode. -> turn_stability.parquet
#   S6 (break find)    run distributed.sh for EACH target alone; BreakFindShape
#                      ramps until BreakDetector trips. -> break_points.parquet
#
# SNAPSHOT_ROLLBACK=1  -> qm rollback each SUT to `sut_cold_snapshot` between
#                         cells (needs tools/proxmox/vmmap.env; PVE_HOST if this
#                         host can't `qm`).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${LOADTEST_PY:-python3}"
LT_DIR="$(cd "$HERE/.." && pwd)"

INV=${1:?inventory.proxmox-C.yaml}
SCEN_YAML=${2:?scenarios.yaml}
RUN_ID="${RUN_ID:-turnstudy-$(date +%Y%m%d-%H%M%S)}"
STEP_HOLD_SCALE="${STEP_HOLD_SCALE:-1.0}"

read_ts() { $PY - "$SCEN_YAML" "$1" <<'PYEOF'
import sys, yaml
print(yaml.safe_load(open(sys.argv[1]))["turn_study"].get(sys.argv[2], ""))
PYEOF
}
PROFILES="$($PY - "$SCEN_YAML" <<'PYEOF'
import sys, yaml
print(",".join(yaml.safe_load(open(sys.argv[1]))["turn_study"]["profiles"]))
PYEOF
)"
SETTLE="$(read_ts intercell_settle_s)"; SETTLE=${SETTLE:-90}
COLD_SNAP="$($PY "$HERE/cfg.py" inv "$INV" campaign.sut_cold_snapshot 2>/dev/null || echo '')"
ROOM_PREFIX="$($PY "$HERE/cfg.py" inv "$INV" campaign.room_prefix)"
mapfile -t TARGETS < <($PY "$HERE/cfg.py" targets "$INV" | cut -f1)

RESDIR="$LT_DIR/results/$RUN_ID"; mkdir -p "$RESDIR/raw" "$RESDIR/logs"
echo "RUN_ID=$RUN_ID  targets=[${TARGETS[*]}]  profiles=[$PROFILES]"

COLLECTOR_PIDS=()
cleanup() {
  for p in "${COLLECTOR_PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  bash "$HERE/netem.sh" clear "$INV" || true
}
trap cleanup EXIT INT TERM

rollback_cold() {
  [[ "${SNAPSHOT_ROLLBACK:-}" == "1" && -n "$COLD_SNAP" ]] || return 0
  echo ">> rollback SUTs to snapshot '$COLD_SNAP'"
  bash "$LT_DIR/tools/proxmox/snapshot.sh" rollback "$COLD_SNAP" "$@" || true
  sleep 45   # let the stacks come back up
}

start_collectors() {  # $1 dur  $2 room  $3 target
  local dur=$1 room=$2 target=$3
  local host scheme
  host="$($PY "$HERE/cfg.py" inv "$INV" "targets.$target.host")"
  scheme="$($PY "$HERE/cfg.py" inv "$INV" "targets.$target.scheme")"
  local turn_mode; turn_mode="$($PY "$HERE/cfg.py" inv "$INV" "targets.$target.turn_mode")"
  local env="RUN_ID=$RUN_ID PROFILE=$PROFILE SCENARIO=$SID TRUSSAL_HOST=$host TRUSSAL_SCHEME=$scheme \
    TRUSSAL_TARGET=$target TRUSSAL_TURN_MODE=$turn_mode INVENTORY=$INV"
  eval "$env $PY $LT_DIR/collectors/sidecar_observer.py --room ${room}-${target//_/-} --duration $dur" \
    >"$RESDIR/logs/observer-$PROFILE-$SID-$target.log" 2>&1 & COLLECTOR_PIDS+=($!)
  eval "$env $PY $LT_DIR/collectors/host_stats.py --inventory $INV --duration $dur" \
    >"$RESDIR/logs/host_stats-$PROFILE-$SID-$target.log" 2>&1 & COLLECTOR_PIDS+=($!)
  eval "$env $PY $LT_DIR/collectors/jvb_stats.py --inventory $INV --duration $dur" \
    >"$RESDIR/logs/jvb_stats-$PROFILE-$SID-$target.log" 2>&1 & COLLECTOR_PIDS+=($!)
}
stop_collectors() {
  for p in "${COLLECTOR_PIDS[@]:-}"; do kill "$p" 2>/dev/null || true; done
  wait 2>/dev/null || true; COLLECTOR_PIDS=()
}

cell_duration() {  # $1 scenario id
  $PY - "$SCEN_YAML" "$1" "$STEP_HOLD_SCALE" "$SETTLE" <<'PYEOF'
import sys, yaml
y = yaml.safe_load(open(sys.argv[1])); sid, scale, settle = sys.argv[2], float(sys.argv[3]), float(sys.argv[4])
scen = next(v for v in y["scenarios"].values() if v["id"] == sid)
if "steps" in scen:
    hold = sum(float(s["hold_s"]) for s in scen["steps"]) * scale
else:
    r = scen["ramp"]; hold = ((r["max"] - r["start"]) / r["increment"] + 1) * r["dwell_s"] * scale
print(int(hold + settle + 180))
PYEOF
}

IFS=',' read -ra PROFS <<< "$PROFILES"
for PROFILE in "${PROFS[@]}"; do

  # ---- S5: matched load, both targets at once ----
  SID=S5
  room="${ROOM_PREFIX}-${PROFILE}-s5-$(date +%s)"
  dur=$(cell_duration S5)
  echo; echo "===== $PROFILE / S5 matched  (~${dur}s) ====="
  rollback_cold "${TARGETS[@]}"
  for t in "${TARGETS[@]}"; do start_collectors "$dur" "$room" "$t"; done
  sleep 3
  bash "$HERE/netem.sh" apply "$PROFILE" "$INV"
  pids=()
  for t in "${TARGETS[@]}"; do
    STEP_HOLD_SCALE=$STEP_HOLD_SCALE \
      bash "$HERE/distributed.sh" "$INV" S5 "$PROFILE" "$RUN_ID" "$dur" "$room" "$t" \
      >"$RESDIR/logs/distributed-$PROFILE-S5-$t.log" 2>&1 & pids+=($!)
  done
  for p in "${pids[@]}"; do wait "$p" || true; done
  bash "$HERE/netem.sh" clear "$INV"
  stop_collectors
  echo "---- settle ${SETTLE}s ----"; sleep "$SETTLE"

  # ---- S6: break-find, one target at a time ----
  SID=S6
  for t in "${TARGETS[@]}"; do
    room="${ROOM_PREFIX}-${PROFILE}-s6-$(date +%s)"
    dur=$(cell_duration S6)
    echo; echo "===== $PROFILE / S6 break-find  target=$t  (<=${dur}s) ====="
    rollback_cold "$t"
    start_collectors "$dur" "$room" "$t"
    sleep 3
    bash "$HERE/netem.sh" apply "$PROFILE" "$INV"
    STEP_HOLD_SCALE=$STEP_HOLD_SCALE \
      bash "$HERE/distributed.sh" "$INV" S6 "$PROFILE" "$RUN_ID" "$dur" "$room" "$t" \
      2>&1 | tee "$RESDIR/logs/distributed-$PROFILE-S6-$t.log"
    bash "$HERE/netem.sh" clear "$INV"
    stop_collectors
    echo "---- settle ${SETTLE}s ----"; sleep "$SETTLE"
  done
done

trap - EXIT INT TERM
cleanup
echo
echo "TURN STUDY $RUN_ID COMPLETE"
echo "  $PY analysis/ingest.py  results/$RUN_ID"
echo "  $PY analysis/metrics.py results/$RUN_ID"
echo "  $PY figures/fig09_turn_stability.py --run results/$RUN_ID --column double"
echo "  $PY figures/fig10_breakpoint.py     --run results/$RUN_ID"

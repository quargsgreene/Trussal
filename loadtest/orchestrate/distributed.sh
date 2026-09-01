#!/usr/bin/env bash
# distributed.sh <inventory.yaml> <scenario_id> <profile_id> <run_id> <duration_s> <room> [target_name]
#
# Runs ONE matrix cell against ONE system under test: a locust master locally
# (this host has role `master`) plus N --worker processes per generator
# (proportional to media_browsers capacity, NUMA-pinned). Blocks until the
# master exits, then reaps stragglers.
#
# `target_name` (Layout C): resolves host/scheme/turn_mode from
# inventory `targets.<name>.*`, suffixes the room + master port, so two
# invocations (sut_explicit / sut_hash) run side by side. Omitted -> single
# `target.*` (Layout A/B).
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${LOADTEST_PY:-python3}"

INV=${1:?} SID=${2:?} PID=${3:?} RUN_ID=${4:?} DUR=${5:?} ROOM=${6:?} TARGET=${7:-}

if [[ -n "$TARGET" ]]; then
  HOST="$($PY "$HERE/cfg.py" inv "$INV" "targets.$TARGET.host")"
  SCHEME="$($PY "$HERE/cfg.py" inv "$INV" "targets.$TARGET.scheme")"
  TURN_MODE="$($PY "$HERE/cfg.py" inv "$INV" "targets.$TARGET.turn_mode" 2>/dev/null || echo '')"
  ROOM="${ROOM}-${TARGET//_/-}"
  CELL="${PID}-${SID}-${TARGET}"
  # distinct master port per target so two masters coexist on gen-master
  MASTER_PORT=$(( 5557 + $(cksum <<<"$TARGET" | cut -d' ' -f1) % 200 ))
else
  HOST="$($PY "$HERE/cfg.py" inv "$INV" target.host)"
  SCHEME="$($PY "$HERE/cfg.py" inv "$INV" target.scheme)"
  TURN_MODE=""
  CELL="${PID}-${SID}"
  MASTER_PORT=5557
fi
REPO_DIR="$($PY "$HERE/cfg.py" inv "$INV" campaign.repo_dir)"
VENV="$($PY "$HERE/cfg.py" inv "$INV" campaign.venv)"
LT_DIR="$REPO_DIR/loadtest"
MASTER_IP="$(hostname -I | awk '{print $1}')"
CSV="$LT_DIR/results/$RUN_ID/raw/locust-$CELL"
mkdir -p "$LT_DIR/results/$RUN_ID/raw" "$LT_DIR/results/$RUN_ID/logs"

export RUN_ID PROFILE="$PID" SCENARIO="$SID" TRUSSAL_HOST="$HOST" TRUSSAL_SCHEME="$SCHEME"
export TRUSSAL_TARGET="$TARGET" TRUSSAL_TURN_MODE="$TURN_MODE"
export LT_ROOM="$ROOM" INVENTORY="$INV"
export LT_SEED_VIDEO="$LT_DIR/media/seeds/camera_320x240_15.y4m"
export LT_SEED_AUDIO="$LT_DIR/media/seeds/mic_16k.wav"

# ---- plan worker processes: ~1 worker per 40 browsers of capacity, min 1 ----
declare -A WCOUNT; TOTAL_W=0
while IFS=$'\t' read -r name ssh iface roles browsers ghost numa; do
  [[ -z "${name:-}" ]] && continue
  [[ ",$roles," == *",worker,"* ]] || continue
  w=$(( (browsers + 39) / 40 )); (( w < 1 )) && w=1
  WCOUNT["$name|$ssh|$numa"]=$w
  TOTAL_W=$(( TOTAL_W + w ))
done < <($PY "$HERE/cfg.py" generators "$INV")
echo "distributed: cell $CELL  room=$ROOM  workers=$TOTAL_W  dur=${DUR}s"

PIDFILE="$LT_DIR/results/$RUN_ID/logs/workers-$CELL.pids"; : > "$PIDFILE"

start_workers() {
  for key in "${!WCOUNT[@]}"; do
    IFS='|' read -r name ssh numa <<< "$key"
    n=${WCOUNT[$key]}
    for i in $(seq 1 "$n"); do
      node=$(( (i - 1) % (numa > 0 ? numa : 1) ))
      remote="cd $LT_DIR && \
        RUN_ID=$RUN_ID PROFILE=$PID SCENARIO=$SID TRUSSAL_HOST=$HOST TRUSSAL_SCHEME=$SCHEME \
        TRUSSAL_TARGET=$TARGET TRUSSAL_TURN_MODE=$TURN_MODE \
        LT_ROOM=$ROOM INVENTORY=$INV \
        LT_SEED_VIDEO=$LT_DIR/media/seeds/camera_320x240_15.y4m \
        LT_SEED_AUDIO=$LT_DIR/media/seeds/mic_16k.wav \
        nohup numactl --cpunodebind=$node --preferred=$node \
        $VENV/bin/locust -f locust/locustfile.py --worker --master-host=$MASTER_IP \
        --master-port=$MASTER_PORT \
        --logfile results/$RUN_ID/logs/worker-$name-$i-$CELL.log \
        >/dev/null 2>&1 & echo \$!"
      wpid=$(ssh -o BatchMode=yes "$ssh" bash -lc "'$remote'")
      echo "$ssh $wpid" >> "$PIDFILE"
    done
    echo "  $name: $n workers"
  done
}

stop_workers() {
  while read -r ssh wpid; do
    [[ -n "$wpid" ]] && ssh -o BatchMode=yes "$ssh" "kill $wpid 2>/dev/null; pkill -P $wpid 2>/dev/null" || true
  done < "$PIDFILE"
}
trap stop_workers EXIT

start_workers
sleep 4

# ---- master (local) ----
# -u/-r are a ceiling; CampaignShape drives the real schedule and stops the run.
"$VENV/bin/locust" -f "$LT_DIR/locust/locustfile.py" --master \
  --master-bind-port "$MASTER_PORT" \
  --headless --expect-workers "$TOTAL_W" --expect-workers-max-wait 120 \
  -u 100000 -r 200 -t "$((DUR + 120))s" \
  --host "$SCHEME://$HOST" \
  --csv "$CSV" --csv-full-history \
  --logfile "$LT_DIR/results/$RUN_ID/logs/master-$CELL.log" \
  --exit-code-on-error 0 || true

stop_workers
trap - EXIT
echo "distributed: cell $CELL done"

#!/usr/bin/env bash
# snapshot.sh <create|rollback|delete> <snap-name> [target ...]
#
# Snapshot / roll back the SUT VMs by name, using tools/proxmox/vmmap.env
# (written by provision.sh). With no target names, acts on every VMID_sut_*.
#
#   snapshot.sh create   cold                  # after a fresh idle boot
#   snapshot.sh rollback cold sut_explicit      # run_campaign.sh calls this per cell
#   snapshot.sh delete   cold
#
# Runs `qm` locally on a Proxmox node, or `ssh root@$PVE_HOST qm …` when set
# (for a campaign driven from a generator VM that can't `qm`).
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
[[ -f "$HERE/vmmap.env" ]] || { echo "no vmmap.env — run provision.sh first"; exit 1; }
source "$HERE/vmmap.env"

ACTION="${1:?create|rollback|delete}"
SNAP="${2:?snapshot name}"
shift 2 || true
TARGETS=("$@")

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  mapfile -t TARGETS < <(compgen -A variable | sed -n 's/^VMID_\(sut_[A-Za-z0-9]*\)$/\1/p')
fi

qm_on() {  # $1 = node, rest = qm args
  local node=$1; shift
  if [[ -n "${PVE_HOST:-}" ]]; then ssh -o BatchMode=yes "root@$PVE_HOST" "qm $*"
  elif [[ "$(hostname -s)" == "$node" ]]; then qm "$@"
  else ssh -o BatchMode=yes "root@$node" "qm $*"; fi
}

for target in "${TARGETS[@]}"; do
  vmid_var="VMID_${target}"; node_var="NODE_${target}"
  vmid="${!vmid_var:-}"; node="${!node_var:-}"
  [[ -n "$vmid" ]] || { echo "!! no VMID for $target in vmmap.env"; continue; }
  case "$ACTION" in
    create)   echo ">> $target ($vmid): snapshot $SNAP"
              qm_on "$node" snapshot "$vmid" "$SNAP" --description "loadtest cold state" ;;
    rollback) echo ">> $target ($vmid): rollback $SNAP"
              qm_on "$node" rollback "$vmid" "$SNAP"
              qm_on "$node" start "$vmid" || true ;;
    delete)   echo ">> $target ($vmid): delsnapshot $SNAP"
              qm_on "$node" delsnapshot "$vmid" "$SNAP" ;;
    *) echo "unknown action $ACTION"; exit 2 ;;
  esac
done

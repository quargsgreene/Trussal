#!/usr/bin/env bash
# netem.sh — apply / clear a WWAN profile on every generator's uplink.
# Runs from gen-a. SSHes into each generator and invokes netem_apply.sh there
# under sudo. Shapes only traffic toward campaign.vm_subnet.
#
#   netem.sh apply  <profile_id> <inventory.yaml> [--handover]
#   netem.sh clear  <inventory.yaml>
#   netem.sh show   <inventory.yaml>
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${LOADTEST_PY:-python3}"
NETEM_YAML="${NETEM_YAML:-$HERE/../config/netem_profiles.yaml}"
REMOTE_APPLY="${REMOTE_APPLY:-loadtest/orchestrate/netem_apply.sh}"   # path on the generator, relative to campaign.repo_dir

action=${1:?apply|clear|show}
case "$action" in
  apply) PROFILE=${2:?profile id}; INV=${3:?inventory.yaml}; HANDOVER=${4:-} ;;
  clear|show) INV=${2:?inventory.yaml} ;;
esac

SUBNET="$($PY "$HERE/cfg.py" inv "$INV" campaign.vm_subnet)"
REPO_DIR="$($PY "$HERE/cfg.py" inv "$INV" campaign.repo_dir)"

while IFS=$'\t' read -r name ssh iface roles browsers ghost numa; do
  [[ -z "${name:-}" ]] && continue
  case "$action" in
    apply)
      read -r D J L LC RE DUP COR RDOWN RUP BL < <($PY "$HERE/cfg.py" netem-line "$NETEM_YAML" "$PROFILE")
      echo ">> $name ($ssh) $iface  <= $PROFILE"
      ssh -o BatchMode=yes "$ssh" \
        "sudo $REPO_DIR/$REMOTE_APPLY apply '$iface' '$SUBNET' $D $J $L $LC $RE $DUP $COR $RDOWN $RUP $BL"
      if [[ "$HANDOVER" == "--handover" ]]; then
        read -r base smin smax bloss bs emin emax < <($PY "$HERE/cfg.py" netem-handover "$NETEM_YAML")
        echo ">> $name  handover overlay (stall ${smin}-${smax}ms, burst ${bloss}%)"
        ssh -o BatchMode=yes "$ssh" \
          "sudo $REPO_DIR/$REMOTE_APPLY handover-start '$iface' $smax $bloss $bs $emin $emax"
      fi
      ;;
    clear)
      echo ">> $name ($ssh) clear $iface"
      ssh -o BatchMode=yes "$ssh" "sudo $REPO_DIR/$REMOTE_APPLY clear '$iface'" || true
      ;;
    show)
      ssh -o BatchMode=yes "$ssh" "sudo $REPO_DIR/$REMOTE_APPLY show '$iface'" || true
      ;;
  esac
done < <($PY "$HERE/cfg.py" generators "$INV")

echo "netem.sh: $action done"

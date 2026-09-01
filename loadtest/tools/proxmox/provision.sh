#!/usr/bin/env bash
# provision.sh <inventory.proxmox-C.yaml> [--apply]
#
# Linked-clones the Layout-C VM set from the three templates and configures each
# (cores / memory / NUMA / cpu host / balloon 0 / net1 on vmbr1). DRY RUN by
# default — prints every `qm` command; --apply runs them (over ssh to each VM's
# proxmox `node`, or locally if run on that node).
#
# Reads template vmids from tools/proxmox/templates.env; writes the
# target/host -> vmid map to tools/proxmox/vmmap.env for snapshot.sh.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY="${LOADTEST_PY:-python3}"
INV="${1:?inventory.proxmox-C.yaml}"
APPLY="${2:-}"
[[ -f "$HERE/templates.env" ]] && source "$HERE/templates.env"
FIRST_CLONE_VMID="${FIRST_CLONE_VMID:-1201}"
: > "$HERE/vmmap.env"

this_node="$(hostname -s 2>/dev/null || echo '')"
run_on() {  # $1 = proxmox node, rest = command
  local node=$1; shift
  if [[ "$APPLY" != "--apply" ]]; then echo "  [$node] $*"; return 0; fi
  if [[ "$node" == "$this_node" ]]; then eval "$@"; else ssh -o BatchMode=yes "root@$node" "$@"; fi
}

# one YAML reader pass -> TSV: kind mapkey clonename node template vcpus ram_gib numa pin bridges_csv
mapfile -t VM_ROWS < <("$PY" - "$INV" <<'PYEOF'
import sys, yaml
inv = yaml.safe_load(open(sys.argv[1]))
def emit(kind, mapkey, clonename, spec):
    px = spec.get("proxmox") or {}
    if not px: return
    print("\t".join(str(x) for x in [
        kind, mapkey, clonename, px.get("node","?"), px.get("template","?"),
        px.get("vcpus",4), px.get("ram_gib",8), px.get("numa",0), px.get("pin",""),
        ",".join(px.get("bridges",["vmbr0","vmbr1"])),
    ]))
for name, spec in (inv.get("targets") or {}).items():
    emit("sut", name, name.replace("_","-"), spec)
for name, spec in (inv.get("sut_bots") or {}).items():
    emit("bots", f"{name}_bots", name.replace("_","-") + "-bots", spec)
for gen in (inv.get("generators") or []):
    emit("gen", gen["name"], gen["name"], gen)
PYEOF
)

vmid=$FIRST_CLONE_VMID
for row in "${VM_ROWS[@]}"; do
  IFS=$'\t' read -r kind mapkey clone_name node template vcpus ram_gib numa pin bridges <<< "$row"
  tmpl_var="TEMPLATE_${template//-/_}"
  tmpl_vmid="${!tmpl_var:-<set-$tmpl_var-in-templates.env>}"
  ram_mib=$(( ram_gib * 1024 ))
  echo ">> $clone_name  (vmid $vmid, from $template=$tmpl_vmid, node $node)"
  run_on "$node" "qm clone $tmpl_vmid $vmid --name $clone_name --full 0 --target $node"
  run_on "$node" "qm set $vmid --cores $vcpus --memory $ram_mib --balloon 0 --cpu host --numa ${numa:+1} --onboot 1"
  [[ -n "$pin" ]] && run_on "$node" "qm set $vmid --affinity $pin"
  # net0 already on vmbr0 from the template; add net1 on the isolated test bridge
  [[ ",$bridges," == *",vmbr1,"* ]] && run_on "$node" "qm set $vmid --net1 virtio,bridge=vmbr1,queues=$vcpus"
  run_on "$node" "qm start $vmid"
  envkey="${mapkey//[^A-Za-z0-9_]/_}"   # valid shell var name for `source`
  echo "VMID_${envkey}=$vmid"           >> "$HERE/vmmap.env"
  echo "NODE_${envkey}=$node"           >> "$HERE/vmmap.env"
  vmid=$(( vmid + 1 ))
done

echo
echo "vmmap written to $HERE/vmmap.env"
[[ "$APPLY" == "--apply" ]] || echo "(dry run — re-run with --apply)"

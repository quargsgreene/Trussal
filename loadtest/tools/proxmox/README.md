# Proxmox provisioning — Layout C

Three physical nodes in a Proxmox cluster:

| node | role in the study | VMs |
|------|-------------------|-----|
| **c1** (Xeon E5-2640v4 ×2, 40 t, 31 GiB) | `sut_explicit` arm | `sut-explicit`, `sut-explicit-bots` |
| **c3** (Threadripper 3970X, 64 t, 125 GiB) | `sut_hash` arm | `sut-hash`, `sut-hash-bots` |
| **c2** (Xeon E5-2640v4 ×2, 40 t, 31 GiB) | generators + break-finder | `gen-master`, `gen-worker` |

The two SUTs are **identical clones** of one `trussal-sut` template — "explicit" vs
"hash" is only what the harness writes into the shared metaprogram
(`inventory.proxmox-C.yaml` → `targets.<name>.turn_mode`).

---

## 1. Manual, once (Proxmox console / shell on each node)

### 1a. Cluster (needed only for `snapshot.sh` rollback-per-cell)

```bash
# on c1
pvecm create trussal-lab
# on c2 and c3
pvecm add <c1-ip>
```

### 1b. The isolated test bridge `vmbr1`

Management/SSH/corosync stay on `vmbr0`; SUT↔generator traffic goes on `vmbr1`
so `netem` and byte accounting see only test traffic. On **every** node, in
`/etc/network/interfaces` (or the GUI → System → Network):

```
auto vmbr1
iface vmbr1 inet manual
    bridge-ports none          # or a spare physical NIC, e.g. enp3s0f1
    bridge-stp off
    bridge-fd 0
```

`ifreload -a`. Give the VMs static addresses on `10.20.0.0/24` (vmbr1) and
`10.0.0.0/24` (vmbr0) — matching `inventory.proxmox-C.yaml`.

### 1c. Templates (install once, then convert to template)

Build three VMs from a Debian 12 ISO, install the prerequisites, shut down, then
`qm template <vmid>`:

| template | vmid (suggested) | contents |
|----------|------------------|----------|
| `trussal-sut` | 9000 | Docker + `git clone` the repo + `docker-jitsi-meet/.env` (set `COLIBRI_REST_ENABLED=1`, `ENABLE_P2P=0`) + `run.sh` works once |
| `trussal-gen` | 9001 | `python3-venv`, `pip install -r loadtest/requirements.txt`, `playwright install chromium` + deps, `iproute2`, `numactl`, `bash loadtest/tools/make_seeds.sh` |
| `trussal-bots` | 9002 | Docker + repo clone + `bots/.env` (SIDECAR_WS_URL, FLEET_CONTROL_TOKEN, JAMULUS_SERVER, SIDECAR_HOST_ALIAS) + `snd-aloop` at boot |

Record the vmids in `tools/proxmox/templates.env`:

```
TEMPLATE_trussal_sut=9000
TEMPLATE_trussal_gen=9001
TEMPLATE_trussal_bots=9002
FIRST_CLONE_VMID=1201        # clones are numbered from here
```

## 2. Clone the Layout-C set

From any node (or a workstation with `ssh` to the nodes):

```bash
cd loadtest
# dry run — prints every `qm` command it would run
tools/proxmox/provision.sh config/inventory.proxmox-C.yaml
# do it
tools/proxmox/provision.sh config/inventory.proxmox-C.yaml --apply
```

`provision.sh` linked-clones each VM in the inventory's `proxmox:` blocks onto
its `node`, sets `--cores/--memory/--numa/--cpu host/--balloon 0`, attaches
`net1` on `vmbr1`, and boots it. It writes `tools/proxmox/vmmap.env`
(target/host name → vmid) for `snapshot.sh`.

Then, inside each VM: set its two static IPs, `git pull` the repo to the paths
in the inventory, and (SUTs) `JAMULUS_HOST=jamulus.trussal.com ./run.sh` once.

## 3. Cold snapshot for rollback-per-cell (optional)

```bash
# once, with each SUT freshly booted and idle:
tools/proxmox/snapshot.sh create cold
```

Then run the campaign with `SNAPSHOT_ROLLBACK=1` — `run_campaign.sh` calls
`snapshot.sh rollback cold <target>` between cells so every cell starts from a
cold stack (no warm-cache drift). `PVE_HOST=<a-node>` if you run the campaign
from a VM that can't `qm` locally (it will `ssh $PVE_HOST qm …`).

## Checkpoint A (before all this): one VM

Just `trussal-sut` template + one clone, to smoke the real join / observe /
netem path and `provision.sh` itself. `preflight.sh` against a one-line
inventory pointed at that clone.

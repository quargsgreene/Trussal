# Checkpoint A — results

Date: 2026-09-01. Operator-driven smoke, run from the workstation
(`192.168.1.134`) against two Proxmox VMs on node `fleshcomputer`.

**Purpose:** prove the harness's join → observe → shape → ingest → figures path
end to end on ONE staging SUT before building the full Layout-C VM set. Not a
load test — a plumbing test.

| VMID | name | address | role in this smoke |
|---|---|---|---|
| 1201 | `sut-explicit` | `192.168.1.41` | serves the Trussal bundle + `ws://<host>/ws` sidecar |
| 1203 | `sut-explicit-bots` | `192.168.1.42` | bot conductor; stands in for the generator VM |

Prod Trussal (`192.168.1.254` / `.120` / `.232`) was **not touched**.

---

## What passed

### 1. SUT deploy — `tools/proxmox/sut-bringup.sh`, exit 0

The `npm run dev:setup` path (standalone stack, repo-local gitignored
`docker-jitsi-meet/.jitsi-meet-cfg`, `web` binds host `80`/`443`), **not** the
prod `./run.sh` (which FATALs unless `CONFIG` points outside the repo and does a
full `compose down && up`).

All 5 containers Up (`web`, `prosody`, `jicofo`, `jvb`, `latency`). Served
surfaces, after a ~30 s prosody warm-up:

| surface | result |
|---|---|
| `GET /` | 200 |
| `/custom-config.js` | 200, contains `JAMULUS_ROOM_MAP` (×3) |
| `/http-bind` (BOSH) | 200 |
| `/xmpp-websocket` | 200 |
| `/ws` (sidecar) | 426 Upgrade Required — route live |
| prosody / jicofo / jvb | `focus@`/`jvb@` authenticated, JVB registered, brewery joined, bridge stress 0.12 |

`.env` overrides applied and verified: `ENABLE_P2P=0` (harness requirement — all
media through one JVB SFU so it is observable), `COLIBRI_REST_ENABLED=1`,
`ENABLE_XMPP_WEBSOCKET=1`, `JVB_ADVERTISED_IPS=192.168.1.41`,
`DOCKER_HOST_ADDRESS=192.168.1.41`, `ENABLE_LETSENCRYPT=0`, `RESTART_POLICY=no`.

Cosmetic only: `dev-setup.sh` and the bring-up script both append `PUBLIC_URL` /
`RESTART_POLICY`, so those two keys appear twice in `.env`. Last value wins;
harmless.

### 2. preflight — `orchestrate/preflight.sh config/inventory.checkpoint-a.yaml`

Passes on: host-not-prod guard, SSH to `.41` and `.42`, conductor reachable, and
the line that matters —

```
sidecar handshake: ws://192.168.1.41/ws  roster received  ok
```

One expected FAIL: generator tooling on `.42` (`node` / `locust` / `playwright`
/ `tc` absent). `.42` is a bare box in this smoke; that tooling is Phase 1's
`provision.sh` job and is not needed for an operator-driven run.

### 3. observe + synthetic load — `tools/proxmox/cpa-smoke-driver.py`

**A browser join does not work against this SUT** and this is expected:

* HTTPS → Chrome's self-signed-cert interstitial, which the automation
  extension cannot script past ("Cannot attach to this target").
* Plain HTTP from a non-localhost origin is not a secure context, so there is
  no `RTCPeerConnection` and Jitsi redirects to `/static/webrtcUnsupported.html`.

The campaign's `ghost_ws` clients never use a browser either — they are
`role=player` WebSocket clients (`harness/sidecar.py` `SidecarClient`) that
drive the identical sidecar/observer code paths (`peer-join` / `peer-update` /
`peer-leave` / `roster`). The driver spawns `collectors/sidecar_observer.py` as
a subprocess and runs three such players:

* staggered joins (t + 0 / 6 / 16 s)
* worsening WWAN metrics — `(rtt,jitter,loss)` stepping through
  `35/4/0.00 → 70/12/0.01 → 130/30/0.03 → 210/60/0.08 → 320/100/0.15`
  every 25 s, per-player spread added
* escalating `code_payload(kind, vol, seed)` rotating media kinds (plain /
  hydra / csscycles / samples / datapack / textcycles / images), `vol` ×1.7 per step
* player 2 **involuntary drop** (`sc.close(intentional=False)`) at + 48 s;
  players 0 and 1 clean-leave

Observer output (`results/cpa-smoke/raw/sidecar_observer.*.jsonl`):

| metric | count | note |
|---|---|---|
| `peer_join` | 3 | roomIndex 0 / 1 / 2 |
| `peer_rtt` `peer_jitter` `peer_packetLoss` `peer_rtcRtt` `peer_rtcJitter` | 173 each | synthetic WWAN ramp over real LAN RTT ~3.5 ms |
| `peer_leave` | 3 | incl. the + 48 s drop; roster steps 2 → 1 → 0 |
| `roster_size` / `roster_human` / `roster_bot` / `roster_aggregator` | 24 each | 5 s cadence |
| `observer_up` / `observer_down` | 1 each | clean lifecycle |

### 4. analysis chain — ingest → metrics → figures, exit 0

```
analysis/ingest.py  results/cpa-smoke   → observations.parquet (2 231 rows), phases.parquet, campaign.db
analysis/metrics.py results/cpa-smoke   → summary / timeseries / dropout_rate / dropouts /
                                          turn_stability / break_points parquets, campaign.db (5 tables)
figures/render_all.py --run results/cpa-smoke --column single
                                        → 10 figures, fig01–fig10, PDF + PNG
```

All ten figures render as `*_SYNTH` (watermarked synthetic reference). That is
**correct**: the smoke produced only an S0 sidecar-observer roster cell, and
every manuscript figure plots S1–S6 client / JVB / turn-study data that only a
full `run_campaign.sh` produces. Before the fixes below, six of them rendered
blank, un-watermarked axes instead.

---

## Fixes made while proving the path

| file | change |
|---|---|
| `figures/render_all.py` | one figure raising no longer aborts the batch — it prints `FAILED <module>: <err>`, renders the rest, and exits non-zero |
| `figures/_data.py` | new `ensure_scenarios(frame, scenarios, synthetic_loader)`: a run that only touched an S0 cell still writes a non-empty `summary.parquet`, so `is_synthetic` was `False` and figs 01–08 rendered blank axes. The guard swaps in the watermarked synthetic reference when the real frame has no row in the scenarios that figure plots. Also hardened `load_dropout_rate` the same way. |
| `figures/fig01,02,03,04,06` + `fig08` | call `ensure_scenarios` right after loading |
| `figures/fig05_dropout_vs_scenario.py` | self-guards `bars_per_group == 0` (was `ZeroDivisionError` on the S0-only `dropout_rate` frame) |

Verified both ways: `render_all.py --run results/cpa-smoke` and the pure
synthetic `render_all.py` (no `--run`) each exit 0 with 10 figures.

---

## Known gap — human involuntary-dropout classification (Phase 1)

`analysis/metrics.py::dropouts()` classes a departure as involuntary only from:

1. an explicit collector event — `metric ∈ {dropout, disconnected, agent_crash}`, or
2. a **bot** `peer_leave` with no operator `cluster_reset` / `spawn_request`
   within a −8 s … +2 s window.

A human / browser participant that drops emits only `peer_leave` with a roster
decrement. `SidecarClient.close(intentional=False)` sets no flag the sidecar
propagates, so in this smoke all three leaves — the deliberate + 48 s drop
included — counted as clean, and `dropouts.parquet` is empty.

**Fix (not done):** port the bot heuristic to human peers — a `peer_leave` with
no matching planned-leave event from the load generator (locust user teardown /
`media_agent` stop) inside a window is involuntary. Needs the load generators to
emit a `planned_leave` research event so the join is observable.

---

## How to reproduce

Prereqs: the two VMs up and SSH-reachable (`~/.ssh/trussal-test-key-2`), the
workstation `.venv` (`pandas` / `matplotlib` / `pyarrow` / `websocket-client` /
`pyyaml`), and `config/inventory.checkpoint-a.yaml` (gitignored — carries the VM
addresses; see `checkpoint-a-bringup.md` for the schema).

```bash
cd ~/Trussal/loadtest
export LOADTEST_PY=.venv/bin/python
ssh-add ~/.ssh/trussal-test-key-2

# 0. (first time only) deploy the SUT — detached, ~15 min
scp -i ~/.ssh/trussal-test-key-2 tools/proxmox/sut-bringup.sh trussal@192.168.1.41:~/
ssh -i ~/.ssh/trussal-test-key-2 trussal@192.168.1.41 \
  'chmod +x ~/sut-bringup.sh && nohup ~/sut-bringup.sh > ~/cpa-bringup.log 2>&1 &'
#   poll ~/cpa-bringup.log for "DONE." — then check §2 of checkpoint-a-bringup.md

# 1. preflight
bash orchestrate/preflight.sh config/inventory.checkpoint-a.yaml
#   expect: "sidecar handshake: ... ok"; the only FAIL is generator tooling on .42

# 2. observer + 3 synthetic players, one self-contained run (~2 min)
RUN_ID=cpa-smoke OBS_S=120 RUN_S=95 \
  .venv/bin/python tools/proxmox/cpa-smoke-driver.py
#   ROOM= overrides the room (default loadtest-cpa-smoke)
#   the driver reaches the SUT at 192.168.1.41 over ws:// — edit the top of the
#   file for a different host/scheme

# 3. analysis end to end
.venv/bin/python analysis/ingest.py  results/cpa-smoke
.venv/bin/python analysis/metrics.py results/cpa-smoke
.venv/bin/python figures/render_all.py --run results/cpa-smoke --column single
ls figures_out/          # 10 × (fig*.pdf + fig*.png), all _SYNTH for a smoke
```

Expected: `raw/` gets a `sidecar_observer.*.jsonl` with 3 `peer_join` + 3
`peer_leave` + ~170 of each `peer_*` metric; `tidy/observations.parquet` ≈ 2 k
rows; `render_all.py` exits 0 with 10 `*_SYNTH` figures.

### One netem step — done, on `.42` toward `192.168.1.41/32`

`tc` is at `/sbin/tc` (base image); `preflight.sh` reports it missing only
because `/sbin` is not on a non-login shell's PATH. Kernel modules
`sch_netem` / `sch_htb` / `ifb` / `act_mirred` / `cls_u32` all load.

```bash
scp orchestrate/netem_apply.sh trussal@192.168.1.42:/tmp/ && \
ssh trussal@192.168.1.42 'chmod +x /tmp/netem_apply.sh && \
  sudo /tmp/netem_apply.sh apply enp6s18 192.168.1.41/32 120 25 2 25 0 0 0 1500 700 1000'
#   args: iface subnet delay_ms jitter_ms loss% loss_corr% reorder% dup% corrupt% \
#         rate_down_kbit rate_up_kbit backlog
#   ... run the smoke driver from .42, then ...
ssh trussal@192.168.1.42 'sudo /tmp/netem_apply.sh clear enp6s18'
```

Result: `.42 → .41` RTT `0.43 ms → 132 ms` (egress-only) / `245 ms`
(bidirectional, +HTB 1500/700 kbit serialization); gateway `.1` unaffected
(the `/32` filter isolates the SUT); clean teardown to default `fq_codel`.

**Bug found + fixed** in `orchestrate/netem_apply.sh`: `modprobe ifb
numifbs=1` is a no-op when `ifb` is already loaded (e.g. `numifbs=0`), so
`ifb0` never existed and the entire ingress/downlink path was silently
skipped — the campaign needs downlink shaping most (it drives received
video bitrate). Now falls back to `ip link add ifb0 type ifb`. Verified
bidirectional after the fix.

Run the driver **on the shaping host** for netem to bite — shaping `.42`'s
NIC does nothing to a workstation-run driver. `.42` has no repo/venv yet
(Phase 1 `provision.sh`); until then, shape the workstation's iface toward
`.41` instead (this also delays your SSH to `.41`, harmless at 120 ms).

---

## Next

1. **Push blocker** — the whole `loadtest/` tree is unpushed and `origin/main`
   has advanced 34 commits with no `loadtest/`. See the repo-root divergence
   note; must be resolved before any deploy target can `git pull` the harness.
2. One netem step (above) — folded into the `provision.sh` smoke.
3. **Checkpoint B** — full Layout-C VM set + `vmbr1`. Rebuild the `trussal-sut`
   template so cloud-init actually runs (this one is inert — see
   `checkpoint-a-bringup.md` §0), and push the harness first.
4. Phase 2 — S5 matched-load → S6 break-find → analysis / figures on real data.

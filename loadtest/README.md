# Trussal load & resilience test harness

A Locust-driven campaign that stresses a **live Trussal deployment** while a
wireless-WAN (WWAN) impairment profile is stepped from clean to very poor, and
records — per client and per server — **bandwidth, frame rate, latency, jitter,
packet loss, and involuntary participant dropout** against four escalating load
scenarios:

| # | Scenario | Independent variable | Driver |
|---|----------|----------------------|--------|
| S1 | **Steady join** | humans in room over time | `HumanParticipantUser` |
| S2 | **Bot swarm** | bots spawned per owner | `BotOperatorUser` → `fleet-request` |
| S3 | **Metaprogram growth** | tokens in `$ participants` | `MetaprogramEditorUser` |
| S4 | **Code-update volume × media diversity** | payload bytes & media kind | `HumanParticipantUser` code-churn |
| S5 | **Turn stability under churn** | join+leave events / min | `ChurnUser` + `MetaprogramEditorUser`; matched-load A/B (§9) |
| S6 | **Ramp to break** | participants (open ramp) | `BreakFindShape` + `BreakDetector`; per turn-mode (§9) |

S1–S4 run once per **network profile** (§3) — headline figure shape is *metric
vs load, one line per network profile*. S5/S6 are the **turn-assignment study**
(§9): the same load against two identical Trussal clones that differ only in how
the rotation ring is derived — a maintained literal `$ participants` vs a
consistent-hash ring (`# ring hash`, `src/audio-net/TurnRing.js`).

---

## 1. Why the harness looks the way it does

Trussal is Jitsi Meet + a WebSocket "latency sidecar" + a headless-Chromium bot
fleet. The measurable surfaces:

| Plane | What lives here | How we load it | How we measure it |
|-------|-----------------|----------------|-------------------|
| **Web / static** | nginx serves `/custom-config.js`, `/config.js`, `index.html` | Locust HTTP task | Locust request stats (TTFB, bytes, failures) |
| **Signalling (XMPP)** | Prosody `xmpp-websocket`, Jicofo | real browsers joining (media agents); optional `SidecarGhostUser` | join success/latency, MUC presence, `docker stats prosody/jicofo` |
| **Media (WebRTC)** | JVB, UDP/10000, one SFU, `ENABLE_P2P=0` so **all media is bridged and observable** | real headless Chromium (Playwright) with fake A/V devices; Trussal's own bot fleet | per-client `RTCPeerConnection.getStats()` → bitrate, `framesPerSecond`, `jitter`, `packetsLost`, RTT, `freezeCount` |
| **App / peer-state** | latency sidecar `wss://<host>/ws` — roster, metrics broadcast, Strudel/CSS/data payloads, Yjs metaprogram doc, `fleet-request` | `harness/sidecar.py` clients send `pattern`/`scss`/`datapacks`/`crdt-update`/`fleet-request` | passive `sidecar_observer.py` records every `peer-*`, `metrics`, `nc-active`, `fleet-status` with monotonic arrival time |
| **Bots / conductor** | bots VM: conductor `:7777`/`:7700`, per-room aggregator, `MAX_BOTS` ceiling | `BotOperatorUser` sends `fleet-request spawn` over the sidecar (exactly the Studio path) | `docker stats trussal-bot-*`, conductor `/api/rooms`, `/api/bots` |

**Locust is the orchestrator and the app-plane load generator. It does not speak
WebRTC.** Media fidelity comes from *real* browser endpoints that Locust spawns
as subprocesses (`harness/media_agent.py`, Playwright + Chromium with
`--use-file-for-fake-video-capture`). This is the same technique Trussal's own
`bots/jitsi-bot.js` uses, so it exercises the true client stack — Strudel, Hydra,
`NetStats.js`, the studio overlay — not a protocol mock. The browser process is
kept *out* of the Locust/gevent process so a browser crash never takes down a
Locust worker, and so we scale past what an in-process driver could.

### "Human" vs "bot" behaviour

- **Human** = a Playwright Chromium that joins the room, turns the instrument on,
  and then edits code / grows the metaprogram / toggles effects on a
  human-plausible cadence with think-times drawn from a lognormal.
- **Bot** = Trussal's *actual* fleet. `BotOperatorUser` is a human pressing the
  Studio "spawn N" button; the conductor launches containerised Chromium bots on
  the bots VM. We measure the fleet's own reported metrics plus the bots VM host
  stats. This keeps the bot cost on the machine that carries it in production.

---

## 2. Host allocation

Three generator machines, all on the VM LAN. Fill `config/inventory.yaml`
(copy from `inventory.example.yaml`).

| Host | CPU | RAM | Role in the campaign | Soft cap |
|------|-----|-----|----------------------|----------|
| **gen-a** — Xeon E5-2640v4 ×2 (40 t) | 40 t | 31 GiB | Locust **master** + worker; ~50 media browsers; collectors; `netem` | 50 browsers / 800 ghost WS |
| **gen-b** — Xeon E5-2640v4 ×2 (40 t) | 40 t | 31 GiB | Locust worker; ~50 media browsers | 50 browsers / 800 ghost WS |
| **gen-c** — Threadripper 3970X (64 t) | 64 t | 125 GiB | Locust worker; ~200 media browsers; ffmpeg seed encode | 200 browsers / 4000 ghost WS |

Rationale: a fake-device Chromium at 320×240@15fps VP8 costs ≈ 250–400 MiB RSS
and 0.3–0.8 vCPU. RAM is the binding constraint on the Xeon boxes
(31 GiB ⇒ ~50 browsers with headroom for the OS and Locust); the Threadripper is
CPU-bound and comfortably runs ~200. Ceiling ≈ **300 concurrent real
participants** plus the production bot fleet plus thousands of app-plane-only WS
clients. The bots VM (`192.168.1.232`, `MAX_BOTS` — raise via
`POST :7777/api/config {"maxBots": N}` in preflight) carries S2.

Media browsers are pinned to NUMA nodes with `numactl` on the Xeons (2 nodes
each) — `orchestrate/distributed.sh` does this.

---

## 3. WWAN degradation ladder

`config/netem_profiles.yaml`. Applied on **each generator's uplink toward
`192.168.1.0/24`** with `tc`: `netem` (delay, delay-jitter w/ normal
distribution, correlated loss, reordering, duplication, corruption) behind a
`tbf`/`htb` rate limit, and an `ifb` mirror so the **downlink** is shaped too
(WWAN asymmetry: downlink rate ≈ 2–4× uplink). `orchestrate/netem.sh` owns this.

| Profile | ~RTT add | jitter | loss | rate down/up | notes |
|---------|---------|--------|------|--------------|-------|
| `p0_lan` | 0 | 0 | 0 | unshaped | baseline / control |
| `p1_lte_good` | 40 ms | 5 ms | 0.1 % | 25 / 8 Mbit | strong 4G |
| `p2_lte_typical` | 80 ms | 15 ms | 0.5 % | 12 / 4 Mbit | median 4G |
| `p3_lte_busy` | 130 ms | 35 ms | 1.5 % | 6 / 2 Mbit | congested cell |
| `p4_hspa` | 220 ms | 60 ms | 3 % | 3 / 1 Mbit | 3G / cell edge |
| `p5_edge` | 400 ms | 90 ms | 6 % | 1 / 0.4 Mbit | 2.5G / deep fade |
| `p3_handover`* | p3 + periodic 800–2000 ms stall every 25–40 s + 5 % burst loss | | | | mobility overlay |

`*` the handover overlay is a `tc change` cron toggled by `netem.sh --handover`,
run on top of `p3` only (keeps the mobility effect a single controlled factor).

The campaign sweeps profiles **outer**, scenario load **inner**. `p5_edge` is
expected to break media for a meaningful fraction of clients — that is the point;
the dropout-rate figure needs the failures.

---

## 4. Metrics captured

| Metric | Source | Cadence | Units |
|--------|--------|---------|-------|
| Outbound / inbound **bandwidth** | media agent `getStats` `bytesSent/Received` delta; host `/proc/net/dev`; JVB stats | 2 s | kbit/s |
| **Frame rate** | `getStats` `outbound-rtp.framesPerSecond`, `inbound-rtp.framesPerSecond` / `framesDecoded` delta | 2 s | fps |
| **Latency** | `getStats` `candidate-pair.currentRoundTripTime`, `remote-inbound-rtp.roundTripTime`; sidecar `ping`/`pong` RTT | 2 s | ms |
| **Jitter** | `getStats` `inbound-rtp.jitter` (RTP inter-arrival); sidecar `metrics.rtcJitter` | 2 s | ms |
| **Packet loss** | `getStats` `inbound-rtp.packetsLost` / `packetsReceived` → fraction; `remote-inbound-rtp.fractionLost` | 2 s | ratio |
| **Involuntary dropout** | media agent ICE/PC state → `failed`/`disconnected` not preceded by an intentional leave; sidecar `peer-leave` with no intentional-leave marker; conductor bot disappearance | event | count / rate |
| Freezes | `getStats` `freezeCount`, `totalFreezesDuration`, `pauseCount` | 2 s | count / s |
| Server CPU / RAM / net | `docker stats` on the 3 VMs; load avg; `ss -s` | 5 s | % / MiB / kbit/s |
| Sidecar fan-out cost | `sidecar_observer` inter-arrival of `peer-update` bursts; SCSS compile echo latency | event | ms |
| Metaprogram health | `nc-active` cadence vs expected slot grid; ring size | event | ms drift |
| App requests | Locust request/failure/percentile CSV | rollup | ms |

**Dropout rate** is reported two ways: per-scenario-step *hazard*
(involuntary leaves ÷ participant-seconds) and *survival* (fraction still
connected at the end of each load step), both in `analysis/metrics.py`.

All raw data is newline-delimited JSON under
`results/<run-id>/raw/<collector>.jsonl`; `analysis/ingest.py` normalises it to
tidy Parquet (`results/<run-id>/tidy/*.parquet`), one row per
(t, run, profile, scenario, step, entity, metric, value).

---

## 5. Directory layout

```
loadtest/
  README.md                 ← this file
  requirements.txt
  config/
    inventory.example.yaml     ← Layout A/B: one target + bare-metal generators
    inventory.proxmox-C.yaml   ← Layout C: matched pair + C2 generators (§9); the VM list
    netem_profiles.yaml        ← the WWAN ladder
    scenarios.yaml             ← S1–S4 matrix + `turn_study` (S5/S6) block
  harness/                  ← importable Python package
    common.py               ← run-id, paths, JSONL MetricSink, target pair, config
    sidecar.py              ← WebSocket client for wss://…/ws
    yjs_meta.py             ← Python ↔ tools/ymeta.mjs (Yjs metaprogram updates)
    media_agent.py          ← ONE Playwright Chromium in a room + getStats → JSONL
    strudel_payloads.py     ← escalating "diverse media" code + data packs
    breakwatch.py           ← BreakDetector: reads a live cell's raw/ → "is it broken"
  locust/
    locustfile.py           ← SidecarGhost / HumanParticipant / BotOperator /
                              MetaprogramEditor / ChurnUser
    shapes.py               ← CampaignShape (stepped S1–S5, break-find S6)
  collectors/
    sidecar_observer.py     ← passive role=observer WS → app-plane ground truth
    host_stats.py           ← ssh docker stats / /proc/net/dev / ss on the VMs
    jvb_stats.py            ← optional Colibri REST / JVB-log stats
  orchestrate/
    preflight.sh            ← reachability, ceilings, disk, PROD GUARD
    netem.sh / netem_apply.sh  ← apply / --handover / clear a WWAN profile
    distributed.sh          ← locust master + ssh workers for ONE target (§9)
    run_campaign.sh         ← the S1–S4 profile × scenario matrix
    run_turnstudy.sh        ← the S5/S6 matched-pair study (Layout C)
    cfg.py                  ← YAML accessor for the bash scripts
  tools/
    ymeta.mjs               ← node: program text → base64 Yjs update/snapshot
    make_seeds.sh           ← ffmpeg: fake-camera .y4m + mic .wav
    proxmox/                ← provision.sh, snapshot.sh, README (Layout C VMs)
  analysis/
    ingest.py               ← raw JSONL + locust CSV → tidy Parquet (+ campaign.db)
    metrics.py              ← dropout hazard/survival, percentiles, turn_stability,
                              break_points  → tidy Parquet + rebuilds campaign.db
    db.py                   ← builds results/<run>/campaign.db (SQLite) from the tidy set
  figures/
    plotstyle.py            ← manuscript rcParams + CVD-safe palette + save_figure()
    _data.py                ← load tidy data (or synthesise, so figs run pre-campaign)
    fig01…fig08 …           ← the WWAN/load figures (§7)
    fig09_turn_stability.py ← successor-disruption + time-to-first-turn, hash vs literal
    fig10_breakpoint.py     ← participants-at-break, hash vs literal, per profile
    render_all.py
  results/<run-id>/{raw,tidy,logs,campaign.db,meta.json}
  figures_out/*.pdf *.png   ← manuscript-sized, one file per figure
```

---

## 6. Running it

### 6.1 One-time setup (each generator host)

```bash
cd loadtest
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium          # media agents
bash tools/make_seeds.sh                        # fake camera + mic files
sudo apt-get install -y iproute2 numactl        # netem + NUMA pinning
```

`tools/ymeta.mjs` uses the repo's own `yjs` dependency — run `npm ci` at the repo
root once if `node_modules/yjs` is absent.

### 6.2 Preflight (from gen-a)

```bash
bash orchestrate/preflight.sh config/inventory.yaml
```

Checks SSH to all six hosts, the sidecar `/ws` handshake, the conductor
`/api/rooms`, free disk, and **refuses to target `meet.trussal.com` / the
production apex unless `ALLOW_PROD=1` is exported** (§8).

### 6.3 A single cell (one profile, one scenario) — smoke test

```bash
export TRUSSAL_HOST=staging.trussal.internal ROOM=loadtest-$RANDOM
bash orchestrate/netem.sh apply p2_lte_typical config/inventory.yaml
RUN_ID=smoke SCENARIO=S1 PROFILE=p2_lte_typical \
  locust -f locust/locustfile.py --headless \
  --host "https://$TRUSSAL_HOST" -u 20 -r 1 -t 8m \
  --csv results/smoke/raw/locust
bash orchestrate/netem.sh clear config/inventory.yaml
```

### 6.4 Full campaign

```bash
bash orchestrate/run_campaign.sh config/inventory.yaml config/scenarios.yaml
```

For each `(profile, scenario)` it: starts the collectors, applies the profile,
runs `distributed.sh` (locust master on gen-a + workers on a/b/c) for the
scenario's duration, stops collectors, and writes
`results/<run-id>/raw/…`. A full 6-profile × 4-scenario matrix at the durations in
`scenarios.yaml` is ≈ **7–9 h**; run overnight.

### 6.5 Analyse & plot

```bash
python analysis/ingest.py  results/<run-id>
python analysis/metrics.py results/<run-id>
python figures/render_all.py --run results/<run-id> --column single
#   → figures_out/fig01_bandwidth_vs_participants.pdf (+ .png), …
```

Every `figNN_*.py` is standalone and re-runnable: edit the file, re-run it,
the PDF/PNG in `figures_out/` is overwritten. With `--run` omitted the figures
render from synthetic data so you can tune styling before the campaign finishes.

---

## 7. Figure conventions (manuscript-ready)

`figures/plotstyle.py` sets, for every figure:

- **Width** = `--column single` → 3.487 in (IEEE single column) · `1p5` → 5.0 in ·
  `double` → 7.16 in. Height defaults to width ÷ 1.6, overridable per figure.
- **Fonts** — serif (`STIX`/`DejaVu Serif`, Times-metric-compatible) to match
  LaTeX body text; base 8 pt, ticks 7 pt, no figure title (captions live in the
  manuscript). `pdf.fonttype=42` / `ps.fonttype=42` so text stays selectable and
  editable. Set `LOADTEST_FIG_FONT=sans` to switch to a sans stack.
- **Colour** — the validated CVD-safe categorical order from the `dataviz` skill
  (`#2a78d6, #eb6834, #1baf7a, #eda100, #e87ba4, #008300, #4a3aa7, #e34948`);
  network profiles use the sequential blue ramp (more impaired = darker); status
  (good/warn/serious/critical) reserved for pass/fail overlays only. ≤4 series are
  also direct-labelled; a legend is always present for ≥2.
- **Marks** — 0.9 pt lines, ≥6 pt markers, hairline grid `#e1e0d9`, top/right
  spines off, percentile bands as 15 %-alpha fills.
- **Output** — vector PDF *and* 400-dpi PNG, `bbox_inches='tight'`,
  `constrained_layout`.

Deviation from the `dataviz` default (sans, web/interactive): these are static
print figures embedded beside serif body text, so the figure text matches the
document face and there is no hover layer. Everything else in that skill —
form-by-job, fixed categorical order, single y-axis, no rainbow, validated
palette — is applied as written.

---

## 8. Safety / operational notes

- **This drives a real deployment into failure.** Point it at a dedicated staging
  Trussal (a second `docker-jitsi-meet` stack + sidecar + a bots conductor with
  its own `MAX_BOTS`), not `meet.trussal.com`. `preflight.sh` hard-blocks the
  production hostnames without `ALLOW_PROD=1`.
- The campaign **spawns real bot containers** on the bots VM and **raises
  `MAX_BOTS`**. `run_campaign.sh` restores the original ceiling on exit (and on
  `trap`).
- `netem.sh` shapes the generator uplinks only. It never touches the VMs. It
  always installs a `clear` trap; if a run is killed, re-run `netem.sh clear`.
- Rooms are named `loadtest-<matrix-cell>-<ts>` and t!orn down; the sidecar frees
  all room state when the last participant leaves.
- Nothing here posts to chat, tickets, or any external service. Results stay
  under `results/`.

---

## 9. The turn-assignment study (Layout C — S5 / S6)

**Question.** Trussal's NetCycles ring is normally the literal `$ participants
<0 1 2 …>` sequence a performer maintains by hand — which someone must re-edit on
every join/leave, and during that CRDT-propagation window clients disagree about
whose turn it is. The alternative is a **consistent-hash ring**: derive the
rotation from hashing each present room-index token
(`src/audio-net/TurnRing.js`, rendezvous / weighted-rendezvous), recomputed
each cycle from the live roster, so a join/leave perturbs *who-follows-whom* for
O(1/N) tokens and needs no edit and no broadcast. Selected by `# ring hash` in
the metaprogram (`# ring hash w <token> <weight> …` to bias turn share);
consumed identically by every browser and the aggregator.

**Design.** Two **identical `trussal-sut` clones** — `sut_explicit` and
`sut_hash` — differing only in `targets.<name>.turn_mode` in
`config/inventory.proxmox-C.yaml` (the harness writes `# ring explicit` + a
maintained literal, or writes `# ring hash` once). There is **no per-SUT build**.

- **S5 — matched load.** `run_turnstudy.sh` applies one WWAN profile and runs
  `distributed.sh` for **both** targets concurrently (same schedule, wall clock,
  link), while `ChurnUser` cycles a pool in/out at a rising rate (a share as
  SIGKILL = involuntary). Metrics (`analysis/metrics.py` → `turn_stability.parquet`,
  mirroring the `TurnRing.js` definitions):
  *successor disruption* (fraction of survivors whose next-turn neighbour moved,
  per churn event), *position disruption*, *time to a joiner's first turn*, Jain
  fairness on turns/token, ring size — all from the `nc-active` + roster-event
  streams the observer already logs. → **fig09**.
- **S6 — ramp to break.** One target at a time. `BreakFindShape` raises the
  participant count every `dwell_s` and ends the run when `BreakDetector`
  (`harness/breakwatch.py`) reports a sustained break — dropout hazard, `nc-active`
  turn gap vs the ideal slot, aggregator/JVB CPU, or join-success collapse. The
  recorded `break_level` per (target, profile) → `break_points.parquet` → **fig10**.

**Run it**

```bash
bash orchestrate/preflight.sh config/inventory.proxmox-C.yaml
bash orchestrate/run_turnstudy.sh config/inventory.proxmox-C.yaml config/scenarios.yaml
python analysis/ingest.py  results/<run-id>     # observations + phases + campaign.db
python analysis/metrics.py results/<run-id>     # turn_stability + break_points + rebuild db
python figures/fig09_turn_stability.py --run results/<run-id> --column double
python figures/fig10_breakpoint.py     --run results/<run-id>
```

`SNAPSHOT_ROLLBACK=1` rolls each SUT back to `campaign.sut_cold_snapshot`
between cells (needs a Proxmox cluster + `tools/proxmox/`).

**`campaign.db`** — `analysis/db.py` builds `results/<run-id>/campaign.db`
(SQLite) from the tidy Parquet: tables `observations`, `phases`, `nc_active`,
`roster_events`, `dropouts`, `turn_stability`, `break_points` + views
`v_turn_gap`, `v_roster_size`. Parquet stays the figure export; the DB is for
the relational, iterative "why did the hash ring hold at level X while the
literal broke" queries. `sqlite3 results/<run-id>/campaign.db`.

**Proxmox VMs** — `tools/proxmox/README.md`. Two checkpoints where you create
VMs: **A** one `trussal-sut` clone (smoke the real path), then **B** the full
Layout-C set (2 SUTs + 2 bots VMs + 2 generator VMs on C2, isolated `vmbr1`).
`tools/proxmox/provision.sh` linked-clones and configures them from three
templates.

### The Trussal-side change this study needs

Landed on `main` (all `npm test` green + 20 new tests):

| file | change |
|---|---|
| `src/audio-net/TurnRing.js` | **new** pure module — `orderTokens`, `weightedRingSlots`, `nextOwner`, `ringDisruption` / `positionDisruption` / `rejoinRestoresSlot`, `jainFairness` |
| `src/audio-net/MetaprogrammerParser.js` | `# ring <explicit\|hash> [w …]` directive → `program.ring`; `buildDefaultProgram()` now ships `# ring hash` |
| `src/audio-net/MetaprogramScheduler.js` | `setRing({roster, seed})` + `_effectiveParticipants()` — under `# ring hash`, expand the hashed roster order instead of `$ participants`; **inert** without the directive |
| `src/audio-net/Metaprogrammer.js` | wires `setRing` (roster = present tokens, seed = room name) |
| `bots/src/bot/aggregator-bot.js` | same wiring for the aggregator's own scheduler + `CircularParticipantQueue` |

`# ring hash` is now the **default** (`buildDefaultProgram()`); an explicit
`# ring explicit`, or any older program with no `# ring` line, is byte-identical
to the pre-hash literal walk. So the `turn_mode: explicit` arm writes
`# ring explicit` (or a maintained literal `$ participants <…>`); the
`turn_mode: hash` arm leaves the default alone.

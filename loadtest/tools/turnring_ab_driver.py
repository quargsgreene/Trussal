#!/usr/bin/env python3
"""
Turn-ring A/B, self-contained (same pattern as proxmox/cpa-smoke-driver.py):
runs the S5 churn shape's core idea — a stable ring + a churn pool cycling
join/leave/rejoin — against ONE real target, once with `# ring explicit`
(a maintained literal `$ participants <...>`) and once with `# ring hash`
(written once, then left alone), back to back, same room population shape,
same host. A `sidecar_observer.py` runs the whole time; the JSONL it writes is
ordinary `analysis/ingest.py` -> `analysis/metrics.py` -> `figures/fig09_*` input
— TRUSSAL_TARGET/TRUSSAL_TURN_MODE differ per arm so both land in one
results/<run>/ under the CELL_KEYS metrics.py already groups by.

Safety: talks ONLY to TARGET_HOST (default a LAN staging box, never a
production apex — this reuses harness.common.assert_not_prod). Bounded
population and duration; nothing here touches netem or any shared link.

Env:
  TARGET_HOST, TARGET_SCHEME   default 192.168.1.41 / https (a staging SUT)
  RUN_ID                       default turnring-ab-<timestamp>
  ROOM_PREFIX                  default loadtest-turnring
  RING_SIZE                    stable ring members per arm (default 16)
  CHURN_POOL                   churners per arm (default 10)
  CHURN_INTERVAL_S             mean seconds between one churner's join/leave (default 6)
  INVOLUNTARY_FRAC             share of leaves that are a hard SIGKILL-style close (default 0.3)
  ARM_DURATION_S                default 150
  SETTLE_S                     gap between arms (default 20)
"""
from __future__ import annotations

import os
import random
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

LOADTEST = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LOADTEST))
from harness.common import RunContext, assert_not_prod  # noqa: E402
from harness.sidecar import SidecarClient  # noqa: E402
from harness.yjs_meta import MetaprogramDoc, build_program  # noqa: E402

HOST = os.environ.get("TARGET_HOST", "192.168.1.41")
SCHEME = os.environ.get("TARGET_SCHEME", "https")
assert_not_prod(HOST)

RUN_ID = os.environ.get("RUN_ID", time.strftime("turnring-ab-%Y%m%d-%H%M%S"))
ROOM_PREFIX = os.environ.get("ROOM_PREFIX", "loadtest-turnring")
RING_SIZE = int(os.environ.get("RING_SIZE", "16"))
CHURN_POOL = int(os.environ.get("CHURN_POOL", "10"))
CHURN_INTERVAL_S = float(os.environ.get("CHURN_INTERVAL_S", "6"))
INVOLUNTARY_FRAC = float(os.environ.get("INVOLUNTARY_FRAC", "0.3"))
ARM_DURATION_S = int(os.environ.get("ARM_DURATION_S", "150"))
SETTLE_S = int(os.environ.get("SETTLE_S", "20"))
DIRECTIVES = "# cycles wcl\n# tempo 110"

VENV_PY = str(LOADTEST / ".venv" / "bin" / "python")


def log(msg):
    print(f"[turnring-ab] {msg}", flush=True)


def run_arm(arm: str):
    """arm is 'explicit' or 'hash'."""
    room = f"{ROOM_PREFIX}-{arm}"
    ctx = RunContext(run_id=RUN_ID, profile="p0_lan", scenario="S5",
                     host=HOST, scheme=SCHEME, target_name=f"sut_{arm}", turn_mode=arm)
    log(f"=== arm={arm}  room={room}  ring={RING_SIZE}  churn_pool={CHURN_POOL}  "
        f"duration={ARM_DURATION_S}s ===")

    obs_env = {**os.environ, "RUN_ID": RUN_ID, "PROFILE": "p0_lan", "SCENARIO": "S5",
               "TRUSSAL_HOST": HOST, "TRUSSAL_SCHEME": SCHEME,
               "TRUSSAL_TARGET": ctx.target_name, "TRUSSAL_TURN_MODE": arm}
    obs = subprocess.Popen(
        [VENV_PY, str(LOADTEST / "collectors" / "sidecar_observer.py"),
         "--room", room, "--duration", str(ARM_DURATION_S + 30)],
        env=obs_env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    time.sleep(3)  # let the observer attach before anyone joins

    # ---- editor: publishes the ring-mode directive, then (explicit only)
    # re-publishes the literal on every roster change, exactly like
    # locust/locustfile.py MetaprogramEditorUser. SidecarClient keeps its own
    # `.peers` dict current from roster/peer-join/peer-leave — read that
    # directly rather than shadowing it (the "roster" event carries no list,
    # just {size, roomIndex}; see harness/sidecar.py).
    doc = MetaprogramDoc()
    editor_name = f"turnring-editor-{arm}"
    editor_sc = SidecarClient(ctx.sidecar_url(room, "player"), display_name=editor_name,
                              stable_id=uuid.uuid4().hex, name=editor_name)
    editor_sc.connect(timeout=30)
    editor_sc.wait_roster(timeout=30)

    def room_tokens():
        toks = [str(p["roomIndex"]) for p in editor_sc.peers.values()
                if p.get("roomIndex") is not None and not p.get("isAggregator")]
        return sorted(set(toks), key=lambda t: (not t.isdigit(), len(t), t)) or ["0"]

    last_text = [None]
    def publish(text):
        if text == last_text[0]:
            return
        result = doc.set_text(text, snapshot=True)
        if not result:
            return
        last_text[0] = text
        editor_sc.send_crdt_update(result["update"], snapshot=result["snapshot"],
                                   modality="apply", channel="metaprogram")

    if arm == "hash":
        publish(build_program(["0"], "# ring hash\n" + DIRECTIVES))
    else:
        publish(build_program(["0"], "# ring explicit\n" + DIRECTIVES))

    stop = threading.Event()

    def editor_loop():
        # keep the literal in step with the live roster (explicit arm only)
        while not stop.is_set():
            if arm == "explicit":
                publish(build_program(room_tokens(), "# ring explicit\n" + DIRECTIVES))
            time.sleep(2)
    editor_thread = threading.Thread(target=editor_loop, daemon=True)
    editor_thread.start()

    # ---- stable ring: join once, stay for the whole arm
    def stable_player(idx):
        name = f"turnring-{arm}-ring{idx}"
        sc = SidecarClient(ctx.sidecar_url(room, "player"), display_name=name, name=name,
                           stable_id=uuid.uuid4().hex)
        try:
            sc.connect(timeout=20)
            sc.wait_roster(timeout=20)
            sc.send_play(True)
            while not stop.is_set():
                sc.send_metrics(rtt=25, jitter=4, packetLoss=0.0, rtcRtt=40, rtcJitter=6)
                for _ in range(20):
                    if stop.is_set():
                        break
                    time.sleep(0.25)
            sc.close(intentional=True)
        except Exception as e:
            log(f"ring{idx} ERR {e!r}")

    # ---- churn pool: repeatedly join, hold, leave (some involuntary), rejoin
    def churn_player(idx):
        rng = random.Random(f"{arm}-{idx}")
        while not stop.is_set():
            name = f"turnring-{arm}-churn{idx}"
            sc = SidecarClient(ctx.sidecar_url(room, "player"), display_name=name, name=name,
                               stable_id=uuid.uuid4().hex)
            try:
                sc.connect(timeout=20)
                sc.wait_roster(timeout=20)
                sc.send_play(True)
                hold = max(1.0, rng.expovariate(1.0 / CHURN_INTERVAL_S))
                waited = 0.0
                while waited < hold and not stop.is_set():
                    time.sleep(0.5)
                    waited += 0.5
                involuntary = rng.random() < INVOLUNTARY_FRAC
                sc.close(intentional=not involuntary)
            except Exception as e:
                log(f"churn{idx} ERR {e!r}")
            # brief gap before rejoining, like S5's rejoin_delay
            for _ in range(int(rng.uniform(2, 6) * 2)):
                if stop.is_set():
                    break
                time.sleep(0.5)

    threads = [threading.Thread(target=stable_player, args=(i,)) for i in range(RING_SIZE)]
    threads += [threading.Thread(target=churn_player, args=(i,)) for i in range(CHURN_POOL)]
    for t in threads:
        t.start()
        time.sleep(0.05)  # stagger joins so the roster settles gradually, not a thundering herd

    time.sleep(ARM_DURATION_S)
    stop.set()
    for t in threads:
        t.join(timeout=10)
    editor_thread.join(timeout=5)
    editor_sc.close(intentional=True)
    doc.close()

    log("players done, waiting on observer...")
    try:
        out, _ = obs.communicate(timeout=40)
        log("observer tail: " + (out or "").strip()[-300:])
    except subprocess.TimeoutExpired:
        obs.terminate()
        obs.wait(timeout=15)
    log(f"=== arm={arm} DONE ===")


def main():
    log(f"target={SCHEME}://{HOST}  run_id={RUN_ID}")
    for i, arm in enumerate(["explicit", "hash"]):
        if i:
            log(f"settle {SETTLE_S}s between arms")
            time.sleep(SETTLE_S)
        run_arm(arm)
    log(f"RUN {RUN_ID} COMPLETE")
    log(f"  {VENV_PY} analysis/ingest.py  results/{RUN_ID}")
    log(f"  {VENV_PY} analysis/metrics.py results/{RUN_ID}")
    log(f"  {VENV_PY} figures/fig09_turn_stability.py --run results/{RUN_ID} --column double")


if __name__ == "__main__":
    main()

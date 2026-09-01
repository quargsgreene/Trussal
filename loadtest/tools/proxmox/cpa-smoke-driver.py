#!/usr/bin/env python3
"""
Checkpoint-A smoke, self-contained: spawn the sidecar_observer as a subprocess,
then drive synthetic players with a mid-run involuntary dropout AND clean leaves,
all inside the observer window. Appends into results/$RUN_ID/raw/.
"""
from __future__ import annotations
import os, sys, time, threading, uuid, subprocess, signal
from pathlib import Path

LOADTEST = Path(__file__).resolve().parents[2]   # <repo>/loadtest
sys.path.insert(0, str(LOADTEST))
from harness.common import RunContext
from harness.sidecar import SidecarClient
from harness.strudel_payloads import code_payload

ROOM = os.environ.get("ROOM", "loadtest-cpa-smoke")
OBS_S = int(os.environ.get("OBS_S", "120"))
env = {**os.environ,
       "RUN_ID": os.environ.get("RUN_ID", "cpa-smoke"),
       "PROFILE": "p0_lan", "SCENARIO": "S0",
       "TRUSSAL_HOST": "192.168.1.41", "TRUSSAL_SCHEME": "http",
       "TRUSSAL_TARGET": "sut_explicit"}
ctx = RunContext(run_id=env["RUN_ID"], profile="p0_lan", scenario="S0",
                 host="192.168.1.41", scheme="http", target_name="sut_explicit")

print(f"[combined] observer {OBS_S}s -> {ctx.ws_base} room={ROOM}", flush=True)
obs = subprocess.Popen(
    [str(LOADTEST / ".venv/bin/python"), str(LOADTEST / "collectors/sidecar_observer.py"),
     "--room", ROOM, "--duration", str(OBS_S)],
    env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
time.sleep(4)  # let observer attach

WWAN = [(35, 4, 0.0), (70, 12, 0.01), (130, 30, 0.03), (210, 60, 0.08), (320, 100, 0.15)]
stop = threading.Event()

def player(idx, join_delay, leave_at, clean, kinds):
    time.sleep(join_delay)
    name = f"cpa-synth-{idx}"
    sc = SidecarClient(ctx.sidecar_url(ROOM, "player"), display_name=name, name=name,
                       stable_id=uuid.uuid4().hex)
    try:
        sc.connect(timeout=20); ok = sc.wait_roster(timeout=20)
        print(f"[p{idx}] join ok={ok} idx={sc.my_room_index}", flush=True)
        sc.send_play(True)
        t0 = time.time(); vol = 400
        while not stop.is_set():
            el = time.time() - t0
            if leave_at is not None and el >= leave_at:
                print(f"[p{idx}] {'clean leave' if clean else 'INVOLUNTARY DROP'} @ {el:.0f}s", flush=True)
                sc.close(intentional=clean); return
            s = min(len(WWAN) - 1, int(el // 25))
            rtt, jit, loss = WWAN[s]
            sc.send_metrics(rtt=rtt + idx * 9, jitter=jit + idx * 3, packetLoss=loss,
                            rtcRtt=rtt + idx * 9 + 18, rtcJitter=jit + idx * 3 + 4)
            sc.send_pattern(code_payload(kinds[s % len(kinds)], vol, seed=idx * 100 + s))
            vol = min(9000, int(vol * 1.7))
            for _ in range(40):
                if stop.is_set(): break
                time.sleep(0.1)
        sc.close(intentional=True)
        print(f"[p{idx}] clean leave @ stop", flush=True)
    except Exception as e:
        print(f"[p{idx}] ERR {e!r}", flush=True)

threads = [
    threading.Thread(target=player, args=(0, 0.0,  None, True,  ["plain", "hydra", "csscycles"])),
    threading.Thread(target=player, args=(1, 6.0,  85.0, True,  ["samples", "datapack", "textcycles"])),
    threading.Thread(target=player, args=(2, 16.0, 45.0, False, ["plain", "images", "hydra"])),  # dropout
]
for t in threads: t.start()
RUN_S = int(os.environ.get("RUN_S", "95"))
time.sleep(RUN_S)
stop.set()
for t in threads: t.join(timeout=10)
print("[combined] players done, waiting on observer...", flush=True)
try:
    out, _ = obs.communicate(timeout=OBS_S)
    print("[observer]", (out or "").strip()[-400:], flush=True)
except subprocess.TimeoutExpired:
    obs.send_signal(signal.SIGTERM); obs.wait(timeout=15)
print("[combined] DONE", flush=True)

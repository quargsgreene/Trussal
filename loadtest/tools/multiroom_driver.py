#!/usr/bin/env python3
"""
Concurrent-ROOMS sweep, self-contained (same family as turnring_ab_driver.py /
proxmox/cpa-smoke-driver.py): grows the number of independent, live, low-traffic
rooms against ONE real target and measures, at each level:

  - join/roster-settle latency for the batch of peers that joins at this level
  - in-room broadcast fan-out latency (one peer's pattern update -> a sibling
    in the SAME room seeing the peer-update), sampled on a handful of rooms
  - server host stats (docker stats CPU/mem for web/jvb/jicofo/prosody/latency,
    plus `ss -s` socket counts) via one SSH snapshot per level

Rooms accumulate — nothing is torn down between levels — so level N really is
"N rooms all live and chattering at once", not N one at a time. Every peer is
sidecar-only (no browser/JVB media), same footprint class as the existing
S1/S5/S6 "ghost" population, so this is a pure app-plane (sidecar + nginx +
prosody MUC + jicofo conference bookkeeping) measurement.

Safety: talks only to TARGET_HOST (assert_not_prod), and only the SSH target
given for host stats (default none — pass SSH_KEY+SSH_TARGET to enable).
Bounded room/peer counts; every room is closed cleanly at the end.

Env:
  TARGET_HOST, TARGET_SCHEME   default 192.168.1.41 / https
  RUN_ID, ROOM_PREFIX
  LEVELS                many rooms in play, comma-separated, cumulative (default "1,2,4,8,16,32,64")
  PEERS_PER_ROOM         default 3
  HOLD_S                 seconds to hold+sample at each level (default 30)
  KEEPALIVE_S             per-peer pattern/metrics cadence (default 4)
  FANOUT_SAMPLE_ROOMS     how many rooms to fan-out-probe per level (default 6)
  SSH_KEY, SSH_TARGET     e.g. ~/.ssh/trussal-test-key-2, trussal@192.168.1.41
                          (optional — host stats skipped if unset)
  SSH_CONTAINERS          comma list (default the docker-jitsi-meet-*-1 five)
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid
from pathlib import Path

LOADTEST = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LOADTEST))
from harness.common import RunContext, MetricSink, assert_not_prod  # noqa: E402
from harness.sidecar import SidecarClient  # noqa: E402

HOST = os.environ.get("TARGET_HOST", "192.168.1.41")
SCHEME = os.environ.get("TARGET_SCHEME", "https")
assert_not_prod(HOST)

RUN_ID = os.environ.get("RUN_ID", time.strftime("multiroom-%Y%m%d-%H%M%S"))
ROOM_PREFIX = os.environ.get("ROOM_PREFIX", "loadtest-multiroom")
LEVELS = [int(x) for x in os.environ.get("LEVELS", "1,2,4,8,16,32,64").split(",") if x.strip()]
PEERS_PER_ROOM = int(os.environ.get("PEERS_PER_ROOM", "3"))
HOLD_S = float(os.environ.get("HOLD_S", "30"))
KEEPALIVE_S = float(os.environ.get("KEEPALIVE_S", "4"))
FANOUT_SAMPLE_ROOMS = int(os.environ.get("FANOUT_SAMPLE_ROOMS", "6"))
SSH_KEY = os.environ.get("SSH_KEY", "")
SSH_TARGET = os.environ.get("SSH_TARGET", "")
SSH_CONTAINERS = os.environ.get(
    "SSH_CONTAINERS",
    "docker-jitsi-meet-web-1,docker-jitsi-meet-jvb-1,docker-jitsi-meet-jicofo-1,"
    "docker-jitsi-meet-prosody-1,docker-jitsi-meet-latency-1").split(",")

ctx = RunContext(run_id=RUN_ID, profile="p0_lan", scenario="S7", host=HOST, scheme=SCHEME,
                 target_name="sut", turn_mode="")
sink = MetricSink(ctx, "multiroom")

SUMMARY_PATH = ctx.run_dir / "multiroom_summary.jsonl"


def log(msg):
    print(f"[multiroom] {msg}", flush=True)


def ssh_snapshot() -> dict:
    if not (SSH_KEY and SSH_TARGET):
        return {}
    name_pattern = "|".join(re.escape(c.strip()) for c in SSH_CONTAINERS if c.strip())
    cmd = (
        "docker stats --no-stream --format "
        "'{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.NetIO}}' "
        f"$(docker ps --format '{{{{.Names}}}}' | grep -E '{name_pattern}')"
        " 2>/dev/null; echo '---'; ss -s 2>/dev/null | head -2"
    )
    try:
        out = subprocess.run(
            ["ssh", "-i", os.path.expanduser(SSH_KEY), "-o", "BatchMode=yes",
             "-o", "ConnectTimeout=8", SSH_TARGET, cmd],
            capture_output=True, text=True, timeout=20).stdout
    except Exception as e:
        return {"error": repr(e)}
    stats, socks = {}, {}
    in_socks = False
    for line in out.splitlines():
        if line.strip() == "---":
            in_socks = True
            continue
        if not in_socks:
            parts = line.split("\t")
            if len(parts) == 4:
                name, cpu, mem, net = parts
                stats[name] = {"cpu_pct": cpu.rstrip("%"), "mem": mem, "net_io": net}
        else:
            m = re.search(r"Total:\s*(\d+)", line)
            if m:
                socks["total_sockets"] = int(m.group(1))
    return {"containers": stats, "sockets": socks}


class Peer:
    __slots__ = ("sc", "room", "name", "t_connect_start", "t_roster_ok", "last_update_seen")

    def __init__(self, room, idx):
        self.room = room
        self.name = f"mr-{room}-{idx}"
        self.t_connect_start = None
        self.t_roster_ok = None
        self.last_update_seen = None
        self.sc = None

    def _ev(self, kind, data):
        if kind == "peer-update":
            self.last_update_seen = time.time()

    def join(self):
        self.t_connect_start = time.time()
        self.sc = SidecarClient(ctx.sidecar_url(self.room, "player"), display_name=self.name,
                                stable_id=uuid.uuid4().hex, on_event=self._ev, name=self.name)
        self.sc.connect(timeout=25)
        ok = self.sc.wait_roster(timeout=25)
        self.t_roster_ok = time.time()
        self.sc.send_play(True)
        return ok


all_peers: list[Peer] = []          # every peer ever created, kept alive
rooms_by_level: dict[int, list[str]] = {}
stop_keepalive = threading.Event()


def keepalive_loop():
    i = 0
    while not stop_keepalive.is_set():
        for p in list(all_peers):
            if p.sc is None:
                continue
            try:
                p.sc.send_metrics(rtt=20, jitter=3, packetLoss=0.0, rtcRtt=30, rtcJitter=4)
                if i % 3 == 0:
                    p.sc.send_pattern(f's("bd sd") // mr-keepalive-{i}')
            except Exception:
                pass
        i += 1
        for _ in range(int(KEEPALIVE_S * 4)):
            if stop_keepalive.is_set():
                break
            time.sleep(0.25)


def run_level(level: int, prev_level: int):
    new_room_count = level - prev_level
    log(f"level={level}: joining {new_room_count} new room(s) x {PEERS_PER_ROOM} peers "
        f"({new_room_count * PEERS_PER_ROOM} new peers; {level * PEERS_PER_ROOM} total live)")
    new_rooms = [f"{ROOM_PREFIX}-{level}-{i}" for i in range(new_room_count)]
    rooms_by_level[level] = new_rooms

    batch: list[Peer] = []
    join_errors = 0
    threads = []
    lock = threading.Lock()

    def join_one(room, idx):
        nonlocal join_errors
        p = Peer(room, idx)
        try:
            ok = p.join()
            if not ok:
                with lock:
                    join_errors += 1
        except Exception as e:
            log(f"  join ERR {room}#{idx}: {e!r}")
            with lock:
                join_errors += 1
        with lock:
            batch.append(p)

    for room in new_rooms:
        for idx in range(PEERS_PER_ROOM):
            t = threading.Thread(target=join_one, args=(room, idx))
            threads.append(t)
            t.start()
            time.sleep(0.02)
    for t in threads:
        t.join(timeout=30)

    all_peers.extend(batch)
    connect_ms = [(p.t_roster_ok - p.t_connect_start) * 1000
                  for p in batch if p.t_roster_ok and p.sc and p.sc.roster_ready.is_set()]
    connect_ms.sort()
    p50 = connect_ms[len(connect_ms) // 2] if connect_ms else None
    p95 = connect_ms[int(len(connect_ms) * 0.95)] if connect_ms else None
    log(f"  join-roster latency: n={len(connect_ms)} p50={p50 and round(p50)}ms "
        f"p95={p95 and round(p95)}ms errors={join_errors}")

    time.sleep(min(HOLD_S, 5))  # let the whole room population settle before probing

    # ---- in-room fan-out probe on a sample of rooms (existing rooms too, not
    # just brand-new ones, so we see fan-out cost UNDER the current total load) --
    sample_rooms = list({p.room for p in all_peers})[:FANOUT_SAMPLE_ROOMS]
    fanout_ms = []
    for room in sample_rooms:
        members = [p for p in all_peers if p.room == room and p.sc]
        if len(members) < 2:
            continue
        prober, watcher = members[0], members[1]
        watcher.last_update_seen = None
        t0 = time.time()
        try:
            prober.sc.send_pattern(f's("bd*4") // mr-probe-{uuid.uuid4().hex[:6]}')
        except Exception:
            continue
        deadline = t0 + 5
        while time.time() < deadline and watcher.last_update_seen is None:
            time.sleep(0.05)
        if watcher.last_update_seen and watcher.last_update_seen >= t0:
            fanout_ms.append((watcher.last_update_seen - t0) * 1000)
    fanout_ms.sort()
    f50 = fanout_ms[len(fanout_ms) // 2] if fanout_ms else None
    log(f"  in-room fan-out latency: n={len(fanout_ms)}/{len(sample_rooms)} rooms p50={f50 and round(f50)}ms")

    remaining = max(0.0, HOLD_S - 5)
    time.sleep(remaining)

    host = ssh_snapshot()
    if host.get("containers"):
        log(f"  host: " + ", ".join(f"{k.split('-')[-2]}={v['cpu_pct']}%"
                                    for k, v in host["containers"].items()))

    row = {
        "t": time.time(), "run_id": RUN_ID, "level_rooms": level,
        "total_peers": len(all_peers), "new_rooms": new_room_count,
        "connect_ms_p50": p50, "connect_ms_p95": p95, "connect_errors": join_errors,
        "fanout_ms_p50": f50, "fanout_ms_samples": len(fanout_ms),
        "host": host,
    }
    with open(SUMMARY_PATH, "a") as fh:
        fh.write(json.dumps(row) + "\n")
    sink.event("level_summary", entity=str(level), value=level, **{
        k: v for k, v in row.items() if k not in ("host", "t", "run_id")
    })
    sink.sample("host_cpu_pct_sum", sum(float(v["cpu_pct"]) for v in host.get("containers", {}).values())
               if host.get("containers") else float("nan"), entity=str(level))
    return row


def main():
    log(f"target={SCHEME}://{HOST}  run_id={RUN_ID}  levels={LEVELS}  "
        f"peers/room={PEERS_PER_ROOM}  host_stats={'on' if SSH_KEY else 'off'}")
    ka = threading.Thread(target=keepalive_loop, daemon=True)
    ka.start()

    prev = 0
    rows = []
    try:
        for level in LEVELS:
            rows.append(run_level(level, prev))
            prev = level
    finally:
        log("tearing down every room...")
        stop_keepalive.set()
        ka.join(timeout=5)
        for p in list(all_peers):
            if p.sc:
                try:
                    p.sc.close(intentional=True)
                except Exception:
                    pass
        sink.close()

    log(f"RUN {RUN_ID} COMPLETE — summary: {SUMMARY_PATH}")
    log(f"{'rooms':>6} {'peers':>6} {'conn p50':>9} {'conn p95':>9} {'fanout p50':>11} {'err':>4}")
    for r in rows:
        log(f"{r['level_rooms']:>6} {r['total_peers']:>6} "
            f"{(r['connect_ms_p50'] and round(r['connect_ms_p50'])) or '-':>9} "
            f"{(r['connect_ms_p95'] and round(r['connect_ms_p95'])) or '-':>9} "
            f"{(r['fanout_ms_p50'] and round(r['fanout_ms_p50'])) or '-':>11} "
            f"{r['connect_errors']:>4}")


if __name__ == "__main__":
    main()

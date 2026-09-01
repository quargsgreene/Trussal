#!/usr/bin/env python3
"""
JVB / SFU stats — optional, best-effort.

Two sources, tried in order:
  1. Colibri REST  (only if COLIBRI_REST_ENABLED=1 in docker-jitsi-meet/.env and
     jvb.conf apis.rest.enabled = true): GET http://127.0.0.1:8080/colibri/stats
     over SSH on the video VM. Rich: bit_rate_download/upload, packet_rate_*,
     loss_rate_*, conferences, participants, jitter_aggregate, rtt_aggregate,
     stress_level, largest_conference.
  2. Fallback: `docker logs --since <interval>s <jvb>` and scrape the periodic
     "Stats:" / "expire" lines the bridge prints even with REST off.

Enabling #1 (recommended, on staging):
  in docker-jitsi-meet/.env:      COLIBRI_REST_ENABLED=1
  in custom-config/jvb/jvb.conf:  videobridge.apis.rest.enabled = true
  then:  docker compose up -d --force-recreate jvb

Env: RUN_ID PROFILE SCENARIO
"""

from __future__ import annotations

import argparse
import json
import os
import signal
import sys
import time
from pathlib import Path

import paramiko

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness.common import MetricSink, RunContext, load_inventory
from collectors.host_stats import ssh_connect, run  # reuse

FLAT_KEYS = [
    "bit_rate_download", "bit_rate_upload", "packet_rate_download", "packet_rate_upload",
    "loss_rate_download", "loss_rate_upload", "rtp_loss", "jitter_aggregate",
    "rtt_aggregate", "conferences", "participants", "videochannels", "audiochannels",
    "endpoints_sending_audio", "endpoints_sending_video", "largest_conference",
    "stress_level", "total_packets_dropped", "threads", "cpu_usage",
    "total_conference_seconds", "total_ice_failed", "total_ice_succeeded",
]


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--inventory", default=os.environ.get("INVENTORY", "config/inventory.yaml"))
    p.add_argument("--interval", type=float, default=5.0)
    p.add_argument("--duration", type=float, default=0)
    a = p.parse_args(argv)

    ctx = RunContext.from_env()
    sink = MetricSink(ctx, "jvb_stats")
    inv = load_inventory(a.inventory)
    video = inv["vms"]["video"]
    stats_url = video.get("colibri_stats_url", "http://127.0.0.1:8080/colibri/stats")
    jvb_name = next((c for c in video.get("containers", []) if "jvb" in c), "jvb")

    stop = {"v": False}
    signal.signal(signal.SIGTERM, lambda *_: stop.__setitem__("v", True))
    signal.signal(signal.SIGINT, lambda *_: stop.__setitem__("v", True))

    try:
        cli = ssh_connect(video["ssh"])
    except Exception as e:
        sink.event("ssh_failed", reason=repr(e))
        sink.close()
        return 2

    have_rest = None
    deadline = time.time() + a.duration if a.duration > 0 else float("inf")
    while not stop["v"] and time.time() < deadline:
        t0 = time.time()
        got = False
        if have_rest is not False:
            raw = run(cli, f"curl -s --max-time 5 {stats_url} || true")
            try:
                data = json.loads(raw)
                have_rest = True
                got = True
                for k in FLAT_KEYS:
                    if k in data and isinstance(data[k], (int, float)):
                        sink.sample(f"jvb_{k}", float(data[k]), entity="jvb")
            except (ValueError, TypeError):
                have_rest = False
        if not got:
            # log fallback
            raw = run(cli, f"docker logs --since {int(a.interval)+2}s {jvb_name} 2>&1 | "
                           f"grep -iE 'stat|conference|expire' | tail -n 40 || true")
            n_conf = raw.count("created conference")
            if raw.strip():
                sink.event("jvb_log_scrape", lines=len(raw.splitlines()), created_conf=n_conf)
        sink.event("jvb_source", rest=bool(have_rest))
        time.sleep(max(0.5, a.interval - (time.time() - t0)))

    cli.close()
    sink.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

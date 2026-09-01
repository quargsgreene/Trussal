#!/usr/bin/env python3
"""
Server-side resource sampler. SSHes (paramiko) to the three Trussal VMs from
inventory.yaml and samples, every --interval seconds:

  docker stats --no-stream   (CPU %, mem, net I/O, block I/O) for the named containers
  /proc/loadavg              (1/5/15 load)
  /proc/net/dev              (per-iface bytes/pkts/drops -> rates)
  ss -s                      (socket totals; TCP mem)
  bots VM: GET :7777/api/rooms and /api/bots  (fleet size, aggregator liveness)

One long-lived SSH channel per VM; runs until --duration or SIGTERM.
Env: RUN_ID PROFILE SCENARIO
"""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import sys
import threading
import time
from pathlib import Path

import paramiko

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness.common import MetricSink, RunContext, load_inventory


def ssh_connect(target: str) -> paramiko.SSHClient:
    user, host = target.split("@", 1)
    cli = paramiko.SSHClient()
    cli.load_system_host_keys()
    cli.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    cli.connect(host, username=user, timeout=15, banner_timeout=15, auth_timeout=15)
    return cli


def run(cli: paramiko.SSHClient, cmd: str, timeout=20) -> str:
    _in, out, err = cli.exec_command(cmd, timeout=timeout)
    return out.read().decode("utf-8", "replace")


class VMSampler(threading.Thread):
    def __init__(self, vm_name: str, spec: dict, sink: MetricSink, interval: float, stop_evt: threading.Event):
        super().__init__(name=f"vm-{vm_name}", daemon=True)
        self.vm_name = vm_name
        self.spec = spec
        self.sink = sink
        self.interval = interval
        self.stop_evt = stop_evt
        self.cli = None
        self._net_prev = {}   # iface -> (rx_bytes, tx_bytes, t)

    # ---- parsers ----
    def _docker_stats(self):
        names = list(self.spec.get("containers", []))
        prefix = self.spec.get("container_prefix")
        if prefix:
            ls = run(self.cli, f"docker ps --format '{{{{.Names}}}}' | grep '^{prefix}' || true")
            names += [n for n in ls.split() if n]
        if not names:
            return
        fmt = "{{.Name}};{{.CPUPerc}};{{.MemUsage}};{{.MemPerc}};{{.NetIO}};{{.BlockIO}};{{.PIDs}}"
        txt = run(self.cli, f"docker stats --no-stream --format '{fmt}' {' '.join(names)} 2>/dev/null || true")
        for line in txt.splitlines():
            parts = line.split(";")
            if len(parts) < 7:
                continue
            name, cpu, memusage, memperc, netio, blockio, pids = parts
            # `docker-jitsi-meet-jvb-1.2` -> `jvb`, so the entity stays a stable
            # `<vm>/<service>` regardless of the compose project prefix (what the
            # figures key on). Only rewrites the compose form; `trussal-bot-99999`
            # and already-short names are untouched.
            base = name.split(".")[0]
            base = re.sub(r"^docker-jitsi-meet-(.*?)-\d+$", r"\1", base)
            self.sink.sample("cpu_pct", _pct(cpu), entity=f"{self.vm_name}/{base}")
            self.sink.sample("mem_mb", _size_mb(memusage.split("/")[0]), entity=f"{self.vm_name}/{base}")
            self.sink.sample("mem_pct", _pct(memperc), entity=f"{self.vm_name}/{base}")
            rx, tx = netio.split("/")
            self.sink.sample("net_rx_mb_cum", _size_mb(rx), entity=f"{self.vm_name}/{base}")
            self.sink.sample("net_tx_mb_cum", _size_mb(tx), entity=f"{self.vm_name}/{base}")
            self.sink.sample("pids", _num(pids), entity=f"{self.vm_name}/{base}")
        # a simple count of dynamic bot containers
        if prefix:
            self.sink.sample("bot_containers", len([n for n in names if n.startswith(prefix)]),
                             entity=self.vm_name)

    def _loadavg(self):
        txt = run(self.cli, "cat /proc/loadavg; nproc")
        lines = txt.split()
        if len(lines) >= 3:
            self.sink.sample("load1", _num(lines[0]), entity=self.vm_name)
            self.sink.sample("load5", _num(lines[1]), entity=self.vm_name)
        if lines and lines[-1].isdigit():
            self.sink.sample("nproc", int(lines[-1]), entity=self.vm_name)

    def _net_dev(self):
        txt = run(self.cli, "cat /proc/net/dev")
        now = time.time()
        for line in txt.splitlines():
            if ":" not in line:
                continue
            iface, rest = line.split(":", 1)
            iface = iface.strip()
            if iface in ("lo",):
                continue
            f = rest.split()
            if len(f) < 16:
                continue
            rx_bytes, tx_bytes = int(f[0]), int(f[8])
            rx_drop, tx_drop = int(f[3]), int(f[11])
            prev = self._net_prev.get(iface)
            self._net_prev[iface] = (rx_bytes, tx_bytes, now)
            if prev:
                dt = now - prev[2]
                if dt > 0:
                    self.sink.sample("net_rx_mbps", (rx_bytes - prev[0]) * 8 / dt / 1e6,
                                     entity=f"{self.vm_name}/{iface}")
                    self.sink.sample("net_tx_mbps", (tx_bytes - prev[1]) * 8 / dt / 1e6,
                                     entity=f"{self.vm_name}/{iface}")
            self.sink.sample("net_rx_drop_cum", rx_drop, entity=f"{self.vm_name}/{iface}")
            self.sink.sample("net_tx_drop_cum", tx_drop, entity=f"{self.vm_name}/{iface}")

    def _sockets(self):
        txt = run(self.cli, "ss -s")
        m = re.search(r"TCP:\s+(\d+)", txt)
        if m:
            self.sink.sample("tcp_sockets", int(m.group(1)), entity=self.vm_name)
        m = re.search(r"estab (\d+)", txt)
        if m:
            self.sink.sample("tcp_estab", int(m.group(1)), entity=self.vm_name)

    def _conductor(self):
        admin = self.spec.get("conductor_admin")
        if not admin:
            return
        try:
            rooms = json.loads(run(self.cli, f"curl -s --max-time 5 {admin}/api/rooms || echo '[]'"))
            bots = json.loads(run(self.cli, f"curl -s --max-time 5 {admin}/api/bots || echo '[]'"))
        except (ValueError, TypeError):
            return
        self.sink.sample("conductor_bots_total", len(bots), entity=self.vm_name)
        for r in rooms if isinstance(rooms, list) else []:
            self.sink.sample("room_bots", r.get("bots", 0), entity=f"{self.vm_name}/{r.get('room')}")
            self.sink.sample("room_participants", r.get("participants", 0),
                             entity=f"{self.vm_name}/{r.get('room')}")
            self.sink.event("room_aggregator", entity=f"{self.vm_name}/{r.get('room')}",
                            running=bool(r.get("aggregatorRunning")))

    def run(self):
        try:
            self.cli = ssh_connect(self.spec["ssh"])
        except Exception as e:
            self.sink.event("ssh_failed", entity=self.vm_name, reason=repr(e))
            return
        self.sink.event("sampler_up", entity=self.vm_name)
        while not self.stop_evt.is_set():
            t0 = time.time()
            for fn in (self._docker_stats, self._loadavg, self._net_dev, self._sockets, self._conductor):
                try:
                    fn()
                except Exception as e:  # a transient ssh hiccup must not kill the sampler
                    self.sink.event("sample_error", entity=self.vm_name, fn=fn.__name__, reason=repr(e)[:160])
            self.stop_evt.wait(max(0.5, self.interval - (time.time() - t0)))
        try:
            self.cli.close()
        except Exception:
            pass
        self.sink.event("sampler_down", entity=self.vm_name)


def _num(s):
    m = re.search(r"-?\d+(\.\d+)?", str(s))
    return float(m.group()) if m else 0.0


def _pct(s):
    return _num(str(s).replace("%", ""))


def _size_mb(s):
    s = str(s).strip()
    m = re.match(r"([\d.]+)\s*([kKmMgG]?i?)B?", s)
    if not m:
        return 0.0
    v, unit = float(m.group(1)), m.group(2).lower()
    return v * {"": 1e-6, "k": 1e-3, "ki": 1 / 1024, "m": 1.0, "mi": 1.0,
                "g": 1024.0, "gi": 1024.0}.get(unit, 1e-6)


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--inventory", default=os.environ.get("INVENTORY", "config/inventory.yaml"))
    p.add_argument("--interval", type=float, default=5.0)
    p.add_argument("--duration", type=float, default=0)
    a = p.parse_args(argv)

    ctx = RunContext.from_env()
    sink = MetricSink(ctx, "host_stats")
    inv = load_inventory(a.inventory)
    stop_evt = threading.Event()
    signal.signal(signal.SIGTERM, lambda *_: stop_evt.set())
    signal.signal(signal.SIGINT, lambda *_: stop_evt.set())

    threads = [VMSampler(name, spec, sink, a.interval, stop_evt)
               for name, spec in inv.get("vms", {}).items() if spec.get("ssh")]
    for t in threads:
        t.start()

    deadline = time.time() + a.duration if a.duration > 0 else float("inf")
    while not stop_evt.is_set() and time.time() < deadline:
        time.sleep(1)
    stop_evt.set()
    for t in threads:
        t.join(timeout=10)
    sink.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())

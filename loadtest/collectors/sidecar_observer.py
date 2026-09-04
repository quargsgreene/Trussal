#!/usr/bin/env python3
"""
Passive app-plane recorder. Connects to the sidecar as ?role=observer (invisible
to the roster, receives every broadcast) and logs, with local arrival time:

  peer-join / peer-leave      -> session lifetimes, roster composition
  peer-update (metrics patch) -> every REAL client's self-reported NetStats
                                 (rtt / jitter / packetLoss / rtcRtt / rtcJitter),
                                 which is also how we see the containerised bots
  nc-active                   -> aggregator ring cadence + drift as the ring grows
  fleet-status                -> spawn/remove/teardown outcomes and reasons
  crdt-update                 -> metaprogram fan-out volume

Run one per room for the duration of a cell:
    python collectors/sidecar_observer.py --room <room> --duration <s>
Env: RUN_ID PROFILE SCENARIO TRUSSAL_HOST TRUSSAL_SCHEME
"""

from __future__ import annotations

import argparse
import os
import signal
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness.common import MetricSink, RunContext
from harness.sidecar import SidecarClient


class Observer:
    def __init__(self, room: str, duration: float):
        self.ctx = RunContext.from_env()
        self.room = room
        self.duration = duration
        self.sink = MetricSink(self.ctx, "sidecar_observer")
        self.peers: dict[str, dict] = {}         # peerId -> {roomIndex,isBot,joined_t}
        self._last_nc_token = None
        self._last_nc_t = None
        self._nc_first_t = None
        self.stop = False

    def _kind(self, p: dict) -> str:
        if p.get("isAggregator"):
            return "aggregator"
        return "bot" if p.get("isBot") else "human"

    def _counts(self) -> dict:
        c = {"human": 0, "bot": 0, "aggregator": 0}
        for p in self.peers.values():
            c[p["kind"]] = c.get(p["kind"], 0) + 1
        return c

    def on_event(self, kind: str, data: dict):
        now = time.time()
        if kind == "roster":
            # initial roster: sidecar sent public views; SidecarClient stored them
            return
        if kind == "peer-join":
            p = data.get("peer") or {}
            pid = p.get("peerId")
            if pid:
                self.peers[pid] = {
                    "roomIndex": p.get("roomIndex"), "isBot": p.get("isBot"),
                    "kind": self._kind(p), "joined_t": now,
                    "displayName": p.get("displayName"),
                }
            c = self._counts()
            self.sink.event("peer_join", entity=str(p.get("roomIndex")),
                            peer_kind=self._kind(p), roster=data.get("size"), **c)
        elif kind == "peer-leave":
            pid = data.get("peerId")
            gone = self.peers.pop(pid, None)
            dur = (now - gone["joined_t"]) if gone else None
            c = self._counts()
            self.sink.event("peer_leave",
                            entity=str(gone["roomIndex"]) if gone else "",
                            peer_kind=gone["kind"] if gone else "unknown",
                            session_s=dur, roster=data.get("size"), **c)
        elif kind == "peer-update":
            patch = data.get("patch") or {}
            pid = data.get("peerId")
            who = self.peers.get(pid, {})
            ri = str(who.get("roomIndex")) if who else pid
            for m in ("rtt", "jitter", "packetLoss", "rtcRtt", "rtcJitter",
                      "jitterBufferMs", "pipelineMs"):
                v = patch.get(m)
                if isinstance(v, (int, float)):
                    self.sink.sample(f"peer_{m}", float(v), entity=ri, peer_kind=who.get("kind", "?"))
        elif kind == "nc-active":
            tok = data.get("token")
            if self._nc_first_t is None:
                self._nc_first_t = now
            gap = (now - self._last_nc_t) if self._last_nc_t is not None else None
            self.sink.event("nc_active", entity=str(tok), token=tok,
                            index=data.get("index"), nc_kind=data.get("kind"),
                            gap_s=gap)
            if gap is not None:
                self.sink.sample("nc_turn_gap_s", gap, entity=str(tok))
            self._last_nc_token, self._last_nc_t = tok, now
        elif kind == "fleet-status":
            self.sink.event("fleet_status", entity=str(data.get("ownerIndex")),
                            action=data.get("action"), spawned=data.get("spawned"),
                            removed=data.get("removed"), reason=data.get("reason"),
                            fleetSize=data.get("fleetSize"), ceiling=data.get("ceiling"))
        elif kind == "crdt-update":
            self.sink.sample("crdt_update_bytes", len(data.get("update", "") or ""),
                             entity=str(data.get("authorIndex")),
                             modality=data.get("modality"), channel=data.get("channel"))
        elif kind == "disconnected":
            self.sink.event("observer_disconnected", reason=data.get("reason"),
                            code=data.get("code"))
            self.stop = True

    def run(self) -> int:
        signal.signal(signal.SIGTERM, lambda *_: setattr(self, "stop", True))
        signal.signal(signal.SIGINT, lambda *_: setattr(self, "stop", True))
        sc = SidecarClient(
            self.ctx.sidecar_url(self.room, "observer"),
            display_name=f"observer-{self.ctx.node}", is_fleet=True,
            on_event=self.on_event, name="observer",
        )
        try:
            sc.connect(timeout=30)
            sc.wait_roster(timeout=30)
        except Exception as e:
            self.sink.event("observer_connect_failed", reason=repr(e))
            self.sink.close()
            return 2
        # fold the initial roster in
        for pid, p in list(sc.peers.items()):
            self.peers[pid] = {"roomIndex": p.get("roomIndex"), "isBot": p.get("isBot"),
                               "kind": self._kind(p), "joined_t": time.time()}
        # which shard the edge LB routed this room to (X-Jitsi-Shard on the /ws
        # 101). "" for an unsharded stack — shard_balance() then has nothing to
        # tally, exactly as for a single-target run.
        shard = sc.handshake_headers.get("x-jitsi-shard", "")
        self.sink.event("serving_shard", entity=shard, room=self.room, shard=shard)
        self.sink.event("observer_up", room=self.room, serving_shard=shard, **self._counts())

        deadline = time.time() + self.duration if self.duration > 0 else float("inf")
        while not self.stop and time.time() < deadline and not sc.closed.is_set():
            c = self._counts()
            self.sink.sample("roster_size", sum(c.values()))
            for k, v in c.items():
                self.sink.sample(f"roster_{k}", v)
            time.sleep(5)
        sc.close(intentional=True)
        self.sink.event("observer_down", **self._counts())
        self.sink.close()
        return 0


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--room", required=True)
    p.add_argument("--duration", type=float, default=0)
    a = p.parse_args(argv)
    return Observer(a.room, a.duration).run()


if __name__ == "__main__":
    sys.exit(main())

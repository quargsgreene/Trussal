#!/usr/bin/env python3
"""
Fig 13 — REAL measurement: how many concurrent, independent, live rooms cost,
from tools/multiroom_driver.py against a live staging Trussal. Rooms accumulate
(nothing torn down between levels), so level N is N rooms all live and
chattering at once, not N one at a time.
  left  — join/roster-settle latency (the batch that joins at each level) and
          in-room broadcast fan-out latency (one peer's update -> a sibling in
          the SAME room seeing it) — both vs total rooms in play. Flat = the
          sidecar's one-big-Map-of-rooms design does not create cross-room
          head-of-line blocking as room count grows.
  right — server host CPU (the two containers that move: nginx `web`, the
          `latency` sidecar) vs total rooms in play. jicofo/jvb/prosody stay
          near-zero throughout BECAUSE these are sidecar-only ghost peers, same
          as S1's app-plane cell — no XMPP MUC join, no JVB conference, no
          browser. This measures the APP-PLANE (sidecar + nginx fan-out) cost
          of many concurrent rooms, not prosody/jicofo/JVB per-room overhead.

    python figures/fig13_room_scaling.py --run results/<run-id>
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from plotstyle import apply_style, new_figure, CATEGORICAL_COLORS

OUTPUT_NAME = "fig13_room_scaling"


def _load(run_dir):
    if not run_dir:
        return None
    path = Path(run_dir) / "multiroom_summary.jsonl"
    if not path.exists():
        return None
    rows = [json.loads(line) for line in open(path)]
    return rows or None


def build_figure(run_dir=None, column="double"):
    if column == "single":
        column = "1p5"
    apply_style(column)
    rows = _load(run_dir)
    figure, (latency_axes, cpu_axes) = new_figure(column, width_to_height_ratio=2.3, n_columns=2)

    if not rows:
        for axes in (latency_axes, cpu_axes):
            axes.text(0.5, 0.5, "no multiroom_summary.jsonl in this run\n"
                                "(run tools/multiroom_driver.py first)",
                      ha="center", va="center", fontsize=7, transform=axes.transAxes)
            axes.set_xticks([]); axes.set_yticks([])
        return figure, True

    levels = [r["level_rooms"] for r in rows]
    conn_p50 = [r["connect_ms_p50"] for r in rows]
    conn_p95 = [r["connect_ms_p95"] for r in rows]
    fanout_p50 = [r["fanout_ms_p50"] for r in rows]

    latency_axes.plot(levels, conn_p50, marker="o", color=CATEGORICAL_COLORS[0], label="join p50")
    latency_axes.plot(levels, conn_p95, marker="o", ms=4, ls="--", color=CATEGORICAL_COLORS[0],
                      alpha=0.6, label="join p95")
    latency_axes.plot(levels, fanout_p50, marker="s", color=CATEGORICAL_COLORS[1],
                      label="in-room fan-out p50")
    latency_axes.set_xlabel("rooms in play (cumulative)")
    latency_axes.set_ylabel("latency (ms)")
    latency_axes.set_ylim(bottom=0)
    latency_axes.legend(loc="upper left")

    def cpu_series(name_fragment):
        out = []
        for r in rows:
            containers = r.get("host", {}).get("containers", {})
            val = next((float(v["cpu_pct"]) for k, v in containers.items() if name_fragment in k), None)
            out.append(val)
        return out

    web_cpu = cpu_series("web")
    sidecar_cpu = cpu_series("latency")
    jvb_cpu = cpu_series("jvb")
    if any(v is not None for v in web_cpu):
        cpu_axes.plot(levels, web_cpu, marker="o", color=CATEGORICAL_COLORS[0], label="nginx (web)")
    if any(v is not None for v in sidecar_cpu):
        cpu_axes.plot(levels, sidecar_cpu, marker="s", color=CATEGORICAL_COLORS[1], label="latency sidecar")
    if any(v is not None for v in jvb_cpu):
        cpu_axes.plot(levels, jvb_cpu, marker="^", ms=4, color=CATEGORICAL_COLORS[2],
                      label="jvb (idle — no media)")
    cpu_axes.set_xlabel("rooms in play (cumulative)")
    cpu_axes.set_ylabel("host CPU (% of one core)")
    cpu_axes.set_ylim(bottom=0)
    cpu_axes.legend(loc="upper left")

    total_peers = rows[-1]["total_peers"]
    figure.suptitle(f"{levels[-1]} rooms / {total_peers} sidecar-only peers, real staging run",
                    fontsize=6.5, color="#8a8880", y=0.02)

    return figure, False


if __name__ == "__main__":
    from _cli import figure_main
    figure_main(build_figure, OUTPUT_NAME)

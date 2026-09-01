#!/usr/bin/env python3
"""
Fig 1 — per-client inbound media bitrate vs room size (scenario S1), one line
per WWAN profile. Shows the SFU throttling each client's received video as the
uplink cap and contention bite. Sequential blue ramp: darker = more impaired.

    python figures/fig01_bandwidth_vs_participants.py --run results/<id> --column single
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from plotstyle import apply_style, new_figure, profile_color, direct_label, watermark
from _cli import figure_main, stats_by
from _data import (load_summary, ensure_scenarios, PROFILE_IDS, PROFILE_LABELS,
                   is_synthetic)

OUTPUT_NAME = "fig01_bandwidth_vs_participants"


def build_figure(run_dir=None, column="single"):
    apply_style(column)
    summary = ensure_scenarios(load_summary(run_dir), ["S1"], lambda: load_summary(None))
    steady_join = summary[summary.scenario == "S1"]
    figure, axes = new_figure(column, width_to_height_ratio=1.5)

    profiles_present = [p for p in PROFILE_IDS if p in steady_join.profile.unique()]
    for profile_index, profile_id in enumerate(profiles_present):
        bitrate_by_room_size = stats_by(
            steady_join[steady_join.profile == profile_id], "level", "bitrate_in_kbps_total"
        ).sort_values("level")
        if bitrate_by_room_size.empty:
            continue
        line_color = profile_color(profile_index, len(profiles_present))
        axes.plot(bitrate_by_room_size.level, bitrate_by_room_size.p50, marker="o",
                  color=line_color, label=PROFILE_LABELS.get(profile_id, profile_id), zorder=3)
        if {"p05", "p95"}.issubset(bitrate_by_room_size.columns):
            axes.fill_between(bitrate_by_room_size.level, bitrate_by_room_size.p05,
                              bitrate_by_room_size.p95, color=line_color, alpha=0.15, lw=0)
        direct_label(axes, bitrate_by_room_size.level.iloc[-1], bitrate_by_room_size.p50.iloc[-1],
                     PROFILE_LABELS.get(profile_id, profile_id), line_color)

    axes.set_xlabel("participants in room")
    axes.set_ylabel("inbound bitrate per client (kbit/s)")
    axes.set_xscale("log", base=2)
    axes.set_xticks(sorted(steady_join.level.unique()))
    axes.get_xaxis().set_major_formatter(lambda tick_value, _pos: f"{int(tick_value)}")
    axes.legend(title="network", ncol=2, loc="upper right")
    if is_synthetic(summary):
        watermark(figure)
    return figure, is_synthetic(summary)


if __name__ == "__main__":
    figure_main(build_figure, OUTPUT_NAME)

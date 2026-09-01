#!/usr/bin/env python3
"""
Fig 2 — received frame rate vs WWAN profile (scenario S1), one line per room
size. Profiles on x are ordered clean -> worst; room size is the categorical
dimension (validated categorical order), extremes direct-labelled.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from plotstyle import apply_style, new_figure, CATEGORICAL_COLORS, direct_label, watermark
from _cli import figure_main, stats_by
from _data import (load_summary, ensure_scenarios, PROFILE_IDS, PROFILE_LABELS,
                   is_synthetic)

OUTPUT_NAME = "fig02_framerate_vs_network"


def build_figure(run_dir=None, column="single"):
    apply_style(column)
    summary = ensure_scenarios(load_summary(run_dir), ["S1"], lambda: load_summary(None))
    steady_join = summary[summary.scenario == "S1"]
    figure, axes = new_figure(column, width_to_height_ratio=1.5)

    profiles_present = [p for p in PROFILE_IDS if p in steady_join.profile.unique()]
    profile_x_positions = range(len(profiles_present))
    room_sizes = sorted(steady_join.level.unique())

    for room_size_index, room_size in enumerate(room_sizes):
        frame_rate_by_profile = stats_by(
            steady_join[steady_join.level == room_size], "profile", "fps_in")
        frame_rate_by_profile = (frame_rate_by_profile.set_index("profile")
                                 .reindex(profiles_present).reset_index())
        line_color = CATEGORICAL_COLORS[room_size_index % len(CATEGORICAL_COLORS)]
        axes.plot(profile_x_positions, frame_rate_by_profile.p50, marker="o",
                  color=line_color, label=f"{int(room_size)}", zorder=3)
        if {"p05", "p95"}.issubset(frame_rate_by_profile.columns):
            axes.fill_between(list(profile_x_positions), frame_rate_by_profile.p05,
                              frame_rate_by_profile.p95, color=line_color, alpha=0.13, lw=0)
        if room_size_index in (0, len(room_sizes) - 1):
            direct_label(axes, profile_x_positions[-1], frame_rate_by_profile.p50.iloc[-1],
                         f"{int(room_size)} p.", line_color)

    axes.set_xticks(list(profile_x_positions))
    axes.set_xticklabels([PROFILE_LABELS.get(p, p) for p in profiles_present],
                         rotation=30, ha="right")
    axes.set_ylabel("received frame rate (fps)")
    axes.set_xlabel("network profile  (clean $\\rightarrow$ degraded)")
    axes.axhline(15, color="#b0afa8", lw=0.6, ls=(0, (3, 3)))
    axes.text(0, 15.2, "capture 15 fps", fontsize=6, color="#8a8981")
    axes.legend(title="room size", ncol=3, loc="lower left")
    if is_synthetic(summary):
        watermark(figure)
    return figure, is_synthetic(summary)


if __name__ == "__main__":
    figure_main(build_figure, OUTPUT_NAME)

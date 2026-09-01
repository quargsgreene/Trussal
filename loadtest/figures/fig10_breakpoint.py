#!/usr/bin/env python3
"""
Fig 10 — the participant count at which turn scheduling breaks (scenario S6),
consistent-hash ring vs maintained literal, per WWAN profile. Grouped bars:
x = profile, two bars = turn mode, y = break level (higher = survived more).
The trip condition is annotated on each bar.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from plotstyle import apply_style, new_figure, CATEGORICAL_COLORS, watermark
from _cli import figure_main
from _data import load_break_points, TURN_STUDY_PROFILES, PROFILE_LABELS, is_synthetic

OUTPUT_NAME = "fig10_breakpoint"
MODE_ORDER = ["explicit", "hash"]
MODE_LABEL = {"hash": "# ring hash", "explicit": "maintained literal"}
CONDITION_SHORT = {
    "nc_gap_multiple_of_ideal": "turn gap", "aggregator_cpu_pct": "aggr. CPU",
    "jvb_cpu_pct": "JVB CPU", "dropout_hazard_per_part_min": "dropout",
    "join_success_rate": "joins fail", "none": "no break",
}


def build_figure(run_dir=None, column="single"):
    apply_style(column)
    break_points = load_break_points(run_dir)
    figure, axes = new_figure(column, width_to_height_ratio=1.5)

    profiles_present = [p for p in TURN_STUDY_PROFILES if p in break_points.profile.unique()]
    group_centers = np.arange(len(profiles_present))
    bar_width = 0.38

    for mode_index, turn_mode in enumerate(MODE_ORDER):
        levels, conditions = [], []
        for profile_id in profiles_present:
            row = break_points[(break_points.turn_mode == turn_mode)
                               & (break_points.profile == profile_id)]
            levels.append(float(row.break_level.iloc[0]) if not row.empty else np.nan)
            conditions.append(row.condition.iloc[0] if not row.empty else "none")
        bar_positions = group_centers + (mode_index - 0.5) * bar_width
        bars = axes.bar(bar_positions, levels, bar_width * 0.92,
                        color=CATEGORICAL_COLORS[mode_index], label=MODE_LABEL[turn_mode],
                        edgecolor="white", linewidth=0.4)
        for rect, level, condition in zip(bars, levels, conditions):
            if not np.isnan(level):
                axes.annotate(f"{int(level)}\n{CONDITION_SHORT.get(condition, condition)}",
                              (rect.get_x() + rect.get_width() / 2, level),
                              textcoords="offset points", xytext=(0, 2), ha="center",
                              fontsize=5.6, color="#52514e")

    axes.set_xticks(group_centers)
    axes.set_xticklabels([PROFILE_LABELS.get(p, p) for p in profiles_present])
    axes.set_ylabel("participants at turn-scheduling break")
    axes.legend(loc="upper right")
    if is_synthetic(break_points):
        watermark(figure)
    return figure, is_synthetic(break_points)


if __name__ == "__main__":
    figure_main(build_figure, OUTPUT_NAME)

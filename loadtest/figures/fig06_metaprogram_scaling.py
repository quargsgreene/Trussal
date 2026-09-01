#!/usr/bin/env python3
"""
Fig 6 — aggregator ring rotation period vs metaprogram size (scenario S3): the
observed gap between successive `nc-active` turns as `$ participants` grows one
token at a time, one line per WWAN profile, against the ideal slot period.
If the ring can't keep up, the measured period rises above the ideal.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from plotstyle import apply_style, new_figure, profile_color, direct_label, watermark
from _cli import figure_main, stats_by
from _data import (load_summary, ensure_scenarios, PROFILE_IDS, PROFILE_LABELS,
                   is_synthetic)

OUTPUT_NAME = "fig06_metaprogram_scaling"
IDEAL_SLOT_SECONDS = 4.0   # config/scenarios.yaml S3 default rotation


def build_figure(run_dir=None, column="single"):
    apply_style(column)
    summary = ensure_scenarios(load_summary(run_dir), ["S3"], lambda: load_summary(None))
    metaprogram_growth = summary[summary.scenario == "S3"]
    turn_gap_metric = ("nc_turn_gap_s" if (metaprogram_growth.metric == "nc_turn_gap_s").any()
                       else "nc_active_gap_s")
    figure, axes = new_figure(column, width_to_height_ratio=1.5)

    profiles_present = [p for p in PROFILE_IDS if p in metaprogram_growth.profile.unique()]
    for profile_index, profile_id in enumerate(profiles_present):
        turn_gap_by_token_count = stats_by(
            metaprogram_growth[metaprogram_growth.profile == profile_id], "level", turn_gap_metric
        ).sort_values("level")
        if turn_gap_by_token_count.empty:
            continue
        line_color = profile_color(profile_index, len(profiles_present))
        axes.plot(turn_gap_by_token_count.level, turn_gap_by_token_count.p50, marker="o",
                  color=line_color, label=PROFILE_LABELS.get(profile_id, profile_id), zorder=3)
        if {"p05", "p95"}.issubset(turn_gap_by_token_count.columns):
            axes.fill_between(turn_gap_by_token_count.level, turn_gap_by_token_count.p05,
                              turn_gap_by_token_count.p95, color=line_color, alpha=0.13, lw=0)
        direct_label(axes, turn_gap_by_token_count.level.iloc[-1],
                     turn_gap_by_token_count.p50.iloc[-1],
                     PROFILE_LABELS.get(profile_id, profile_id), line_color)

    axes.axhline(IDEAL_SLOT_SECONDS, color="#8a8981", lw=0.7, ls=(0, (3, 3)))
    axes.text(metaprogram_growth.level.min(), IDEAL_SLOT_SECONDS * 1.03, "ideal slot",
              fontsize=6, color="#8a8981")
    axes.set_xlabel(r"tokens in $\$\,$participants sequence")
    axes.set_ylabel("measured turn period (s)")
    axes.set_xticks(sorted(metaprogram_growth.level.unique()))
    axes.legend(title="network", ncol=2, loc="upper left")
    if is_synthetic(summary):
        watermark(figure)
    return figure, is_synthetic(summary)


if __name__ == "__main__":
    figure_main(build_figure, OUTPUT_NAME)

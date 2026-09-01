#!/usr/bin/env python3
"""
Fig 5 — involuntary-dropout hazard (leaves per participant-minute) at each
scenario's heaviest load step, grouped bars by a 4-profile subset. This is the
resilience headline: which kind of load, under which network, sheds participants.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from plotstyle import apply_style, new_figure, CATEGORICAL_COLORS, watermark
from _cli import figure_main
from _data import (load_dropout_rate, _synthetic_dropout_rate,
                   PROFILE_LABELS, is_synthetic)

OUTPUT_NAME = "fig05_dropout_vs_scenario"
PROFILES_TO_SHOW = ["p2_lte_typical", "p3_lte_busy", "p4_hspa", "p5_edge"]
SCENARIO_ORDER = ["S1", "S2", "S3", "S4"]
SCENARIO_LABELS = {"S1": "steady\njoin", "S2": "bot\nswarm",
                   "S3": "metaprogram\ngrowth", "S4": "code\nvolume"}


def build_figure(run_dir=None, column="single"):
    apply_style(column)
    dropout_rate = load_dropout_rate(run_dir)
    heaviest_step = dropout_rate.loc[
        dropout_rate.groupby(["profile", "scenario"])["level"].idxmax()]
    figure, axes = new_figure(column, width_to_height_ratio=1.5)

    scenarios_present = [s for s in SCENARIO_ORDER if s in heaviest_step.scenario.unique()]
    profiles_present = [p for p in PROFILES_TO_SHOW if p in heaviest_step.profile.unique()]
    if not profiles_present or not scenarios_present:
        # real frame carried no cell on the manuscript profile/scenario grid;
        # render the synthetic reference so the batch still produces this panel
        synthetic = _synthetic_dropout_rate()
        heaviest_step = synthetic.loc[
            synthetic.groupby(["profile", "scenario"])["level"].idxmax()]
        dropout_rate = synthetic
        scenarios_present = [s for s in SCENARIO_ORDER if s in heaviest_step.scenario.unique()]
        profiles_present = [p for p in PROFILES_TO_SHOW if p in heaviest_step.profile.unique()]
    bars_per_group = len(profiles_present)
    bar_width = 0.8 / bars_per_group
    group_centers = np.arange(len(scenarios_present))

    for profile_index, profile_id in enumerate(profiles_present):
        hazard_per_scenario = [
            float(heaviest_step[(heaviest_step.scenario == scenario)
                                & (heaviest_step.profile == profile_id)]
                  ["hazard_per_part_min"].mean() or 0)
            for scenario in scenarios_present
        ]
        bar_positions = group_centers + (profile_index - (bars_per_group - 1) / 2) * bar_width
        axes.bar(bar_positions, hazard_per_scenario, bar_width * 0.92,
                 color=CATEGORICAL_COLORS[profile_index],
                 label=PROFILE_LABELS.get(profile_id, profile_id),
                 edgecolor="white", linewidth=0.4)
        for bar_x, hazard_value in zip(bar_positions, hazard_per_scenario):
            if hazard_value > 0:
                axes.annotate(f"{hazard_value:.2f}", (bar_x, hazard_value),
                              textcoords="offset points", xytext=(0, 1.5),
                              ha="center", fontsize=5.6, color="#52514e")

    axes.set_xticks(group_centers)
    axes.set_xticklabels([SCENARIO_LABELS.get(s, s) for s in scenarios_present])
    axes.set_ylabel("involuntary dropout\n(leaves / participant-minute)")
    axes.margins(y=0.18)   # headroom for the value labels
    axes.legend(title="network", ncol=len(profiles_present),
                loc="lower center", bbox_to_anchor=(0.5, 1.0), borderaxespad=0.3)
    if is_synthetic(dropout_rate):
        watermark(figure)
    return figure, is_synthetic(dropout_rate)


if __name__ == "__main__":
    figure_main(build_figure, OUTPUT_NAME)

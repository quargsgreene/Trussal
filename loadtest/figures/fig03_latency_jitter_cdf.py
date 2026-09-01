#!/usr/bin/env python3
"""
Fig 3 — ECDF of per-sample end-to-end RTT (left) and RTP jitter (right) at a
fixed mid load (S1, 64 participants), one curve per WWAN profile. 1x2 small
multiple; defaults to double-column width.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from plotstyle import apply_style, new_figure, profile_color, watermark
from _cli import figure_main
from _data import (load_observations, ensure_scenarios, PROFILE_IDS,
                   PROFILE_LABELS, is_synthetic)

OUTPUT_NAME = "fig03_latency_jitter_cdf"


def _plot_ecdf(axes, sample_values, line_color, series_label):
    sorted_values = np.sort(np.asarray(sample_values, dtype=float))
    sorted_values = sorted_values[np.isfinite(sorted_values)]
    if sorted_values.size == 0:
        return
    cumulative_fraction = np.arange(1, sorted_values.size + 1) / sorted_values.size
    axes.plot(sorted_values, cumulative_fraction, color=line_color, label=series_label, lw=1.0)


def build_figure(run_dir=None, column="double"):
    if column == "single":
        column = "1p5"
    apply_style(column)
    observations = ensure_scenarios(load_observations(run_dir), ["S1"],
                                    lambda: load_observations(None),
                                    require_metrics=["rtt_ms", "jitter_ms"])
    steady_join_samples = observations[(observations.scenario == "S1")
                                       & (observations.kind == "sample")]
    figure, (rtt_axes, jitter_axes) = new_figure(column, width_to_height_ratio=2.3, n_columns=2)

    profiles_present = [p for p in PROFILE_IDS if p in steady_join_samples.profile.unique()]
    for profile_index, profile_id in enumerate(profiles_present):
        line_color = profile_color(profile_index, len(profiles_present))
        profile_samples = steady_join_samples[steady_join_samples.profile == profile_id]
        _plot_ecdf(rtt_axes, profile_samples[profile_samples.metric == "rtt_ms"].value,
                   line_color, PROFILE_LABELS.get(profile_id, profile_id))
        _plot_ecdf(jitter_axes, profile_samples[profile_samples.metric == "jitter_ms"].value,
                   line_color, PROFILE_LABELS.get(profile_id, profile_id))

    for axes, x_label, x_upper_limit in [(rtt_axes, "end-to-end RTT (ms)", 700),
                                         (jitter_axes, "RTP jitter (ms)", 200)]:
        axes.set_ylabel("cumulative fraction")
        axes.set_xlabel(x_label)
        axes.set_ylim(0, 1)
        axes.set_xlim(0, x_upper_limit)
        axes.axhline(0.95, color="#c9c8c0", lw=0.5, ls=(0, (2, 2)))
    rtt_axes.legend(title="network", ncol=2, loc="lower right")
    if is_synthetic(observations):
        watermark(figure)
    return figure, is_synthetic(observations)


if __name__ == "__main__":
    figure_main(build_figure, OUTPUT_NAME)

#!/usr/bin/env python3
"""
Fig 7 — cost of rising code-update volume (scenario S4, performers cycling
through plain / samples / images / data-pack / Hydra / Text Cycles / CSS Cycles
payloads). 1x2 small multiple, x = bytes pushed per update (log):
  left  — video-VM `web` container CPU (p95)
  right — involuntary-dropout hazard
one line per WWAN profile. CSS Cycles forces a sidecar SCSS compile per update,
so the knee here is the server-side cost of "diverse media".
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from plotstyle import apply_style, new_figure, profile_color, watermark
from _cli import figure_main, stats_by
from _data import (load_summary, load_dropout_rate, ensure_scenarios,
                   PROFILE_IDS, PROFILE_LABELS, is_synthetic)

OUTPUT_NAME = "fig07_codevolume_media"


def build_figure(run_dir=None, column="double"):
    if column == "single":
        column = "1p5"
    apply_style(column)
    summary = ensure_scenarios(load_summary(run_dir), ["S4"], lambda: load_summary(None),
                               require_metrics="cpu_pct")
    dropout_rate = load_dropout_rate(run_dir)
    code_volume_summary = summary[summary.scenario == "S4"]
    code_volume_dropout = dropout_rate[dropout_rate.scenario == "S4"]
    figure, (web_cpu_axes, dropout_axes) = new_figure(column, width_to_height_ratio=2.3, n_columns=2)

    profiles_present = [p for p in PROFILE_IDS if p in code_volume_summary.profile.unique()]
    for profile_index, profile_id in enumerate(profiles_present):
        line_color = profile_color(profile_index, len(profiles_present))

        web_cpu_by_code_bytes = stats_by(
            code_volume_summary[code_volume_summary.profile == profile_id],
            "level", "cpu_pct", entity="video/web").sort_values("level")
        if not web_cpu_by_code_bytes.empty:
            web_cpu_axes.plot(web_cpu_by_code_bytes.level,
                              web_cpu_by_code_bytes.get("p95", web_cpu_by_code_bytes.p50),
                              marker="o", color=line_color,
                              label=PROFILE_LABELS.get(profile_id, profile_id))

        dropout_by_code_bytes = (code_volume_dropout[code_volume_dropout.profile == profile_id]
                                 .sort_values("level"))
        if not dropout_by_code_bytes.empty:
            dropout_axes.plot(dropout_by_code_bytes.level,
                              dropout_by_code_bytes.hazard_per_part_min,
                              marker="o", color=line_color,
                              label=PROFILE_LABELS.get(profile_id, profile_id))

    for axes in (web_cpu_axes, dropout_axes):
        axes.set_xscale("log")
        axes.set_xlabel("code bytes per update")
    web_cpu_axes.set_ylabel("video-VM web CPU, p95 (%)")
    dropout_axes.set_ylabel("involuntary dropout\n(leaves / participant-min)")
    web_cpu_axes.legend(title="network", ncol=2, loc="upper left")
    if is_synthetic(summary):
        watermark(figure)
    return figure, is_synthetic(summary, dropout_rate)


if __name__ == "__main__":
    figure_main(build_figure, OUTPUT_NAME)

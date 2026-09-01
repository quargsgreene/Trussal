#!/usr/bin/env python3
"""
Fig 4 — inbound packet-loss fraction vs number of bots spawned into the room
(scenario S2), one line per WWAN profile. Log y so the clean profiles stay
readable next to the degraded ones.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from plotstyle import apply_style, new_figure, profile_color, direct_label, watermark
from _cli import figure_main, stats_by
from _data import (load_summary, ensure_scenarios, PROFILE_IDS, PROFILE_LABELS,
                   is_synthetic)

OUTPUT_NAME = "fig04_packetloss_vs_bots"


def build_figure(run_dir=None, column="single"):
    apply_style(column)
    summary = ensure_scenarios(load_summary(run_dir), ["S2"], lambda: load_summary(None))
    bot_swarm = summary[summary.scenario == "S2"]
    figure, axes = new_figure(column, width_to_height_ratio=1.5)

    profiles_present = [p for p in PROFILE_IDS if p in bot_swarm.profile.unique()]
    for profile_index, profile_id in enumerate(profiles_present):
        loss_by_bot_count = stats_by(
            bot_swarm[bot_swarm.profile == profile_id], "level", "packet_loss_frac"
        ).sort_values("level")
        if loss_by_bot_count.empty:
            continue
        line_color = profile_color(profile_index, len(profiles_present))
        median_loss = loss_by_bot_count.p50.clip(lower=1e-4)
        axes.plot(loss_by_bot_count.level, median_loss, marker="o", color=line_color,
                  label=PROFILE_LABELS.get(profile_id, profile_id), zorder=3)
        if {"p05", "p95"}.issubset(loss_by_bot_count.columns):
            axes.fill_between(loss_by_bot_count.level, loss_by_bot_count.p05.clip(lower=1e-4),
                              loss_by_bot_count.p95.clip(lower=1e-4), color=line_color,
                              alpha=0.13, lw=0)
        direct_label(axes, loss_by_bot_count.level.iloc[-1], median_loss.iloc[-1],
                     PROFILE_LABELS.get(profile_id, profile_id), line_color)

    axes.set_yscale("log")
    axes.set_xlabel("bots in room")
    axes.set_ylabel("inbound packet loss (fraction)")
    axes.set_xticks(sorted(bot_swarm.level.unique()))
    axes.legend(title="network", ncol=2, loc="lower right")
    if is_synthetic(summary):
        watermark(figure)
    return figure, is_synthetic(summary)


if __name__ == "__main__":
    figure_main(build_figure, OUTPUT_NAME)

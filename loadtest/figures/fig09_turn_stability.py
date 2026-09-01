#!/usr/bin/env python3
"""
Fig 9 — turn-assignment stability under churn (scenario S5), consistent-hash
ring vs a maintained literal `$ participants`. 1x2 small multiple at one WWAN
profile (p3, LTE congested):
  left  — successor disruption: fraction of surviving tokens whose "who plays
          next" neighbour changed, per churn event
  right — time to a joiner's first turn
Two series: hash (accent) vs explicit (secondary). Defaults to double column.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from plotstyle import apply_style, new_figure, CATEGORICAL_COLORS, direct_label, watermark
from _cli import figure_main
from _data import load_turn_stability, CHURN_RATE_STEPS, is_synthetic

OUTPUT_NAME = "fig09_turn_stability"
PROFILE = "p3_lte_busy"
MODE_COLOR = {"hash": CATEGORICAL_COLORS[0], "explicit": CATEGORICAL_COLORS[1]}
MODE_LABEL = {"hash": "# ring hash", "explicit": "maintained literal"}


def _series(frame, turn_mode, metric):
    rows = frame[(frame.turn_mode == turn_mode) & (frame.profile == PROFILE)
                 & (frame.metric == metric) & (frame.stat == "p50")].sort_values("level")
    return rows.level.tolist(), rows.value.tolist()


def build_figure(run_dir=None, column="double"):
    if column == "single":
        column = "1p5"
    apply_style(column)
    turn_stability = load_turn_stability(run_dir)
    figure, (successor_axes, first_turn_axes) = new_figure(
        column, width_to_height_ratio=2.3, n_columns=2)

    for turn_mode in ("explicit", "hash"):
        color = MODE_COLOR[turn_mode]
        x_succ, y_succ = _series(turn_stability, turn_mode, "successor_disruption")
        if x_succ:
            successor_axes.plot(x_succ, y_succ, marker="o", color=color, label=MODE_LABEL[turn_mode])
            direct_label(successor_axes, x_succ[-1], y_succ[-1], MODE_LABEL[turn_mode], color)
        x_ttf, y_ttf = _series(turn_stability, turn_mode, "time_to_first_turn_s")
        if x_ttf:
            first_turn_axes.plot(x_ttf, y_ttf, marker="o", color=color, label=MODE_LABEL[turn_mode])
            direct_label(first_turn_axes, x_ttf[-1], y_ttf[-1], MODE_LABEL[turn_mode], color)

    for axes in (successor_axes, first_turn_axes):
        axes.set_xlabel("churn rate (join+leave events / min)")
        axes.set_xticks(CHURN_RATE_STEPS)
    successor_axes.set_ylabel("successor disruption\n(fraction of survivors, per churn event)")
    successor_axes.set_ylim(bottom=0)
    first_turn_axes.set_ylabel("time to a joiner's first turn (s)")
    first_turn_axes.set_ylim(bottom=0)
    successor_axes.legend(loc="upper left")
    if is_synthetic(turn_stability):
        watermark(figure)
    return figure, is_synthetic(turn_stability)


if __name__ == "__main__":
    figure_main(build_figure, OUTPUT_NAME)

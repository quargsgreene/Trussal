#!/usr/bin/env python3
"""
Fig 12 — REAL measurement (not part of the S1-S6/turn_study matrix, so no
synthetic fallback): `# ring explicit` vs `# ring hash` CRDT (Yjs metaprogram)
update traffic under the SAME roster churn, from tools/turnring_ab_driver.py
against a live staging Trussal. Left: update COUNT over the run. Right: total
BYTES moved. This is the mechanism behind fig09/10's headline claim ("hash
needs no per-join CRDT round-trip") — measured directly, independent of
whether an aggregator was present to also produce nc-active/turn-disruption
numbers (see the run's README note for what is and isn't covered).

    python figures/fig12_crdt_traffic.py --run results/<run-id>
"""
from __future__ import annotations

import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent))

from plotstyle import apply_style, new_figure, CATEGORICAL_COLORS

OUTPUT_NAME = "fig12_crdt_traffic"
MODE_LABEL = {"hash": "ring hash", "explicit": "maintained literal"}
MODE_ORDER = ["explicit", "hash"]


def _load(run_dir):
    if not run_dir:
        return None
    path = Path(run_dir) / "tidy" / "summary.parquet"
    if not path.exists():
        return None
    frame = pd.read_parquet(path)
    rows = frame[frame.metric == "crdt_update_bytes"]
    return rows if not rows.empty else None


def build_figure(run_dir=None, column="double"):
    if column == "single":
        column = "1p5"
    apply_style(column)
    rows = _load(run_dir)
    figure, (count_axes, bytes_axes) = new_figure(column, width_to_height_ratio=2.3, n_columns=2)

    if rows is None:
        for axes in (count_axes, bytes_axes):
            axes.text(0.5, 0.5, "no crdt_update_bytes rows in this run\n"
                                "(run tools/turnring_ab_driver.py, then\n"
                                "analysis/ingest.py + analysis/metrics.py)",
                      ha="center", va="center", fontsize=7, transform=axes.transAxes)
            axes.set_xticks([]); axes.set_yticks([])
        return figure, True

    x = range(len(MODE_ORDER))
    counts = [float(rows[(rows.turn_mode == m) & (rows.stat == "count")].value.iloc[0])
              if not rows[(rows.turn_mode == m) & (rows.stat == "count")].empty else 0.0
              for m in MODE_ORDER]
    means = [float(rows[(rows.turn_mode == m) & (rows.stat == "mean")].value.iloc[0])
             if not rows[(rows.turn_mode == m) & (rows.stat == "mean")].empty else 0.0
             for m in MODE_ORDER]
    totals = [c * m for c, m in zip(counts, means)]

    colors = [CATEGORICAL_COLORS[0], CATEGORICAL_COLORS[1]]
    bars = count_axes.bar(x, counts, width=0.6, color=colors, edgecolor="white", linewidth=0.4)
    for rect, val in zip(bars, counts):
        count_axes.annotate(f"{int(val)}", (rect.get_x() + rect.get_width() / 2, val),
                            textcoords="offset points", xytext=(0, 3), ha="center", fontsize=7)
    count_axes.set_xticks(list(x)); count_axes.set_xticklabels([MODE_LABEL[m] for m in MODE_ORDER])
    count_axes.set_ylabel("CRDT metaprogram updates sent\n(over the churn run)")
    count_axes.margins(y=0.18)

    bars2 = bytes_axes.bar(x, totals, width=0.6, color=colors, edgecolor="white", linewidth=0.4)
    for rect, val in zip(bars2, totals):
        bytes_axes.annotate(f"{int(val):,} B", (rect.get_x() + rect.get_width() / 2, val),
                            textcoords="offset points", xytext=(0, 3), ha="center", fontsize=7)
    bytes_axes.set_xticks(list(x)); bytes_axes.set_xticklabels([MODE_LABEL[m] for m in MODE_ORDER])
    bytes_axes.set_ylabel("total CRDT bytes sent\n(over the churn run)")
    bytes_axes.margins(y=0.18)

    return figure, False


if __name__ == "__main__":
    from _cli import figure_main
    figure_main(build_figure, OUTPUT_NAME)

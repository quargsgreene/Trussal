#!/usr/bin/env python3
"""
Fig 11 — the consistent-hash edge (edge/haproxy.cfg): how evenly rooms spread
across shards, and how few of them move when a shard is added or drained.
1x2, defaults to double column:
  left  — participants per shard as the room count grows (stacked bars, one
          segment per shard). Even segments = even load; Jain's index annotated.
  right — fraction of rooms whose owning shard changes when the shard set goes
          2->3 (add) or 3->2 (drain), replayed over the run's own room set
          (`src/deploy/room-shard.js` / analysis.metrics). Rendezvous moves the
          SAME rooms both ways (the ones s3 would take are the ones it gives
          back), so the two curves coincide. Dashed ref: the ~1/N ideal; dotted
          ref: what a `room % N` map would move (~everything).
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from plotstyle import apply_style, new_figure, CATEGORICAL_COLORS, watermark
from _cli import figure_main
from _data import load_shard_balance, is_synthetic

OUTPUT_NAME = "fig11_shard_balance"


def _rehome_label(key: str) -> str:
    try:
        before, after = (int(p) for p in str(key).split("->"))
        return f"add a shard ({before}→{after})" if after > before else f"drain a shard ({before}→{after})"
    except ValueError:
        return str(key)


def build_figure(run_dir=None, column="double"):
    if column == "single":
        column = "1p5"
    apply_style(column)
    frame = load_shard_balance(run_dir)
    figure, (load_axes, rehome_axes) = new_figure(
        column, width_to_height_ratio=2.3, n_columns=2)

    obs = frame[frame.shard_set == "observed"]

    # ---- left: participants per shard, stacked, vs room count --------------
    part = obs[obs.metric == "participants_on_shard"]
    if part.empty:                       # fall back to room counts if that's all we have
        part = obs[obs.metric == "rooms_on_shard"]
        left_label = "rooms per shard"
    else:
        left_label = "participants per shard"
    levels = sorted(part.level.unique())
    shards = sorted(part.shard.unique())
    x = np.arange(len(levels))
    bottom = np.zeros(len(levels))
    for i, shard in enumerate(shards):
        heights = [float(part[(part.level == lv) & (part.shard == shard)].value.sum())
                   for lv in levels]
        load_axes.bar(x, heights, bottom=bottom, width=0.7,
                      color=CATEGORICAL_COLORS[i % len(CATEGORICAL_COLORS)],
                      edgecolor="white", linewidth=0.4, label=shard)
        bottom += heights

    # Jain's fairness index over the shard loads, averaged across the sweep —
    # 1.0 is a perfectly even split.
    jain_key = "rooms_jain" if left_label.startswith("rooms") else "participants_jain"
    jvals = obs[obs.metric == jain_key].value
    if not jvals.empty:
        load_axes.set_title(f"Jain's index {float(jvals.mean()):.3f}", fontsize=7,
                            loc="left", color="#52514e", pad=2)
    load_axes.set_xticks(x)
    load_axes.set_xticklabels([str(int(lv)) for lv in levels])
    load_axes.set_xlabel("rooms in play")
    load_axes.set_ylabel(left_label)
    load_axes.margins(y=0.18)
    load_axes.legend(loc="upper left", ncol=len(shards))

    # ---- right: re-homed fraction on add / drain --------------------------
    rh = frame[frame.metric == "rehomed_fraction"]
    keys = list(dict.fromkeys(rh.shard_set.tolist()))   # preserve first-seen order
    marker_cycle = ["o", "x", "s", "^"]
    for i, key in enumerate(keys):
        rows = rh[rh.shard_set == key].sort_values("level")
        if not rows.empty:
            rehome_axes.plot(rows.level.to_numpy(dtype=float),
                             rows.value.to_numpy(dtype=float),
                             marker=marker_cycle[i % 4], ms=6,
                             color=CATEGORICAL_COLORS[i % len(CATEGORICAL_COLORS)],
                             label=_rehome_label(key))
    n_shards = obs.shard.replace("", np.nan).dropna().nunique() or 2
    ideal = 1.0 / (n_shards + 1)
    rehome_axes.axhline(ideal, ls="--", lw=0.8, color="#8a8880")
    rehome_axes.annotate(f"rendezvous ideal ~1/{n_shards + 1}",
                         (rehome_axes.get_xlim()[1], ideal),
                         ha="right", va="bottom", fontsize=5.8, color="#52514e")
    rehome_axes.axhline(1.0, ls=":", lw=0.8, color="#c24b3f")
    rehome_axes.annotate("a room % N map moves ~all",
                         (rehome_axes.get_xlim()[1], 1.0),
                         ha="right", va="top", fontsize=5.8, color="#c24b3f")
    rehome_axes.set_ylim(0, 1.08)
    rehome_axes.set_xlabel("rooms in play")
    rehome_axes.set_ylabel("fraction of rooms that move shard")
    rehome_axes.legend(loc="center right")

    if is_synthetic(frame):
        watermark(figure)
    return figure, is_synthetic(frame)


if __name__ == "__main__":
    figure_main(build_figure, OUTPUT_NAME)

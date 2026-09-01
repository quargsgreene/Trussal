#!/usr/bin/env python3
"""
Fig 8 — server-side CPU per component vs room size, at a fixed mid WWAN profile
(p2, LTE median), scenario S1. One line per container (validated categorical
order). Shows which tier saturates first as participants climb.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from plotstyle import apply_style, new_figure, CATEGORICAL_COLORS, watermark
from _cli import figure_main, stats_by
from _data import load_summary, ensure_scenarios, is_synthetic

OUTPUT_NAME = "fig08_server_resources"
FIXED_PROFILE = "p2_lte_typical"
CONTAINERS = [
    ("video/jvb", "JVB (SFU)"),
    ("video/web", "web / nginx"),
    ("video/prosody", "Prosody"),
    ("video/latency", "sidecar"),
    ("bots/conductor", "bots conductor"),
]


def _resolve_entity(canonical: str, present_entities) -> str | None:
    """host_stats labels a container `<vm>/<service>` but the service token can
    be the raw compose name (`video/docker-jitsi-meet-jvb-1`) depending on the
    collector version. Match the canonical `<vm>/<service>` against either form."""
    if canonical in present_entities:
        return canonical
    vm, _, service = canonical.partition("/")
    for entity in present_entities:
        if not isinstance(entity, str) or not entity.startswith(vm + "/"):
            continue
        tail = entity.split("/", 1)[1]
        if tail == service or tail.endswith("-" + service + "-1") or f"-{service}-" in tail:
            return entity
    return None


def build_figure(run_dir=None, column="single"):
    apply_style(column)
    summary = ensure_scenarios(load_summary(run_dir), ["S1"], lambda: load_summary(None),
                               require_metrics="cpu_pct")
    fixed_profile_steady_join = summary[(summary.scenario == "S1")
                                        & (summary.profile == FIXED_PROFILE)]
    if fixed_profile_steady_join.empty:
        fixed_profile_steady_join = summary[summary.scenario == "S1"]
    figure, axes = new_figure(column, width_to_height_ratio=1.5)
    present_entities = set(fixed_profile_steady_join.entity.dropna().unique())

    for container_index, (container_entity, container_label) in enumerate(CONTAINERS):
        resolved_entity = _resolve_entity(container_entity, present_entities)
        if resolved_entity is None:
            continue
        cpu_by_room_size = stats_by(
            fixed_profile_steady_join, "level", "cpu_pct", entity=resolved_entity
        ).sort_values("level")
        if cpu_by_room_size.empty:
            continue
        line_color = CATEGORICAL_COLORS[container_index % len(CATEGORICAL_COLORS)]
        axes.plot(cpu_by_room_size.level, cpu_by_room_size.p50, marker="o",
                  color=line_color, label=container_label, zorder=3)
        if {"p05", "p95"}.issubset(cpu_by_room_size.columns):
            axes.fill_between(cpu_by_room_size.level, cpu_by_room_size.p05,
                              cpu_by_room_size.p95, color=line_color, alpha=0.12, lw=0)

    axes.set_xlabel("participants in room")
    axes.set_ylabel("container CPU, p50 (%)")
    axes.set_xscale("log", base=2)
    axes.set_xticks(sorted(fixed_profile_steady_join.level.unique()))
    axes.get_xaxis().set_major_formatter(lambda tick_value, _pos: f"{int(tick_value)}")
    axes.legend(ncol=2, loc="upper left")
    if is_synthetic(summary):
        watermark(figure)
    return figure, is_synthetic(summary)


if __name__ == "__main__":
    figure_main(build_figure, OUTPUT_NAME)

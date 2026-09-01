#!/usr/bin/env python3
"""
metrics.py results/<run-id>

Consumes tidy/observations.parquet + tidy/phases.parquet and writes the derived
tidy tables the figures read. Everything is keyed by `target` as well as
(profile, scenario, step) so Layout C's two concurrent SUTs stay separated.

  tidy/summary.parquet        long: target, turn_mode, profile, scenario,
                              step_index, level, metric, entity, stat, value
  tidy/timeseries.parquet     long, 5 s bins
  tidy/dropouts.parquet       one row per involuntary departure
  tidy/dropout_rate.parquet   hazard + survival per cell
  tidy/turn_stability.parquet turn-assignment study: successor_disruption,
                              position_disruption, time_to_first_turn_s,
                              jain_fairness, ring_size — per churn event / step,
                              from the `nc_active` + roster-event streams
  tidy/break_points.parquet   the S6 ramp level at which each target broke

Then (re)builds results/<run-id>/campaign.db from all of the above.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import pandas as pd

CELL_KEYS = ["target", "turn_mode", "profile", "scenario"]

SAMPLE_METRICS = [
    "bitrate_in_kbps_total", "bitrate_out_kbps_total", "bitrate_in_kbps", "bitrate_out_kbps",
    "fps_in", "fps_out", "rtt_ms", "rtt_remote_ms", "jitter_ms",
    "packet_loss_frac", "fraction_lost", "jitter_buffer_ms", "freeze_seconds_rate",
    "bwe_out_kbps", "bwe_in_kbps",
    "peer_rtt", "peer_jitter", "peer_packetLoss", "peer_rtcRtt", "peer_rtcJitter",
    "peer_jitterBufferMs", "peer_pipelineMs",
    "roster_size", "roster_human", "roster_bot", "nc_turn_gap_s", "nc_active_gap_s",
    "crdt_update_bytes", "cpu_pct", "mem_mb", "mem_pct", "net_tx_mbps", "net_rx_mbps",
    "load1", "load5", "tcp_estab", "tcp_sockets", "bot_containers",
    "conductor_bots_total", "room_bots", "room_participants",
]
JVB_PREFIX = "jvb_"


# --------------------------------------------------------------------------- #
def assign_phase(observations: pd.DataFrame, phases: pd.DataFrame) -> pd.DataFrame:
    observations = observations.copy()
    observations["step_index"] = -1
    observations["level"] = np.nan
    for _, phase in phases.iterrows():
        in_phase = (observations["t"] >= phase.t_start) & (observations["t"] < phase.t_end)
        for column in ("target", "profile", "scenario"):
            if column in phase.index:
                in_phase &= observations[column] == phase[column]
        observations.loc[in_phase, "step_index"] = int(phase.step_index)
        observations.loc[in_phase, "level"] = phase.level
    return observations


def summarise(observations: pd.DataFrame) -> pd.DataFrame:
    samples = observations[observations.kind == "sample"].copy()
    samples = samples[samples.metric.isin(SAMPLE_METRICS)
                      | samples.metric.str.startswith(JVB_PREFIX)]
    samples = samples[samples.step_index >= 0]
    samples["value"] = pd.to_numeric(samples["value"], errors="coerce")
    samples = samples.dropna(subset=["value"])
    # keep `entity` only for server-side metrics (per-container CPU, per-iface
    # bandwidth); client media-plane metrics aggregate across all participants.
    is_server = samples.collector.isin(["host_stats", "jvb_stats"])
    samples["entity_key"] = samples["entity"].where(is_server, "")
    grouped = samples.groupby(
        CELL_KEYS + ["step_index", "level", "metric", "entity_key"])["value"]
    wide = grouped.agg(
        p50="median",
        p95=lambda s: np.nanpercentile(s, 95),
        p05=lambda s: np.nanpercentile(s, 5),
        mean="mean", count="count",
    ).reset_index().rename(columns={"entity_key": "entity"})
    return wide.melt(
        id_vars=CELL_KEYS + ["step_index", "level", "metric", "entity"],
        var_name="stat", value_name="value")


def timeseries(observations: pd.DataFrame, bin_seconds: float = 5.0) -> pd.DataFrame:
    samples = observations[(observations.kind == "sample")
                           & (observations.metric.isin(SAMPLE_METRICS)
                              | observations.metric.str.startswith(JVB_PREFIX))].copy()
    samples["value"] = pd.to_numeric(samples["value"], errors="coerce")
    samples = samples.dropna(subset=["value"])
    samples["t_bin"] = (samples["t_rel"] // bin_seconds) * bin_seconds
    grouped = (samples.groupby(CELL_KEYS + ["metric", "t_bin"])["value"]
               .agg(p50="median", p95=lambda s: np.nanpercentile(s, 95), mean="mean")
               .reset_index().rename(columns={"t_bin": "t_rel"}))
    return grouped.melt(id_vars=CELL_KEYS + ["metric", "t_rel"],
                        var_name="stat", value_name="value")


def dropouts(observations: pd.DataFrame) -> pd.DataFrame:
    events = observations[observations.kind == "event"].copy()
    records = []
    explicit = events[events.metric.isin(["dropout", "disconnected", "agent_crash"])]
    for _, row in explicit.iterrows():
        involuntary = row.get("involuntary")
        if involuntary is None:
            involuntary = row.metric in ("dropout", "agent_crash")
        if not involuntary:
            continue
        records.append({**{k: row.get(k) for k in CELL_KEYS}, "level": row.level,
                        "t_rel": row.t_rel, "entity": row.entity,
                        "source": row.collector, "reason": row.get("reason")})
    # observer peer_leave of a bot with no operator 'remove' just before it
    bot_leaves = events[(events.collector == "sidecar_observer")
                        & (events.metric == "peer_leave")
                        & (events.get("peer_kind") == "bot")]
    removes = events[(events.collector == "operator")
                     & events.metric.isin(["cluster_reset", "spawn_request"])]
    for _, row in bot_leaves.iterrows():
        near = removes[(removes.target == row.target) & (removes.scenario == row.scenario)
                       & removes.t_rel.between(row.t_rel - 8, row.t_rel + 2)]
        if near.empty:
            records.append({**{k: row.get(k) for k in CELL_KEYS}, "level": row.level,
                            "t_rel": row.t_rel, "entity": row.entity,
                            "source": "observer/bot", "reason": "bot vanished, no remove"})
    return pd.DataFrame(records)


def dropout_rate(observations: pd.DataFrame, drops: pd.DataFrame) -> pd.DataFrame:
    roster = observations[(observations.collector == "sidecar_observer")
                          & (observations.metric == "roster_size")
                          & (observations.step_index >= 0)].copy()
    roster["value"] = pd.to_numeric(roster["value"], errors="coerce")
    rows = []
    for keys, group in roster.groupby(CELL_KEYS + ["step_index", "level"]):
        group = group.sort_values("t")
        if len(group) < 2:
            participant_seconds = float(group["value"].mean() or 0)
        else:
            interval = np.diff(group["t"].values)
            participant_seconds = float(np.sum(group["value"].values[:-1] * interval))
        key_map = dict(zip(CELL_KEYS + ["step_index", "level"], keys))
        matching_drops = drops
        for column in CELL_KEYS + ["level"]:
            if column in drops.columns:
                matching_drops = matching_drops[matching_drops[column] == key_map[column]]
        involuntary_count = len(matching_drops)
        peak_roster = float(group["value"].max() or 1)
        final_roster = float(group["value"].iloc[-1] or 0)
        rows.append({
            **key_map,
            "involuntary": involuntary_count,
            "participant_seconds": participant_seconds,
            "hazard_per_part_min": (involuntary_count / participant_seconds * 60.0)
            if participant_seconds > 0 else np.nan,
            "survival_frac": final_roster / peak_roster if peak_roster > 0 else np.nan,
        })
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
# Turn-assignment study (mirrors src/audio-net/TurnRing.js definitions)
# --------------------------------------------------------------------------- #
def _lap_order(tokens_in_time_order: list[str]) -> list[str]:
    """The distinct-token cycle from a run of nc-active tokens (one lap)."""
    order = []
    for token in tokens_in_time_order:
        if token in order:
            break
        order.append(token)
    return order


def _successor_disruption(order_before: list[str], order_after: list[str]) -> float:
    before_set, after_set = set(order_before), set(order_after)
    survivors = [t for t in order_before if t in after_set]
    if len(survivors) < 2:
        return 0.0

    def successor_in(order):
        common = [t for t in order if t in before_set and t in after_set]
        return {t: common[(i + 1) % len(common)] for i, t in enumerate(common)}

    succ_before, succ_after = successor_in(order_before), successor_in(order_after)
    changed = sum(1 for t in survivors if succ_before.get(t) != succ_after.get(t))
    return changed / len(survivors)


def _position_disruption(order_before: list[str], order_after: list[str]) -> float:
    after_index = {t: i for i, t in enumerate(order_after)}
    before_index = {t: i for i, t in enumerate(order_before)}
    survivors = [t for t in order_before if t in after_index]
    if not survivors:
        return 0.0
    moved = sum(1 for t in survivors if before_index[t] != after_index[t])
    return moved / len(survivors)


def _jain(counts: list[float]) -> float:
    counts = [c for c in counts if c >= 0]
    if not counts:
        return 1.0
    total, total_sq = sum(counts), sum(c * c for c in counts)
    return (total * total) / (len(counts) * total_sq) if total_sq > 0 else 1.0


def turn_stability(observations: pd.DataFrame, window_s: float = 30.0) -> pd.DataFrame:
    nc = observations[(observations.collector == "sidecar_observer")
                      & (observations.metric == "nc_active")
                      & (observations.step_index >= 0)].copy()
    roster = observations[(observations.collector == "sidecar_observer")
                          & (observations.metric.isin(["peer_join", "peer_leave"]))].copy()
    if nc.empty:
        return pd.DataFrame()
    nc["token"] = nc["entity"].astype(str)
    nc = nc.sort_values("t")

    rows = []
    for keys, nc_cell in nc.groupby(CELL_KEYS + ["step_index", "level"]):
        key_map = dict(zip(CELL_KEYS + ["step_index", "level"], keys))
        nc_cell = nc_cell.sort_values("t")
        nc_times = nc_cell["t"].values
        nc_tokens = nc_cell["token"].tolist()

        def order_between(t_low, t_high):
            mask = (nc_times >= t_low) & (nc_times < t_high)
            return _lap_order([tok for tok, keep in zip(nc_tokens, mask) if keep])

        # churn events inside this cell's time span
        span_low, span_high = nc_times.min() - window_s, nc_times.max() + window_s
        churn = roster
        for column in CELL_KEYS:
            if column in roster.columns:
                churn = churn[churn[column] == key_map[column]]
        churn = churn[(churn.t >= span_low) & (churn.t <= span_high)].sort_values("t")

        succ_vals, pos_vals = [], []
        for _, event in churn.iterrows():
            before = order_between(event.t - window_s, event.t)
            after = order_between(event.t, event.t + window_s)
            if len(before) >= 2 and len(after) >= 2:
                succ_vals.append(_successor_disruption(before, after))
                pos_vals.append(_position_disruption(before, after))

        # time-to-first-turn for joiners in this cell
        joins = churn[churn.metric == "peer_join"]
        first_turn_delays = []
        for _, join_event in joins.iterrows():
            token = str(join_event.entity)
            later = nc_cell[(nc_cell.t > join_event.t) & (nc_cell.token == token)]
            if not later.empty:
                first_turn_delays.append(float(later["t"].iloc[0] - join_event.t))

        # fairness + ring size over the cell
        token_counts = nc_cell["token"].value_counts().to_dict()
        lap_sizes = []
        for start in range(0, len(nc_tokens), 1):
            lap = _lap_order(nc_tokens[start:])
            if lap:
                lap_sizes.append(len(lap))

        def emit(metric, values):
            if not values:
                return
            arr = np.asarray(values, dtype=float)
            for stat, value in [("p50", np.median(arr)),
                                ("p95", np.nanpercentile(arr, 95)),
                                ("mean", np.mean(arr)), ("count", len(arr))]:
                rows.append({**key_map, "metric": metric, "stat": stat, "value": value})

        emit("successor_disruption", succ_vals)
        emit("position_disruption", pos_vals)
        emit("time_to_first_turn_s", first_turn_delays)
        emit("ring_size", lap_sizes)
        rows.append({**key_map, "metric": "jain_fairness", "stat": "value",
                     "value": _jain(list(token_counts.values()))})
        rows.append({**key_map, "metric": "churn_events", "stat": "value",
                     "value": float(len(churn))})
    return pd.DataFrame(rows)


def break_points(observations: pd.DataFrame) -> pd.DataFrame:
    events = observations[(observations.collector == "campaign")].copy()
    breaks = events[events.metric == "break_level"]
    rows = []
    for _, row in breaks.iterrows():
        rows.append({**{k: row.get(k) for k in CELL_KEYS},
                     "break_level": row.value, "condition": row.get("condition"),
                     "metric_value": row.get("metric_value")})
    # cells that ran a ramp but never broke: record the max level reached
    ramp_ends = events[(events.metric == "campaign_end")
                       & (events.get("reason") == "ramp exhausted")]
    for _, row in ramp_ends.iterrows():
        key_map = {k: row.get(k) for k in CELL_KEYS}
        if any(all(r[k] == key_map[k] for k in CELL_KEYS) for r in rows):
            continue
        levels = observations[(observations.metric == "phase")
                              & (observations.target == row.target)
                              & (observations.scenario == row.scenario)
                              & (observations.profile == row.profile)]["value"]
        rows.append({**key_map, "break_level": float(levels.max()) if not levels.empty else np.nan,
                     "condition": "none", "metric_value": np.nan})
    return pd.DataFrame(rows)


# --------------------------------------------------------------------------- #
def main(argv=None):
    argv = argv or sys.argv[1:]
    if not argv:
        print(__doc__)
        return 2
    run = Path(argv[0])
    tidy = run / "tidy"
    observations = pd.read_parquet(tidy / "observations.parquet")
    phases = pd.read_parquet(tidy / "phases.parquet")
    observations = assign_phase(observations, phases)

    outputs = {
        "summary.parquet": summarise(observations),
        "timeseries.parquet": timeseries(observations),
    }
    drops = dropouts(observations)
    outputs["dropouts.parquet"] = drops
    outputs["dropout_rate.parquet"] = dropout_rate(observations, drops)
    outputs["turn_stability.parquet"] = turn_stability(observations)
    outputs["break_points.parquet"] = break_points(observations)

    for filename, frame in outputs.items():
        frame.to_parquet(tidy / filename, index=False)
        print(f"{filename:<24} {len(frame):>7,} rows")

    try:
        from db import build_campaign_db
    except ImportError:
        from analysis.db import build_campaign_db
    db_path = build_campaign_db(run)
    print(f"{'campaign.db':<24} {db_path.stat().st_size // 1024:>7} KiB")
    return 0


if __name__ == "__main__":
    sys.exit(main())

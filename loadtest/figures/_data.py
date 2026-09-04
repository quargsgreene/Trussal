"""
Data access for the figure scripts. Reads results/<run>/tidy/*.parquet when a
run is given and present; otherwise SYNTHESISES a physically-plausible dataset
so the figures render (and their styling can be tuned) before any campaign has
finished. Synthetic mode is deterministic and clearly flagged (`SYNTHETIC=True`
on every returned frame's `.attrs`).
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd

PROFILE_IDS = ["p0_lan", "p1_lte_good", "p2_lte_typical", "p3_lte_busy", "p4_hspa", "p5_edge"]
PROFILE_LABELS = {
    "p0_lan": "LAN", "p1_lte_good": "LTE strong", "p2_lte_typical": "LTE median",
    "p3_lte_busy": "LTE congested", "p4_hspa": "3G / HSPA", "p5_edge": "2.5G / fade",
}

# Per profile: (one_way_delay_ms, packet_loss_fraction, uplink_capacity_kbit)
PROFILE_LINK_PARAMS = {
    "p0_lan":         (1,   0.0000, 10_000_000),
    "p1_lte_good":    (20,  0.0010, 8_000),
    "p2_lte_typical": (40,  0.0050, 4_000),
    "p3_lte_busy":    (65,  0.0150, 2_000),
    "p4_hspa":        (110, 0.0300, 1_000),
    "p5_edge":        (200, 0.0600, 400),
}

# Per scenario: the "level" of each load step (see config/scenarios.yaml).
SCENARIO_STEP_LEVELS = {
    "S1": [4, 8, 16, 32, 64, 120],     # participants in room
    "S2": [4, 12, 24, 48, 96],         # bots spawned
    "S3": [2, 4, 8, 16, 24, 32],       # tokens in `$ participants`
    "S4": [200, 1000, 4000, 12000, 32000],  # code bytes per update
}

# Back-compat aliases (older figure code imported these names).
PROFILES = PROFILE_IDS
SCEN_STEPS = SCENARIO_STEP_LEVELS


def _tidy_dir_if_present(run_dir) -> Path | None:
    if not run_dir:
        return None
    tidy_dir = Path(run_dir) / "tidy"
    return tidy_dir if (tidy_dir / "summary.parquet").exists() else None


# --------------------------------------------------------------------------- #
def load_summary(run_dir=None) -> pd.DataFrame:
    tidy_dir = _tidy_dir_if_present(run_dir)
    if tidy_dir:
        summary = pd.read_parquet(tidy_dir / "summary.parquet")
        summary.attrs["SYNTHETIC"] = False
        return summary
    return _synthetic_summary()


def load_timeseries(run_dir=None) -> pd.DataFrame:
    tidy_dir = _tidy_dir_if_present(run_dir)
    if tidy_dir and (tidy_dir / "timeseries.parquet").exists():
        timeseries = pd.read_parquet(tidy_dir / "timeseries.parquet")
        timeseries.attrs["SYNTHETIC"] = False
        return timeseries
    return _synthetic_timeseries()


def load_dropout_rate(run_dir=None) -> pd.DataFrame:
    tidy_dir = _tidy_dir_if_present(run_dir)
    if tidy_dir and (tidy_dir / "dropout_rate.parquet").exists():
        dropout_rate = pd.read_parquet(tidy_dir / "dropout_rate.parquet")
        # fig05 groups by the S1-S4 load scenarios; a run with only smoke/S0
        # cells has nothing to say there, so fall back like turn_stability does.
        # A short capacity slice can also record *zero* involuntary dropout in
        # every cell -> a bar chart of nothing; treat that as no signal too.
        manuscript_scenarios = {"S1", "S2", "S3", "S4"}
        has_scenario = (not dropout_rate.empty
                        and dropout_rate["scenario"].isin(manuscript_scenarios).any())
        has_signal = (not dropout_rate.empty
                      and float(dropout_rate["hazard_per_part_min"].fillna(0).abs().sum()) > 0.0)
        if has_scenario and has_signal:
            dropout_rate.attrs["SYNTHETIC"] = False
            return dropout_rate
    return _synthetic_dropout_rate()


def load_observations(run_dir=None) -> pd.DataFrame:
    tidy_dir = _tidy_dir_if_present(run_dir)
    if tidy_dir and (tidy_dir / "observations.parquet").exists():
        observations = pd.read_parquet(tidy_dir / "observations.parquet")
        observations.attrs["SYNTHETIC"] = False
        return observations
    return _synthetic_observations()


def load_turn_stability(run_dir=None) -> pd.DataFrame:
    tidy_dir = _tidy_dir_if_present(run_dir)
    path = tidy_dir / "turn_stability.parquet" if tidy_dir else None
    if path and path.exists():
        frame = pd.read_parquet(path)
        if not frame.empty:
            frame.attrs["SYNTHETIC"] = False
            return frame
    return _synthetic_turn_stability()   # no S5 cells in this run


def load_break_points(run_dir=None) -> pd.DataFrame:
    tidy_dir = _tidy_dir_if_present(run_dir)
    path = tidy_dir / "break_points.parquet" if tidy_dir else None
    if path and path.exists():
        frame = pd.read_parquet(path)
        if not frame.empty:
            frame.attrs["SYNTHETIC"] = False
            return frame
    return _synthetic_break_points()     # no S6 cells in this run


def load_shard_balance(run_dir=None) -> pd.DataFrame:
    tidy_dir = _tidy_dir_if_present(run_dir)
    path = tidy_dir / "shard_balance.parquet" if tidy_dir else None
    if path and path.exists():
        frame = pd.read_parquet(path)
        if not frame.empty:
            frame.attrs["SYNTHETIC"] = False
            return frame
    return _synthetic_shard_balance()    # no sharded run ingested yet


# S5 churn-rate steps (events / minute) and the turn-study profile subset
CHURN_RATE_STEPS = [2, 6, 12, 24, 48]
TURN_STUDY_PROFILES = ["p2_lte_typical", "p3_lte_busy", "p4_hspa"]
TURN_MODES = ["explicit", "hash"]


def _synthetic_turn_stability() -> pd.DataFrame:
    records: list[dict] = []
    for profile_id in TURN_STUDY_PROFILES:
        one_way_delay_ms, loss_fraction, _cap = PROFILE_LINK_PARAMS[profile_id]
        # CRDT propagation window scales with delay + loss; hashing is immune to it
        crdt_window_penalty = 0.6 + one_way_delay_ms / 120 + loss_fraction * 8
        for step_index, churn_rate in enumerate(CHURN_RATE_STEPS):
            churn_load = churn_rate / max(CHURN_RATE_STEPS)
            for turn_mode in TURN_MODES:
                rng = _seeded_rng(profile_id, churn_rate, turn_mode)
                if turn_mode == "hash":
                    successor = 0.02 + 0.04 * churn_load + rng.normal(0, 0.01)
                    first_turn = 0.5 * (28 / 2) * (1 + 0.1 * churn_load)   # ~half a lap
                    fairness = 0.965 - 0.02 * churn_load
                    ring = 28 - 1.5 * churn_load
                else:
                    successor = 0.08 + 0.62 * churn_load * crdt_window_penalty / 2 + rng.normal(0, 0.03)
                    first_turn = (28 / 2) * (1 + 1.4 * churn_load) * crdt_window_penalty
                    fairness = 0.92 - 0.17 * churn_load
                    ring = 28 - 5 * churn_load
                position = 0.42 + 0.08 * churn_load + (0.0 if turn_mode == "hash" else 0.05)
                for metric_name, median_value in [
                    ("successor_disruption", max(0.0, successor)),
                    ("position_disruption", position),
                    ("time_to_first_turn_s", first_turn),
                    ("ring_size", ring),
                ]:
                    spread = abs(median_value) * 0.25
                    for stat_name, stat_value in [("p50", median_value),
                                                  ("p95", median_value + 1.5 * spread),
                                                  ("mean", median_value * 1.03),
                                                  ("count", 40)]:
                        records.append(dict(
                            target=f"sut_{turn_mode}", turn_mode=turn_mode,
                            profile=profile_id, scenario="S5",
                            step_index=step_index, level=churn_rate,
                            metric=metric_name, stat=stat_name, value=stat_value))
                records.append(dict(
                    target=f"sut_{turn_mode}", turn_mode=turn_mode, profile=profile_id,
                    scenario="S5", step_index=step_index, level=churn_rate,
                    metric="jain_fairness", stat="value", value=float(np.clip(fairness, 0, 1))))
    frame = pd.DataFrame(records)
    frame.attrs["SYNTHETIC"] = True
    return frame


# Rendezvous (HRW) room->shard, mirroring src/deploy/room-shard.js (authoritative)
# and analysis.metrics._shard_for_room. Equal weights.
def _fnv1a32(s: str) -> int:
    h = 0x811C9DC5
    for ch in s.encode("utf-8", "surrogatepass"):
        h = ((h ^ ch) * 0x01000193) & 0xFFFFFFFF
    return h


def _shard_for_room(room: str, shards: list[str]) -> str:
    best, best_score = None, float("-inf")
    for name in sorted(set(shards)):
        u = (_fnv1a32(f"{room} {name}") + 0.5) / 4294967296.0
        score = -1.0 / np.log(u)
        if score > best_score:
            best, best_score = name, score
    return best


# room counts a sharded-rack run sweeps (rooms, not participants)
SHARD_ROOM_STEPS = [4, 8, 16, 32, 64, 128]


def _synthetic_shard_balance() -> pd.DataFrame:
    records: list[dict] = []
    shards = ["s1", "s2"]
    for step_index, room_count in enumerate(SHARD_ROOM_STEPS):
        rooms = [f"loadtest-{i:04d}" for i in range(room_count)]
        placement = {r: _shard_for_room(r, shards) for r in rooms}
        rooms_on = {s: sum(1 for v in placement.values() if v == s) for s in shards}
        rng = _seeded_rng("shardbal", room_count)
        # ~8 participants/room, jittered, routed by the real hash
        part_on = {s: 0 for s in shards}
        for r, s in placement.items():
            part_on[s] += max(1, int(rng.normal(8, 2)))
        for s in shards:
            records.append(dict(target="rack", turn_mode="hash", profile="p0_lan",
                                scenario="SHARD", step_index=step_index, level=room_count,
                                shard_set="observed", shard=s,
                                metric="rooms_on_shard", value=float(rooms_on[s])))
            records.append(dict(target="rack", turn_mode="hash", profile="p0_lan",
                                scenario="SHARD", step_index=step_index, level=room_count,
                                shard_set="observed", shard=s,
                                metric="participants_on_shard", value=float(part_on[s])))
        jain = (sum(rooms_on.values()) ** 2) / (len(shards) * sum(v * v for v in rooms_on.values()))
        records.append(dict(target="rack", turn_mode="hash", profile="p0_lan",
                            scenario="SHARD", step_index=step_index, level=room_count,
                            shard_set="observed", shard="",
                            metric="rooms_jain", value=float(jain)))
        # modelled rebalance over the same room set — add a shard, and lose one
        # (what metrics.shard_balance emits for a real 2-shard run)
        for label, after in [("2->3", ["s1", "s2", "s3"]), ("2->1", ["s1"])]:
            moved = sum(1 for r in rooms
                        if _shard_for_room(r, shards) != _shard_for_room(r, after))
            records.append(dict(target="rack", turn_mode="hash", profile="p0_lan",
                                scenario="SHARD", step_index=step_index, level=room_count,
                                shard_set=label, shard="",
                                metric="rehomed_fraction", value=moved / len(rooms)))
    frame = pd.DataFrame(records)
    frame.attrs["SYNTHETIC"] = True
    return frame


def _synthetic_break_points() -> pd.DataFrame:
    records: list[dict] = []
    base_break = {"p2_lte_typical": 120, "p3_lte_busy": 88, "p4_hspa": 56}
    for profile_id in TURN_STUDY_PROFILES:
        for turn_mode in TURN_MODES:
            # hashing sustains ~1.5-1.8x more participants before turn scheduling
            # falls apart, since it needs no per-join CRDT round-trip
            multiplier = 1.0 if turn_mode == "explicit" else _seeded_rng(profile_id, "brk").uniform(1.5, 1.8)
            condition = "nc_gap_multiple_of_ideal" if turn_mode == "explicit" else "aggregator_cpu_pct"
            records.append(dict(
                target=f"sut_{turn_mode}", turn_mode=turn_mode, profile=profile_id,
                scenario="S6", break_level=round(base_break[profile_id] * multiplier),
                condition=condition, metric_value=3.4 if turn_mode == "explicit" else 91.0))
    frame = pd.DataFrame(records)
    frame.attrs["SYNTHETIC"] = True
    return frame


def is_synthetic(*frames) -> bool:
    return any(frame.attrs.get("SYNTHETIC") for frame in frames)


def ensure_scenarios(frame: pd.DataFrame, scenarios, synthetic_loader,
                     require_metrics=None) -> pd.DataFrame:
    """Guard a figure against a real-but-non-matching frame.

    A run that only exercised a smoke / S0 cell still writes a non-empty
    summary.parquet, so `is_synthetic` is False and the figure would render
    empty (unwatermarked) axes. If the real frame carries no row in the
    scenarios the figure actually plots, swap in the synthetic reference so the
    panel renders watermarked instead of blank.

    `require_metrics` extends the same guard to the metric axis: an app-plane
    run produces real S1 rows (roster / peer_* / cpu_pct) but none of the
    media-plane series a figure like fig01/02/03 plots. Pass the metric name(s)
    that figure needs and it falls back to the watermarked synthetic reference
    instead of rendering a blank, unwatermarked panel.
    """
    if frame.attrs.get("SYNTHETIC"):
        return frame
    wanted = set(scenarios)
    has_scenario = "scenario" in frame.columns and frame["scenario"].isin(wanted).any()
    has_metric = True
    if require_metrics is not None:
        want_metrics = ({require_metrics} if isinstance(require_metrics, str)
                        else set(require_metrics))
        has_metric = "metric" in frame.columns and frame["metric"].isin(want_metrics).any()
    if has_scenario and has_metric:
        return frame
    return synthetic_loader()


# back-compat alias
is_synth = is_synthetic


# --------------------------------------------------------------------------- #
# Synthetic data — deterministic, physically plausible. Only used until a real
# campaign has been ingested; every frame is flagged SYNTHETIC.
# --------------------------------------------------------------------------- #
def _seeded_rng(*seed_parts) -> np.random.Generator:
    return np.random.default_rng(abs(hash(seed_parts)) % (2**32))


def _queue_utilisation(step_level: int, uplink_capacity_kbit: float) -> float:
    """M/M/1-style load factor rho: offered load / link capacity, capped < 1."""
    offered_kbit_per_client = 350 + 220 * np.log1p(step_level)
    return min(0.99, offered_kbit_per_client * step_level / (uplink_capacity_kbit + 1))


def _synthetic_summary() -> pd.DataFrame:
    records: list[dict] = []
    for scenario, step_levels in SCENARIO_STEP_LEVELS.items():
        for step_index, step_level in enumerate(step_levels):
            normalised_load = step_level / max(step_levels)
            for profile_id in PROFILE_IDS:
                one_way_delay_ms, loss_fraction, uplink_capacity_kbit = PROFILE_LINK_PARAMS[profile_id]
                rng = _seeded_rng(scenario, profile_id, step_level)
                queue_utilisation = _queue_utilisation(step_level, uplink_capacity_kbit)

                demand_out_kbit = 350 + 220 * np.log1p(step_level)
                bitrate_out_kbit = min(demand_out_kbit,
                                       uplink_capacity_kbit * (0.6 + 0.3 * (1 - normalised_load)))
                bitrate_out_kbit *= 1 - 0.15 * normalised_load
                bitrate_in_kbit = bitrate_out_kbit * (1.8 - 0.5 * normalised_load) * (1 - loss_fraction * 3)

                frame_rate_fps = 15 * np.exp(-one_way_delay_ms / 400) \
                    * (1 - 0.45 * normalised_load) * (1 - loss_fraction * 4)
                frame_rate_fps = max(1.5, frame_rate_fps)

                round_trip_ms = 2 * one_way_delay_ms + 12 \
                    + 40 * queue_utilisation / (1 - queue_utilisation + 0.02)
                jitter_ms = 4 + one_way_delay_ms * 0.25 + 30 * queue_utilisation + rng.normal(0, 2)
                observed_loss_fraction = min(
                    0.6, loss_fraction + 0.02 * normalised_load + 0.08 * max(0, queue_utilisation - 0.8))
                jitter_buffer_ms = 40 + jitter_ms * 2.5
                web_cpu_percent = 8 + 2.2 * step_level ** 0.85 * (1 + 0.3 * (scenario == "S2"))

                client_metrics = [
                    ("bitrate_out_kbps_total", bitrate_out_kbit),
                    ("bitrate_in_kbps_total", bitrate_in_kbit),
                    ("fps_in", frame_rate_fps),
                    ("fps_out", min(15, frame_rate_fps * 1.05)),
                    ("rtt_ms", round_trip_ms),
                    ("jitter_ms", max(1, jitter_ms)),
                    ("packet_loss_frac", observed_loss_fraction),
                    ("jitter_buffer_ms", jitter_buffer_ms),
                    ("peer_rtcJitter", max(1, jitter_ms * 0.9)),
                    ("peer_packetLoss", observed_loss_fraction),
                    ("nc_turn_gap_s",
                     4.0 + (0.15 * step_level if scenario == "S3" else 0) + queue_utilisation * 3),
                ]
                for metric_name, median_value in client_metrics:
                    spread = abs(median_value) * (0.12 + 0.5 * queue_utilisation)
                    for stat_name, stat_value in [
                        ("p50", median_value),
                        ("p95", median_value + 1.6 * spread),
                        ("p05", max(0, median_value - 1.2 * spread)),
                        ("mean", median_value * 1.02),
                        ("count", 120),
                    ]:
                        records.append(dict(
                            profile=profile_id, scenario=scenario, step_index=step_index,
                            level=step_level, metric=metric_name, entity="",
                            stat=stat_name, value=stat_value))

                container_cpu_percent = {
                    "video/web": web_cpu_percent,
                    "video/jvb": 6 + 3.0 * step_level ** 0.9 * (1 + 0.2 * loss_fraction * 10),
                    "video/prosody": 3 + 0.8 * step_level ** 0.7,
                    "video/latency": 2 + 0.5 * step_level ** 0.8 * (2.5 if scenario == "S4" else 1),
                    "bots/conductor": 4 + (0.7 * step_level if scenario == "S2" else 1.5),
                }
                for container_name, cpu_percent in container_cpu_percent.items():
                    for stat_name, stat_value in [
                        ("p50", cpu_percent), ("p95", cpu_percent * 1.4),
                        ("p05", cpu_percent * 0.7), ("mean", cpu_percent * 1.05), ("count", 60),
                    ]:
                        records.append(dict(
                            profile=profile_id, scenario=scenario, step_index=step_index,
                            level=step_level, metric="cpu_pct", entity=container_name,
                            stat=stat_name, value=stat_value))

    summary = pd.DataFrame(records)
    summary.attrs["SYNTHETIC"] = True
    return summary


def _synthetic_timeseries() -> pd.DataFrame:
    records: list[dict] = []
    step_hold_seconds = 300
    for scenario in ["S1", "S2"]:
        step_levels = SCENARIO_STEP_LEVELS[scenario]
        for profile_id in PROFILE_IDS:
            one_way_delay_ms, loss_fraction, uplink_capacity_kbit = PROFILE_LINK_PARAMS[profile_id]
            for step_index, step_level in enumerate(step_levels):
                step_start_seconds = step_index * step_hold_seconds
                rng = _seeded_rng(scenario, profile_id, step_level, "ts")
                for elapsed_in_step in range(0, step_hold_seconds, 5):
                    normalised_load = step_level / max(step_levels)
                    settle_fraction = 1 - np.exp(-elapsed_in_step / 40)
                    frame_rate_fps = max(1.5, 15 * np.exp(-one_way_delay_ms / 400)
                                         * (1 - 0.45 * normalised_load)
                                         * (0.7 + 0.3 * settle_fraction))
                    round_trip_ms = 2 * one_way_delay_ms + 15 + 60 * normalised_load + rng.normal(0, 3)
                    bitrate_in_kbit = (min(uplink_capacity_kbit, 400 + 260 * np.log1p(step_level))
                                       * (0.6 + 0.4 * settle_fraction))
                    for metric_name, metric_value in [
                        ("fps_in", frame_rate_fps + rng.normal(0, 0.4)),
                        ("rtt_ms", round_trip_ms),
                        ("bitrate_in_kbps_total", bitrate_in_kbit),
                    ]:
                        records.append(dict(
                            profile=profile_id, scenario=scenario, metric=metric_name,
                            t_rel=step_start_seconds + elapsed_in_step, stat="p50",
                            value=metric_value))
    timeseries = pd.DataFrame(records)
    timeseries.attrs["SYNTHETIC"] = True
    return timeseries


def _synthetic_dropout_rate() -> pd.DataFrame:
    records: list[dict] = []
    for scenario, step_levels in SCENARIO_STEP_LEVELS.items():
        for step_index, step_level in enumerate(step_levels):
            normalised_load = step_level / max(step_levels)
            for profile_id in PROFILE_IDS:
                one_way_delay_ms, loss_fraction, uplink_capacity_kbit = PROFILE_LINK_PARAMS[profile_id]
                queue_utilisation = _queue_utilisation(step_level, uplink_capacity_kbit)
                hazard_per_participant_minute = (
                    loss_fraction * 8
                    + 0.4 * max(0, queue_utilisation - 0.75) ** 2 * 30
                ) * (1 + 1.5 * normalised_load)
                survival_fraction = float(np.clip(1 - hazard_per_participant_minute / 12, 0.15, 1.0))
                records.append(dict(
                    profile=profile_id, scenario=scenario, step_index=step_index, level=step_level,
                    involuntary=int(round(hazard_per_participant_minute * 1.5)),
                    participant_seconds=step_level * 300.0,
                    hazard_per_part_min=hazard_per_participant_minute / 10.0,
                    survival_frac=survival_fraction))
    dropout_rate = pd.DataFrame(records)
    dropout_rate.attrs["SYNTHETIC"] = True
    return dropout_rate


def _synthetic_observations() -> pd.DataFrame:
    """Only what fig03 (the ECDF) needs: per-sample rtt_ms / jitter_ms / loss."""
    records: list[dict] = []
    scenario = "S1"
    step_level = 64
    samples_per_profile = 4000
    for profile_id in PROFILE_IDS:
        one_way_delay_ms, loss_fraction, uplink_capacity_kbit = PROFILE_LINK_PARAMS[profile_id]
        rng = _seeded_rng(profile_id, "cdf")
        round_trip_samples = np.abs(
            rng.lognormal(np.log(2 * one_way_delay_ms + 25), 0.4, samples_per_profile))
        jitter_samples = np.abs(
            rng.lognormal(np.log(5 + one_way_delay_ms * 0.25), 0.5, samples_per_profile))
        loss_samples = np.clip(
            rng.normal(loss_fraction, loss_fraction * 0.6 + 0.005, samples_per_profile), 0, 0.8)
        for sample_array, metric_name in [
            (round_trip_samples, "rtt_ms"),
            (jitter_samples, "jitter_ms"),
            (loss_samples, "packet_loss_frac"),
        ]:
            for sample_value in sample_array:
                records.append(dict(
                    profile=profile_id, scenario=scenario, level=step_level, metric=metric_name,
                    kind="sample", collector="media_agent", value=float(sample_value),
                    step_index=3))
    observations = pd.DataFrame(records)
    observations.attrs["SYNTHETIC"] = True
    return observations

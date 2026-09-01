#!/usr/bin/env python3
"""
ingest.py results/<run-id>

Reads every raw/*.jsonl (all collectors + locust users) and the locust
*_stats_history.csv, and writes tidy Parquet:

  tidy/observations.parquet   one row per observation:
      t, t_rel, run, profile, scenario, step, collector, node, entity,
      kind, metric, value, involuntary, media, peer_kind, extra(json)
  tidy/phases.parquet         from the `campaign` collector's phase events:
      profile, scenario, step_index, level, t_start, t_end
  tidy/locust.parquet         locust's own per-second aggregate history

Downstream (metrics.py, figures) read only these.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pandas as pd

PASSTHROUGH = ("involuntary", "media", "reason", "token", "index", "action",
               "spawned", "removed", "fleetSize", "ceiling", "snapshot",
               "modality", "channel", "tokens", "update_bytes", "bytes",
               "session_s", "ok", "rc", "running", "kind",
               "gap_s", "peer_kind", "nc_kind", "condition", "metric_value", "held_s")


def _read_jsonl(path: Path) -> list[dict]:
    rows = []
    with open(path) as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except ValueError:
                continue
    return rows


def load_observations(raw: Path) -> pd.DataFrame:
    recs = []
    for f in sorted(raw.glob("*.jsonl")):
        for r in _read_jsonl(f):
            base = {
                "t": r.get("t"), "run": r.get("run"), "profile": r.get("profile"),
                "scenario": r.get("scenario"), "step": r.get("step"),
                "target": r.get("target", ""), "turn_mode": r.get("turn_mode", ""),
                "collector": r.get("collector"), "node": r.get("node"),
                "entity": r.get("entity", ""), "kind": r.get("kind"),
                "metric": r.get("metric"), "value": r.get("value"),
            }
            extra = {k: v for k, v in r.items()
                     if k not in base and k not in ("collector", "node")}
            for k in PASSTHROUGH:
                base[k] = r.get(k)
            base["extra"] = json.dumps(extra, default=str) if extra else None
            recs.append(base)
    df = pd.DataFrame.from_records(recs)
    if df.empty:
        return df
    df["t"] = pd.to_numeric(df["t"], errors="coerce")
    df = df.dropna(subset=["t"]).sort_values("t")
    df["t_rel"] = df["t"] - df["t"].min()
    return df


def build_phases(observations: pd.DataFrame) -> pd.DataFrame:
    # keyed by target too: in Layout C two SUTs run concurrently into one raw dir
    key_columns = ["target", "profile", "scenario"]
    phase_events = observations[(observations.collector == "campaign")
                                & (observations.metric == "phase")].copy()
    if phase_events.empty:
        by_step = (observations.dropna(subset=["step"])
                   .groupby(key_columns + ["step"])["t"].agg(["min", "max"]).reset_index()
                   .rename(columns={"min": "t_start", "max": "t_end", "step": "level"}))
        by_step["step_index"] = by_step.groupby(key_columns).cumcount()
        return by_step[key_columns + ["step_index", "level", "t_start", "t_end"]]

    phase_events = phase_events.sort_values("t")
    phases = []
    for key_values, group in phase_events.groupby(key_columns):
        group = group.reset_index(drop=True)
        cell_mask = pd.Series(True, index=observations.index)
        for column, value in zip(key_columns, key_values):
            cell_mask &= observations[column] == value
        cell_end = observations.loc[cell_mask, "t"].max()
        boundary_ends = list(group["t"].iloc[1:]) + [cell_end]
        for (_, row), t_end in zip(group.iterrows(), boundary_ends):
            extra = json.loads(row["extra"]) if row["extra"] else {}
            phases.append({
                **dict(zip(key_columns, key_values)),
                "step_index": extra.get("index", len(phases)),
                "level": row["value"], "t_start": row["t"], "t_end": t_end,
            })
    return pd.DataFrame(phases)


def load_locust(raw: Path) -> pd.DataFrame:
    frames = []
    for f in sorted(raw.glob("locust-*_stats_history.csv")):
        try:
            d = pd.read_csv(f)
        except Exception:
            continue
        name = f.name
        # locust-<profile>-<scenario>_stats_history.csv
        stem = name.replace("_stats_history.csv", "").replace("locust-", "")
        parts = stem.rsplit("-", 1)
        d["profile"] = parts[0] if len(parts) == 2 else stem
        d["scenario"] = parts[1] if len(parts) == 2 else ""
        frames.append(d)
    return pd.concat(frames, ignore_index=True) if frames else pd.DataFrame()


def main(argv=None):
    argv = argv or sys.argv[1:]
    if not argv:
        print(__doc__)
        return 2
    run = Path(argv[0])
    raw = run / "raw"
    tidy = run / "tidy"
    tidy.mkdir(parents=True, exist_ok=True)

    obs = load_observations(raw)
    if obs.empty:
        print(f"no observations under {raw}")
        return 1
    obs.to_parquet(tidy / "observations.parquet", index=False)
    print(f"observations.parquet  {len(obs):,} rows  "
          f"({obs.metric.nunique()} metrics, {obs.collector.nunique()} collectors, "
          f"{obs.t_rel.max():.0f}s span)")

    phases = build_phases(obs)
    phases.to_parquet(tidy / "phases.parquet", index=False)
    print(f"phases.parquet        {len(phases)} phases")

    loc = load_locust(raw)
    if not loc.empty:
        loc.to_parquet(tidy / "locust.parquet", index=False)
        print(f"locust.parquet        {len(loc):,} rows")

    build_db_if_available(run)   # partial now; metrics.py rebuilds it complete
    return 0


def build_db_if_available(run: Path) -> None:
    try:
        from db import build_campaign_db  # analysis/ on sys.path
    except ImportError:
        from analysis.db import build_campaign_db
    db_path = build_campaign_db(run)
    print(f"campaign.db           {db_path.stat().st_size // 1024} KiB")


if __name__ == "__main__":
    sys.exit(main())

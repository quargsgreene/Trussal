"""
campaign.db — a per-run SQLite database built from the tidy Parquet.

Parquet stays the columnar export the figure scripts read; this database is the
analyst surface for the turn-assignment study, where the questions are
relational and iterative (diffing nc-active streams against roster churn across
two targets and many cells). ingest.py calls build_campaign_db() after writing
the Parquet; nothing downstream is required to use it.

Tables
  observations   every metric row (t, t_rel, target, turn_mode, scenario,
                 profile, step, collector, entity, kind, metric, value)
  phases         (target, scenario, profile, step_index, level, t_start, t_end)
  nc_active      the aggregator's turn stream: t, target, turn_mode, scenario,
                 profile, token, idx, kind, gap_s
  roster_events  peer_join / peer_leave: t, target, ..., token, kind, session_s
  dropouts       involuntary departures: t, target, ..., entity, source, reason
  break_points   (target, turn_mode, scenario, profile, break_level, condition,
                 metric_value)

Views
  v_turn_gap        median nc-active gap per (target, turn_mode, scenario,
                    profile, step)
  v_roster_size     mean observer roster size per cell
"""

from __future__ import annotations

import sqlite3
import sys
from pathlib import Path

import pandas as pd

_TABLE_FROM_PARQUET = {
    "phases": "phases.parquet",
    "turn_stability": "turn_stability.parquet",
    "dropouts": "dropouts.parquet",
    "dropout_rate": "dropout_rate.parquet",
    "break_points": "break_points.parquet",
    "summary": "summary.parquet",
}


def _df_to_table(conn: sqlite3.Connection, name: str, frame: pd.DataFrame) -> None:
    if frame is None or frame.empty:
        return
    safe = frame.loc[:, ~frame.columns.duplicated()].copy()
    # sqlite has no list/dict columns — stringify anything exotic
    for column in safe.columns:
        if safe[column].dtype == object:
            safe[column] = safe[column].apply(
                lambda v: v if isinstance(v, (str, int, float, bool)) or v is None else str(v))
    safe.to_sql(name, conn, if_exists="replace", index=False)


def build_campaign_db(run_dir: str | Path) -> Path:
    run_dir = Path(run_dir)
    tidy = run_dir / "tidy"
    db_path = run_dir / "campaign.db"
    conn = sqlite3.connect(db_path)
    try:
        observations = pd.read_parquet(tidy / "observations.parquet")
        _df_to_table(conn, "observations", observations)

        for table_name, parquet_name in _TABLE_FROM_PARQUET.items():
            path = tidy / parquet_name
            if path.exists():
                _df_to_table(conn, table_name, pd.read_parquet(path))

        common = ["t", "t_rel", "target", "turn_mode", "scenario", "profile", "step"]

        # nc_active: one row per turn flip, from the observer's events
        nc_source = observations[(observations.collector == "sidecar_observer")
                                 & (observations.metric == "nc_active")]
        if not nc_source.empty:
            nc_active = nc_source[[c for c in common if c in nc_source.columns]].copy()
            nc_active["token"] = nc_source["entity"].astype(str).values
            nc_active["idx"] = (nc_source["index"] if "index" in nc_source.columns
                                else pd.Series([None] * len(nc_source))).values
            nc_active["nc_kind"] = (nc_source["nc_kind"] if "nc_kind" in nc_source.columns
                                    else pd.Series([None] * len(nc_source))).values
            nc_active["gap_s"] = (nc_source["gap_s"] if "gap_s" in nc_source.columns
                                  else pd.Series([None] * len(nc_source))).values
            _df_to_table(conn, "nc_active", nc_active)

        # roster_events: joins and leaves
        roster_source = observations[(observations.collector == "sidecar_observer")
                                     & (observations.metric.isin(["peer_join", "peer_leave"]))]
        if not roster_source.empty:
            roster = roster_source[[c for c in common + ["metric"] if c in roster_source.columns]].copy()
            roster["token"] = roster_source["entity"].astype(str).values
            roster["peer_kind"] = (roster_source["peer_kind"] if "peer_kind" in roster_source.columns
                                   else pd.Series([None] * len(roster_source))).values
            roster["session_s"] = (roster_source["session_s"] if "session_s" in roster_source.columns
                                   else pd.Series([None] * len(roster_source))).values
            _df_to_table(conn, "roster_events", roster)

        conn.executescript(
            """
            DROP VIEW IF EXISTS v_turn_gap;
            CREATE VIEW v_turn_gap AS
              SELECT target, turn_mode, scenario, profile, step,
                     COUNT(*) AS turns,
                     AVG(gap_s) AS mean_gap_s
              FROM nc_active WHERE gap_s IS NOT NULL
              GROUP BY target, turn_mode, scenario, profile, step;

            DROP VIEW IF EXISTS v_roster_size;
            CREATE VIEW v_roster_size AS
              SELECT target, turn_mode, scenario, profile, step, AVG(value) AS mean_roster
              FROM observations
              WHERE collector='sidecar_observer' AND metric='roster_size'
              GROUP BY target, turn_mode, scenario, profile, step;
            """
        )
        conn.commit()
        for column_index in ("observations(target,scenario,profile,metric)",
                             "observations(t)", "nc_active(target,scenario,profile,t)",
                             "roster_events(target,scenario,profile,t)"):
            try:
                conn.execute(f"CREATE INDEX IF NOT EXISTS idx_{abs(hash(column_index))} "
                             f"ON {column_index}")
            except sqlite3.OperationalError:
                pass
        conn.commit()
    finally:
        conn.close()
    return db_path


def connect(run_dir: str | Path) -> sqlite3.Connection:
    return sqlite3.connect(Path(run_dir) / "campaign.db")


if __name__ == "__main__":
    print(build_campaign_db(sys.argv[1]))

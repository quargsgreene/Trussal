"""Shared CLI + a small pivot helper for the figNN_*.py scripts."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from plotstyle import save_figure  # noqa: E402


def figure_main(build_figure, default_output_name: str):
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", dest="run_dir", default=None,
                        help="results/<run-id> (synthetic data if omitted)")
    parser.add_argument("--column", default="single", choices=["single", "1p5", "double"])
    parser.add_argument("--name", dest="output_name", default=default_output_name)
    parser.add_argument("--out", dest="output_dir", default=None,
                        help="output directory (default figures_out/)")
    args = parser.parse_args()
    figure, used_synthetic_data = build_figure(args.run_dir, args.column)
    output_name = args.output_name + ("_SYNTH" if used_synthetic_data else "")
    save_figure(figure, output_name, args.output_dir)


def stats_by(summary_frame, index_columns, metric_name, entity=None):
    """
    Reshape the long `summary` frame into one row per `index_columns` value with
    a column per statistic (p50 / p95 / p05 / mean / count), for a single metric.
    """
    rows_for_metric = summary_frame[summary_frame.metric == metric_name]
    if entity is not None and "entity" in rows_for_metric.columns:
        rows_for_metric = rows_for_metric[rows_for_metric.entity == entity]
    elif "entity" in rows_for_metric.columns:
        # client-side metrics carry a blank entity; prefer those if an entity
        # dimension is present at all.
        blank_entity_rows = rows_for_metric[rows_for_metric.entity.fillna("") == ""]
        if not blank_entity_rows.empty:
            rows_for_metric = blank_entity_rows
    return rows_for_metric.pivot_table(
        index=index_columns, columns="stat", values="value").reset_index()

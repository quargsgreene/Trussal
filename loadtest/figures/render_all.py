#!/usr/bin/env python3
"""
Render every manuscript figure in one pass.

    python figures/render_all.py --run results/<run-id> --column single
    python figures/render_all.py                        # synthetic data, for styling

Each figNN_*.py is also runnable on its own; this just calls their build_figure()
functions in order and writes to figures_out/.
"""
from __future__ import annotations

import argparse
import importlib
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from plotstyle import save_figure

FIGURE_MODULES = [
    "fig01_bandwidth_vs_participants",
    "fig02_framerate_vs_network",
    "fig03_latency_jitter_cdf",
    "fig04_packetloss_vs_bots",
    "fig05_dropout_vs_scenario",
    "fig06_metaprogram_scaling",
    "fig07_codevolume_media",
    "fig08_server_resources",
    "fig09_turn_stability",
    "fig10_breakpoint",
    "fig11_shard_balance",
    "fig12_crdt_traffic",
    "fig13_room_scaling",
]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", dest="run_dir", default=None)
    parser.add_argument("--column", default="single", choices=["single", "1p5", "double"])
    parser.add_argument("--out", dest="output_dir", default=None)
    args = parser.parse_args()

    print(f"rendering {len(FIGURE_MODULES)} figures "
          f"({'run ' + args.run_dir if args.run_dir else 'SYNTHETIC data'}, {args.column} column)")
    failures = []
    for module_name in FIGURE_MODULES:
        try:
            figure_module = importlib.import_module(module_name)
            figure, used_synthetic_data = figure_module.build_figure(args.run_dir, args.column)
            output_name = figure_module.OUTPUT_NAME + ("_SYNTH" if used_synthetic_data else "")
            save_figure(figure, output_name, args.output_dir)
        except Exception as exc:  # one degenerate figure must not abort the batch
            failures.append((module_name, exc))
            print(f"  FAILED  {module_name}: {type(exc).__name__}: {exc}")
    if failures:
        print(f"done -> figures_out/  ({len(FIGURE_MODULES) - len(failures)}/"
              f"{len(FIGURE_MODULES)} rendered, {len(failures)} failed)")
        sys.exit(1)
    print("done -> figures_out/")


if __name__ == "__main__":
    main()

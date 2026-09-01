"""
BreakDetector — decides, from the live raw/*.jsonl of a running cell, whether
the system under test has BROKEN for turn scheduling, and for how long the
condition has held.

Used two ways:
  * BreakFindShape (locust/shapes.py) polls it each tick and ends the S6 ramp
    the moment a condition has been continuously true for `sustained_s`, so the
    recorded break_level is the last level the SUT survived.
  * standalone, after a run, to answer "when did it break and why":
        python -m harness.breakwatch results/<run-id> --once

A break is ANY of (thresholds from scenarios.yaml S6.break_conditions):
  dropout_hazard_per_part_min  involuntary leaves / participant-minute, windowed
  nc_gap_multiple_of_ideal     median nc-active turn gap  vs  the ideal slot
  aggregator_cpu_pct           aggregator container CPU p50
  jvb_cpu_pct                  JVB container CPU p50
  join_success_rate            joins that reached AGENT_READY, windowed (LOW = bad)
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import deque
from pathlib import Path

DEFAULT_CONDITIONS = {
    "dropout_hazard_per_part_min": 0.5,
    "nc_gap_multiple_of_ideal": 3.0,
    "aggregator_cpu_pct": 90,
    "jvb_cpu_pct": 92,
    "join_success_rate": 0.5,
    "sustained_s": 30,
    "poll_s": 5,
}


def _read_jsonl_tail(path: Path, since_epoch: float) -> list[dict]:
    rows = []
    try:
        with open(path) as handle:
            for line in handle:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except ValueError:
                    continue
                if row.get("t", 0) >= since_epoch:
                    rows.append(row)
    except FileNotFoundError:
        pass
    return rows


class BreakDetector:
    def __init__(self, run_dir: str | Path, conditions: dict | None = None,
                 ideal_slot_s: float = 4.0, window_s: float = 60.0):
        self.raw_dir = Path(run_dir) / "raw"
        self.conditions = {**DEFAULT_CONDITIONS, **(conditions or {})}
        self.ideal_slot_s = ideal_slot_s
        self.window_s = window_s
        # condition name -> epoch it first went true in an unbroken run
        self._true_since: dict[str, float] = {}
        self._history: deque = deque(maxlen=240)

    def _rows(self, glob_pattern: str, since: float) -> list[dict]:
        out = []
        for path in sorted(self.raw_dir.glob(glob_pattern)):
            out.extend(_read_jsonl_tail(path, since))
        return out

    def _current_values(self) -> dict:
        now = time.time()
        since = now - self.window_s
        obs = self._rows("sidecar_observer*.jsonl", since)
        hosts = self._rows("host_stats*.jsonl", since)
        joins = self._rows("human*.jsonl", since) + self._rows("media_agent*.jsonl", since)

        # dropout hazard: involuntary leaves per participant-minute over the window
        involuntary = sum(
            1 for r in obs
            if r.get("metric") == "peer_leave" and r.get("kind") in ("human", "bot")
        ) + sum(
            1 for r in joins
            if r.get("metric") == "dropout" and r.get("involuntary")
        )
        roster_sizes = [r["value"] for r in obs
                        if r.get("metric") == "roster_size" and isinstance(r.get("value"), (int, float))]
        mean_roster = (sum(roster_sizes) / len(roster_sizes)) if roster_sizes else 0.0
        participant_minutes = mean_roster * (self.window_s / 60.0)
        hazard = (involuntary / participant_minutes) if participant_minutes > 0 else 0.0

        # nc-active turn gap, median over the window
        gaps = sorted(r["value"] for r in obs
                      if r.get("metric") == "nc_turn_gap_s" and isinstance(r.get("value"), (int, float)))
        median_gap = gaps[len(gaps) // 2] if gaps else 0.0
        gap_multiple = (median_gap / self.ideal_slot_s) if self.ideal_slot_s > 0 else 0.0

        # container CPU, most recent p50-ish (mean of window) per role
        def cpu_for(substrings):
            vals = [r["value"] for r in hosts
                    if r.get("metric") == "cpu_pct"
                    and isinstance(r.get("value"), (int, float))
                    and any(s in str(r.get("entity", "")) for s in substrings)]
            return (sum(vals) / len(vals)) if vals else 0.0

        aggregator_cpu = cpu_for(["aggregator", "bot-99999", "conductor"])
        jvb_cpu = cpu_for(["jvb"])

        # join success rate over the window
        ready = sum(1 for r in joins if r.get("metric") == "join")
        failed = sum(1 for r in joins if r.get("metric") in ("join_failed", "agent_crash"))
        attempts = ready + failed
        join_rate = (ready / attempts) if attempts else 1.0

        return {
            "dropout_hazard_per_part_min": hazard,
            "nc_gap_multiple_of_ideal": gap_multiple,
            "aggregator_cpu_pct": aggregator_cpu,
            "jvb_cpu_pct": jvb_cpu,
            "join_success_rate": join_rate,
        }

    def poll(self) -> dict:
        """
        {"broken": bool, "condition": str|None, "value": float|None,
         "held_s": float, "values": {...}}
        """
        now = time.time()
        values = self._current_values()
        self._history.append({"t": now, **values})

        broken = None
        for name, current in values.items():
            threshold = self.conditions.get(name)
            if threshold is None:
                continue
            # join_success_rate trips when LOW; everything else when HIGH
            tripped_now = current < threshold if name == "join_success_rate" else current > threshold
            if tripped_now:
                self._true_since.setdefault(name, now)
                held = now - self._true_since[name]
                if held >= self.conditions["sustained_s"] and broken is None:
                    broken = {"condition": name, "value": current, "held_s": held}
            else:
                self._true_since.pop(name, None)

        return {
            "broken": broken is not None,
            "condition": broken["condition"] if broken else None,
            "value": broken["value"] if broken else None,
            "held_s": broken["held_s"] if broken else 0.0,
            "values": values,
        }


def main(argv=None):
    parser = argparse.ArgumentParser()
    parser.add_argument("run_dir")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--poll-s", type=float, default=5.0)
    parser.add_argument("--ideal-slot-s", type=float, default=4.0)
    args = parser.parse_args(argv)

    detector = BreakDetector(args.run_dir, ideal_slot_s=args.ideal_slot_s)
    while True:
        report = detector.poll()
        print(json.dumps({"t": time.time(), **report}))
        if args.once or report["broken"]:
            return 0 if not report["broken"] else 3
        time.sleep(args.poll_s)


if __name__ == "__main__":
    sys.exit(main())

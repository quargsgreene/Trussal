"""
CampaignShape — the one LoadTestShape for every scenario. Behaviour comes from
the scenario config (config/scenarios.yaml, selected by $SCENARIO):

  S1-S5   walk the explicit step schedule, holding each `hold_s` seconds.
  S6      walk the generated ramp levels, but END EARLY the moment
          harness.breakwatch.BreakDetector reports a SUSTAINED break — the last
          level held is written as `break_level`.

Runs on the master only. At each step boundary it broadcasts
{"lt_step": {...}} to workers and writes a `phase` marker so analysis can
segment time exactly by step.

Env: SCENARIO, RUN_ID, PROFILE, TRUSSAL_TARGET. Optional STEP_HOLD_SCALE.
"""

from __future__ import annotations

import os
import time

from locust import LoadTestShape

from _state import STEPS, SCENARIO_ID, SCENARIO, total_users_for, population_for, apply_step
from harness.common import MetricSink, RunContext

_HOLD_SCALE = float(os.environ.get("STEP_HOLD_SCALE", "1.0"))
_RAMP_SETTLE_S = float(os.environ.get("STEP_RAMP_SETTLE_S", "20"))


class CampaignShape(LoadTestShape):
    use_common_options = True

    def __init__(self):
        super().__init__()
        self._ctx = RunContext.from_env()
        self._sink = MetricSink(self._ctx, "campaign")
        self._is_break_find = SCENARIO_ID == "S6"

        self._boundaries = []
        elapsed = 0.0
        for step_index, step in enumerate(STEPS):
            hold = float(step["hold_s"]) * _HOLD_SCALE
            self._boundaries.append((elapsed, elapsed + hold, step_index, int(step["level"])))
            elapsed += hold
        self._total_s = elapsed + _RAMP_SETTLE_S
        self._last_index = -1

        self._break_detector = None
        if self._is_break_find:
            from harness.breakwatch import BreakDetector
            self._break_detector = BreakDetector(
                self._ctx.run_dir,
                conditions=SCENARIO.get("break_conditions", {}),
                ideal_slot_s=4.0,
            )
            self._last_break_poll = 0.0
            self._break_poll_s = float(SCENARIO.get("break_conditions", {}).get("poll_s", 5))

        self._sink.event("campaign_start", scenario=SCENARIO_ID, target=self._ctx.target_name,
                         turn_mode=self._ctx.turn_mode,
                         steps=[s["level"] for s in STEPS], total_s=self._total_s)

    def tick(self):
        run_time = self.get_run_time()

        # S6: stop as soon as the SUT has been broken for `sustained_s`
        if self._break_detector and (time.time() - self._last_break_poll) >= self._break_poll_s:
            self._last_break_poll = time.time()
            report = self._break_detector.poll()
            self._sink.sample("breakwatch", 1 if report["broken"] else 0,
                              condition=report["condition"], value=report["value"],
                              held_s=report["held_s"], values=report["values"])
            if report["broken"]:
                self._sink.event("break_level", value=self._boundaries[max(0, self._last_index)][3],
                                 condition=report["condition"], metric_value=report["value"],
                                 target=self._ctx.target_name, turn_mode=self._ctx.turn_mode)
                return None

        if run_time >= self._total_s:
            self._sink.event("campaign_end", run_time=run_time,
                             reason="ramp exhausted" if self._is_break_find else "schedule complete")
            return None

        step_index, level = self._boundaries[-1][2], self._boundaries[-1][3]
        for start, end, idx, lvl in self._boundaries:
            if start <= run_time < end:
                step_index, level = idx, lvl
                break

        if step_index != self._last_index:
            self._last_index = step_index
            message = {"index": step_index, "level": level, "scenario": SCENARIO_ID}
            apply_step(message)
            try:
                self.runner.send_message("lt_step", message)
            except Exception:
                pass
            self._sink.event("phase", value=level, index=step_index,
                             population=population_for(level), target=self._ctx.target_name,
                             turn_mode=self._ctx.turn_mode)

        user_count = total_users_for(level)
        spawn_rate = max(1.0, user_count / max(1.0, _RAMP_SETTLE_S / 4))
        return (user_count, spawn_rate)

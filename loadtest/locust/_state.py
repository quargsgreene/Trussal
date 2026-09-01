"""
Shared step state between the master-only LoadTestShape and the users running on
every worker. The shape advances the step and broadcasts it with
`runner.send_message("lt_step", ...)`; workers apply it to CURRENT via a handler
registered in locustfile.py. Users read `current_level()` / `current_step()`.
"""

from __future__ import annotations

import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness.common import load_scenarios  # noqa: E402

SCENARIO_ID = os.environ.get("SCENARIO", "S1")

_SCENARIOS_BY_ID = {value["id"]: (key, value)
                    for key, value in load_scenarios()["scenarios"].items()}
SCENARIO_KEY, SCENARIO = _SCENARIOS_BY_ID.get(SCENARIO_ID, (None, {}))

# S1-S5 use an explicit step schedule; S6 (break-find) generates its levels from
# a `ramp` spec and stops when the break detector trips.
STEPS = list(SCENARIO.get("steps", []))
RAMP = SCENARIO.get("ramp")  # {start, increment, max, dwell_s} for S6

if not STEPS and RAMP:
    STEPS = [{"level": lvl, "hold_s": RAMP["dwell_s"]}
             for lvl in range(RAMP["start"], RAMP["max"] + 1, RAMP["increment"])]
elif not STEPS:
    STEPS = [{"level": 10, "hold_s": 300}]

CURRENT = {
    "index": 0,
    "level": STEPS[0]["level"],
    "scenario": SCENARIO_ID,
    "t_step_start": time.time(),
}


def apply_step(message: dict) -> None:
    CURRENT.update(message)
    CURRENT["t_step_start"] = time.time()
    os.environ["STEP_LEVEL"] = str(message.get("level", CURRENT["level"]))


def current_level() -> int:
    return int(CURRENT["level"])


def current_step() -> dict:
    return dict(CURRENT)


# --- population plan: level -> {UserClassName: count} -------------------------
FIXED_HUMANS = int(os.environ.get("LT_HUMANS", SCENARIO.get("humans", 0)) or 0)
GHOST_RATIO = int(os.environ.get("LT_GHOST_RATIO", SCENARIO.get("ghost_ratio", 0)) or 0)
CHURN_POOL = int(SCENARIO.get("churn_pool", 0))
OPERATOR_COUNT = int(os.environ.get("LT_OPERATORS", 2 if SCENARIO_ID == "S2" else 0))
EDITOR_COUNT = int(os.environ.get("LT_EDITORS", 1 if SCENARIO_ID == "S3" else 0))
SEED_BOT_COUNT = int(SCENARIO.get("seed_bots", 0))


def population_for(level: int) -> dict:
    if SCENARIO_ID == "S1":
        humans = level
        return {"HumanParticipantUser": humans, "SidecarGhostUser": humans * GHOST_RATIO}

    if SCENARIO_ID == "S5":
        # fixed ring core + a churn pool that cycles in/out; level = churn rate,
        # read by ChurnUser, NOT a user count. One editor owns the metaprogram.
        return {
            "HumanParticipantUser": FIXED_HUMANS,
            "ChurnUser": CHURN_POOL,
            "MetaprogramEditorUser": 1,
            "SidecarGhostUser": FIXED_HUMANS * GHOST_RATIO,
        }

    if SCENARIO_ID == "S6":
        # level IS the participant count for the ramp; a little background churn.
        return {
            "HumanParticipantUser": level,
            "ChurnUser": max(2, level // 8),
            "MetaprogramEditorUser": 1,
            "SidecarGhostUser": level * GHOST_RATIO,
        }

    # S2/S3/S4: fixed human population; the independent variable is driven inside
    # the operator / editor / churn task via current_level().
    plan = {"HumanParticipantUser": FIXED_HUMANS}
    if OPERATOR_COUNT:
        plan["BotOperatorUser"] = OPERATOR_COUNT
    if EDITOR_COUNT:
        plan["MetaprogramEditorUser"] = EDITOR_COUNT
    return plan


def total_users_for(level: int) -> int:
    return max(1, sum(population_for(level).values()))

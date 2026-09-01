"""
Shared plumbing: run identity, filesystem layout, config loading, and a
process-safe append-only JSONL metric sink.

Every collector and every locust user writes rows through `MetricSink`. One row
is one observation:

    {"t": <epoch_s float>, "run": <run_id>, "profile": <p_id>, "scenario": <s_id>,
     "step": <step_level or -1>, "entity": <who>, "kind": <event|sample>,
     "metric": <name>, "value": <number>, ...extra}

`analysis/ingest.py` is the only reader; it tolerates extra keys.
"""

from __future__ import annotations

import json
import os
import socket
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError:  # analysis-only environments may skip pyyaml
    yaml = None

HARNESS_DIR = Path(__file__).resolve().parent
LOADTEST_DIR = HARNESS_DIR.parent
REPO_DIR = LOADTEST_DIR.parent
RESULTS_DIR = LOADTEST_DIR / "results"
CONFIG_DIR = LOADTEST_DIR / "config"


# --------------------------------------------------------------------------- #
# Run context — every process in a cell shares these via the environment.
# run_campaign.sh exports RUN_ID / PROFILE / SCENARIO / STEP_LEVEL.
# --------------------------------------------------------------------------- #
@dataclass
class RunContext:
    run_id: str
    profile: str
    scenario: str
    host: str
    scheme: str = "https"
    ws_path: str = "/ws"
    xmpp_ws_path: str = "/xmpp-websocket"
    node: str = field(default_factory=socket.gethostname)
    # Which system-under-test this process is driving. In Layout C there are two
    # identical Trussal clones — "sut_explicit" and "sut_hash" — and every metric
    # row carries this so the analysis can compare the two turn-assignment modes.
    target_name: str = ""
    # The turn-assignment mode the harness should write into the shared
    # metaprogram for this target: "explicit" (a literal `$ participants` list)
    # or "hash" (a `# ring hash` directive). Empty = leave the program alone.
    turn_mode: str = ""

    @classmethod
    def from_env(cls) -> "RunContext":
        return cls(
            run_id=os.environ.get("RUN_ID", time.strftime("dev-%Y%m%d-%H%M%S")),
            profile=os.environ.get("PROFILE", "p0_lan"),
            scenario=os.environ.get("SCENARIO", "S0"),
            host=os.environ.get("TRUSSAL_HOST", "localhost"),
            scheme=os.environ.get("TRUSSAL_SCHEME", "https"),
            ws_path=os.environ.get("TRUSSAL_WS_PATH", "/ws"),
            xmpp_ws_path=os.environ.get("TRUSSAL_XMPP_WS_PATH", "/xmpp-websocket"),
            target_name=os.environ.get("TRUSSAL_TARGET", ""),
            turn_mode=os.environ.get("TRUSSAL_TURN_MODE", ""),
        )

    @property
    def http_base(self) -> str:
        return f"{self.scheme}://{self.host}"

    @property
    def ws_base(self) -> str:
        wss = "wss" if self.scheme == "https" else "ws"
        return f"{wss}://{self.host}{self.ws_path}"

    def sidecar_url(self, room: str, role: str = "player") -> str:
        from urllib.parse import quote

        return f"{self.ws_base}?room={quote(room)}&role={role}"

    @property
    def run_dir(self) -> Path:
        d = RESULTS_DIR / self.run_id
        (d / "raw").mkdir(parents=True, exist_ok=True)
        (d / "logs").mkdir(parents=True, exist_ok=True)
        return d


def current_step_level() -> int:
    try:
        return int(os.environ.get("STEP_LEVEL", "-1"))
    except ValueError:
        return -1


# --------------------------------------------------------------------------- #
# JSONL sink — one file per (collector, host, pid) so concurrent writers never
# interleave a line. ingest.py globs raw/*.jsonl.
# --------------------------------------------------------------------------- #
class MetricSink:
    def __init__(self, ctx: RunContext, collector: str):
        self.ctx = ctx
        self.collector = collector
        safe_node = ctx.node.replace(".", "_")
        self.path = ctx.run_dir / "raw" / f"{collector}.{safe_node}.{os.getpid()}.jsonl"
        self._lock = threading.Lock()
        self._fh = open(self.path, "a", buffering=1)  # line-buffered
        self.emit("meta", "sink_open", 1, collector=collector)

    def emit(
        self,
        kind: str,
        metric: str,
        value: float | int | bool | None,
        *,
        entity: str = "",
        t: float | None = None,
        **extra: Any,
    ) -> None:
        row = {
            "t": time.time() if t is None else t,
            "run": self.ctx.run_id,
            "profile": self.ctx.profile,
            "scenario": self.ctx.scenario,
            "step": current_step_level(),
            "target": self.ctx.target_name,
            "turn_mode": self.ctx.turn_mode,
            "collector": self.collector,
            "node": self.ctx.node,
            "entity": entity,
            "kind": kind,
            "metric": metric,
            "value": value,
        }
        if extra:
            row.update(extra)
        line = json.dumps(row, separators=(",", ":"), default=_json_default)
        with self._lock:
            self._fh.write(line + "\n")

    def sample(self, metric: str, value: float, *, entity: str = "", **extra: Any) -> None:
        self.emit("sample", metric, value, entity=entity, **extra)

    def event(self, metric: str, *, entity: str = "", value: float = 1, **extra: Any) -> None:
        self.emit("event", metric, value, entity=entity, **extra)

    def close(self) -> None:
        try:
            self.emit("meta", "sink_close", 1)
            self._fh.flush()
            self._fh.close()
        except Exception:
            pass


def _json_default(o: Any):  # numpy scalars, etc.
    try:
        return o.item()
    except AttributeError:
        return str(o)


# --------------------------------------------------------------------------- #
# Config
# --------------------------------------------------------------------------- #
def load_yaml(path: str | Path) -> dict:
    if yaml is None:
        raise RuntimeError("pyyaml not installed")
    with open(path) as fh:
        return yaml.safe_load(fh)


def load_inventory(path: str | Path | None = None) -> dict:
    path = Path(path or os.environ.get("INVENTORY", CONFIG_DIR / "inventory.yaml"))
    if not path.exists():
        path = CONFIG_DIR / "inventory.example.yaml"
    return load_yaml(path)


def load_scenarios(path: str | Path | None = None) -> dict:
    return load_yaml(path or CONFIG_DIR / "scenarios.yaml")


def load_netem_profiles(path: str | Path | None = None) -> dict:
    return load_yaml(path or CONFIG_DIR / "netem_profiles.yaml")


def load_targets(inventory: dict) -> dict[str, dict]:
    """
    The system(s) under test, as {name: {host, scheme, ws_path, xmpp_ws_path,
    turn_mode, ...}}. Supports both the single-target layout (`target:` in the
    inventory) and Layout C's matched pair (`targets:` — a map).
    """
    if "targets" in inventory:
        return dict(inventory["targets"])
    one = inventory.get("target", {})
    return {one.get("name", "sut"): one} if one else {}


def context_for_target(inventory: dict, target_name: str, *, run_id: str,
                       profile: str, scenario: str) -> RunContext:
    spec = load_targets(inventory)[target_name]
    return RunContext(
        run_id=run_id, profile=profile, scenario=scenario,
        host=spec["host"], scheme=spec.get("scheme", "https"),
        ws_path=spec.get("ws_path", "/ws"),
        xmpp_ws_path=spec.get("xmpp_ws_path", "/xmpp-websocket"),
        target_name=target_name, turn_mode=spec.get("turn_mode", ""),
    )


PROD_HOSTS = {"meet.trussal.com", "trussal.com", "www.trussal.com"}


def is_prod(host: str) -> bool:
    return host.lower().strip() in PROD_HOSTS


def assert_not_prod(host: str) -> None:
    if is_prod(host) and os.environ.get("ALLOW_PROD") != "1":
        raise SystemExit(
            f"refusing to target production host {host!r}. "
            f"Point at a staging Trussal, or export ALLOW_PROD=1 to override."
        )

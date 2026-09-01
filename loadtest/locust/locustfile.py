"""
Trussal load-test locustfile.

    locust -f locust/locustfile.py --headless --host https://$TRUSSAL_HOST \
           -u <n> -r <rate> -t <dur> --csv results/$RUN_ID/raw/locust

Scenario is chosen by $SCENARIO (S1..S6); the CampaignShape drives the step
schedule from config/scenarios.yaml, so -u/-t on the CLI are only a ceiling and
a safety timeout. Distributed: run this same file as --master on gen-master and
--worker on gen-master/gen-worker (see orchestrate/distributed.sh).

User classes
  SidecarGhostUser       app-plane only: a WS peer that sends pattern/play/
                         effects/metrics. Cheap; inflates roster + relay fan-out.
  HumanParticipantUser   a real headless-Chromium participant (harness/media_agent.py
                         subprocess) + a per-step code-churn task over the agent's
                         stdin (S1, S4, and the fixed human core of S2-S6).
  BotOperatorUser        a real WS peer that presses "spawn N" (fleet-request) and
                         paces off fleet-status (S2).
  MetaprogramEditorUser  owns the shared metaprogram: grows `$ participants` (S3),
                         or in S5/S6 either maintains the literal on every roster
                         change (explicit arm) or writes `# ring hash` once (hash
                         arm), chosen by the target's turn_mode.
  ChurnUser              one slot in the churn pool (S5/S6): join -> hold -> leave
                         (a share as SIGKILL = involuntary) -> rejoin, at the
                         pool-wide rate current_level() sets.
"""

from __future__ import annotations

import os
import random
import subprocess
import sys
import time
import uuid
from pathlib import Path

import gevent
from locust import User, task, constant_pacing, events, between

LOADTEST_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(LOADTEST_DIR))
sys.path.insert(0, str(LOADTEST_DIR / "locust"))

from harness.common import MetricSink, RunContext, load_scenarios, assert_not_prod
from harness.sidecar import SidecarClient
from harness import strudel_payloads as sp
from harness.yjs_meta import MetaprogramDoc, build_program

import _state
from shapes import CampaignShape  # noqa: F401  (locust discovers the shape here)

CTX = RunContext.from_env()
SCEN = _state.SCENARIO
ROOM = os.environ.get("LT_ROOM") or f"{CTX.run_id}-{CTX.profile}-{CTX.scenario}".lower().replace("_", "-")
MEDIA = {**load_scenarios().get("media_defaults", {}), **SCEN.get("media_profile", {})}
SEED_VIDEO = os.environ.get("LT_SEED_VIDEO", str(LOADTEST_DIR / "media" / "seeds" / "camera_320x240_15.y4m"))
SEED_AUDIO = os.environ.get("LT_SEED_AUDIO", str(LOADTEST_DIR / "media" / "seeds" / "mic_16k.wav"))
NODE_BIN = os.environ.get("LT_NODE_BIN", "node")

MASTER_CODE = 's("bd sd").stack(note("c e g a").s("sawtooth").lpf(700)) // loadtest master'


def _lognormal_think(mean_s: float) -> float:
    # median ~ mean_s, right-skewed like real human gaps
    return min(mean_s * 6, random.lognormvariate(mu=_math_log(mean_s), sigma=0.6))


def _math_log(x: float) -> float:
    import math
    return math.log(max(1e-3, x))


# --------------------------------------------------------------------------- #
# worker <- master step broadcast
# --------------------------------------------------------------------------- #
@events.init.add_listener
def _register_step_channel(environment, **_):
    def _on_step(environment, msg, **__):
        _state.apply_step(msg.data)
    try:
        environment.runner.register_message("lt_step", _on_step)
    except Exception:
        pass


@events.test_start.add_listener
def _on_start(environment, **_):
    assert_not_prod(CTX.host)
    sink = MetricSink(CTX, "campaign")
    sink.event("test_start", room=ROOM, scenario=CTX.scenario, profile=CTX.profile,
               host=CTX.host, media=MEDIA)
    sink.close()


# --------------------------------------------------------------------------- #
class SidecarGhostUser(User):
    weight = 1
    wait_time = between(1, 4)

    def on_start(self):
        self.name = f"ghost-{CTX.node}-{uuid.uuid4().hex[:8]}"
        self.sink = MetricSink(CTX, "ghost")
        self.client_sc = SidecarClient(
            CTX.sidecar_url(ROOM, "player"),
            display_name=self.name, stable_id=uuid.uuid4().hex,
            on_event=self._ev, name=self.name,
        )
        t0 = time.time()
        try:
            self.client_sc.connect(timeout=MEDIA.get("join_timeout_s", 45))
            ok = self.client_sc.wait_roster(timeout=MEDIA.get("join_timeout_s", 45))
            dt = (time.time() - t0) * 1000
            events.request.fire(request_type="WS", name="ghost_connect",
                                response_time=dt, response_length=0,
                                exception=None if ok else RuntimeError("no roster"))
            self.sink.event("connected", entity=self.name, value=dt, ok=ok,
                            roomIndex=self.client_sc.my_room_index)
        except Exception as e:
            events.request.fire(request_type="WS", name="ghost_connect",
                                response_time=(time.time() - t0) * 1000,
                                response_length=0, exception=e)
            self.sink.event("connect_failed", entity=self.name, reason=repr(e))
            raise gevent.GreenletExit()

    def _ev(self, kind, data):
        if kind == "rtt":
            self.sink.sample("ws_rtt_ms", data["rtt"], entity=self.name)
            self.sink.sample("ws_jitter_ms", data.get("jitter") or 0.0, entity=self.name)
        elif kind == "roster":
            self.sink.sample("roster_size", data["size"], entity=self.name)
        elif kind == "peer-leave":
            self.sink.event("saw_peer_leave", entity=self.name, size=data["size"])
        elif kind == "disconnected":
            self.sink.event("disconnected", entity=self.name,
                            involuntary=not data.get("intentional"),
                            reason=data.get("reason"), code=data.get("code"))

    @task(5)
    def churn_pattern(self):
        code = sp.code_payload("plain", 120 + _state.current_level() * 2, seed=hash(self.name) & 0xffff)
        self.client_sc.send_pattern(code)
        self.client_sc.send_play(True)

    @task(1)
    def toggle_effects(self):
        self.client_sc.send_effects(distortion=random.random() < 0.5,
                                    noise=random.random() < 0.3,
                                    reverb=random.random() < 0.5)

    def on_stop(self):
        try:
            self.client_sc.close(intentional=True)
        finally:
            self.sink.close()


# --------------------------------------------------------------------------- #
class HumanParticipantUser(User):
    weight = 1
    wait_time = constant_pacing(1)   # the churn task sets its own pacing

    def on_start(self):
        self.name = f"human-{CTX.node}-{uuid.uuid4().hex[:8]}"
        self.sink = MetricSink(CTX, "human")
        self._media_cycle = list(SCEN.get("media_kinds", ["plain"]))
        self._mi = 0
        self._proc = None
        self._ready = False
        argv = [
            sys.executable, str(LOADTEST_DIR / "harness" / "media_agent.py"),
            "--room", ROOM, "--name", self.name,
            "--host", CTX.host, "--scheme", CTX.scheme,
            "--stats-interval", str(MEDIA.get("stats_interval_s", 2)),
            "--join-timeout", str(MEDIA.get("join_timeout_s", 45)),
            "--video-height", str(MEDIA.get("video_height", 240)),
            "--fps", str(MEDIA.get("fps", 15)),
            "--seed-video", SEED_VIDEO, "--seed-audio", SEED_AUDIO,
        ]
        if MEDIA.get("strudel_on", True):
            argv.append("--strudel-on")
        if MEDIA.get("hydra"):
            argv.append("--hydra")
        env = dict(os.environ, PYTHONPATH=str(LOADTEST_DIR))
        t0 = time.time()
        self._proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=subprocess.DEVNULL, text=True, bufsize=1, env=env)
        gevent.spawn(self._pump_stdout)
        # wait (cooperatively) for AGENT_READY
        deadline = t0 + MEDIA.get("join_timeout_s", 45) + 15
        while time.time() < deadline and not self._ready and self._proc.poll() is None:
            gevent.sleep(0.5)
        dt = (time.time() - t0) * 1000
        exc = None if self._ready else RuntimeError("agent did not become ready")
        events.request.fire(request_type="BROWSER", name="join",
                            response_time=dt, response_length=0, exception=exc)
        if not self._ready:
            self._kill()
            raise gevent.GreenletExit()

    def _pump_stdout(self):
        proc = self._proc
        for line in iter(proc.stdout.readline, ""):
            line = line.strip()
            if line.startswith("AGENT_READY"):
                self._ready = True
            elif line.startswith("AGENT_JOIN_FAIL"):
                self._ready = False
                return
            elif line.startswith("AGENT_DROPOUT"):
                involuntary = "involuntary=True" in line
                events.request.fire(request_type="BROWSER", name="dropout",
                                    response_time=0, response_length=0,
                                    exception=RuntimeError(line) if involuntary else None)
                self.sink.event("dropout", entity=self.name, involuntary=involuntary, line=line)
        # stdout closed => process exiting
        rc = proc.poll()
        if rc not in (0, None) and self._ready:
            self.sink.event("agent_crash", entity=self.name, rc=rc)
            events.request.fire(request_type="BROWSER", name="agent_crash",
                                response_time=0, response_length=0, exception=RuntimeError(f"rc={rc}"))

    def _send(self, obj: dict):
        try:
            import json
            self._proc.stdin.write(json.dumps(obj) + "\n")
            self._proc.stdin.flush()
        except (BrokenPipeError, ValueError, AttributeError):
            pass

    @task
    def churn_code(self):
        interval = float(SCEN.get("update_interval_s", SCEN.get("edit_interval_s", 6)))
        kind = self._media_cycle[self._mi % len(self._media_cycle)]
        self._mi += 1
        # S4: byte budget is the step level. Elsewhere: a modest realistic edit.
        target = _state.current_level() if CTX.scenario == "S4" else random.randint(150, 900)
        code = sp.code_payload(kind, target, seed=(hash(self.name) & 0xffff) + self._mi)
        t0 = time.time()
        self._send({"cmd": "eval", "code": code, "media": kind})
        events.request.fire(request_type="BROWSER", name=f"code_push[{kind}]",
                            response_time=(time.time() - t0) * 1000,
                            response_length=len(code), exception=None)
        self.sink.event("code_push", entity=self.name, media=kind, bytes=len(code),
                        level=_state.current_level())
        gevent.sleep(max(0.5, interval))

    def on_stop(self):
        self._send({"cmd": "leave"})
        gevent.sleep(2)
        self._kill()
        self.sink.close()

    def _kill(self):
        if not self._proc:
            return
        try:
            self._proc.terminate()
            for _ in range(20):
                if self._proc.poll() is not None:
                    break
                gevent.sleep(0.25)
            if self._proc.poll() is None:
                self._proc.kill()
        except Exception:
            pass


# --------------------------------------------------------------------------- #
class BotOperatorUser(User):
    """S2: presses 'spawn N' and paces off fleet-status."""
    weight = 1
    wait_time = between(2, 5)

    def on_start(self):
        self.name = f"op-{CTX.node}-{uuid.uuid4().hex[:6]}"
        self.sink = MetricSink(CTX, "operator")
        self.spawned = 0
        self._pending_since = None
        self._batch = int(SCEN.get("spawn_batch", 4))
        self.n_ops = max(1, _state.OPERATORS)
        self.client_sc = SidecarClient(
            CTX.sidecar_url(ROOM, "player"), display_name=self.name,
            stable_id=uuid.uuid4().hex, on_event=self._ev, name=self.name,
        )
        self.client_sc.connect(timeout=45)
        self.client_sc.wait_roster(timeout=45)
        self.sink.event("connected", entity=self.name, roomIndex=self.client_sc.my_room_index)

    def _ev(self, kind, data):
        if kind == "fleet-status" and data.get("action") == "spawn":
            if self._pending_since is not None:
                dt = (time.time() - self._pending_since) * 1000
                events.request.fire(request_type="FLEET", name="spawn_batch",
                                    response_time=dt, response_length=data.get("spawned", 0),
                                    exception=None if data.get("spawned") else RuntimeError(data.get("reason", "0 spawned")))
                self.sink.event("spawn_ack", entity=self.name, latency_ms=dt,
                                spawned=data.get("spawned"), fleetSize=data.get("fleetSize"),
                                reason=data.get("reason"))
                self._pending_since = None
        elif kind == "disconnected":
            self.sink.event("disconnected", entity=self.name,
                            involuntary=not data.get("intentional"), reason=data.get("reason"))

    @task
    def ramp(self):
        if self._pending_since is not None:
            return  # wait for the last batch's fleet-status
        my_target = -(-_state.current_level() // self.n_ops)  # ceil share
        if self.spawned < my_target:
            n = min(self._batch, my_target - self.spawned)
            self._pending_since = time.time()
            self.client_sc.send_fleet_request("spawn", count=n, code=MASTER_CODE)
            self.spawned += n
            self.sink.event("spawn_request", entity=self.name, count=n, target=my_target)
        elif self.spawned > my_target + self._batch:
            # step level dropped — shed the surplus
            self.client_sc.send_fleet_request("remove", targets="all")
            self.sink.event("cluster_reset", entity=self.name, was=self.spawned)
            self.spawned = 0

    def on_stop(self):
        try:
            self.client_sc.send_fleet_request("remove", targets="all")
            gevent.sleep(1)
            self.client_sc.close(intentional=True)
        finally:
            self.sink.close()


# --------------------------------------------------------------------------- #
class MetaprogramEditorUser(User):
    """
    Owns the shared metaprogram for a cell.
      S3            grows `$ participants < ... >` toward current_level() tokens.
      S5 / S6 explicit  re-writes `$ participants <all present tokens>` on every
                        roster change (the literal that must be maintained).
      S5 / S6 hash      writes `$ participants <0>\\n# ring hash` ONCE, then idles —
                        the scheduler follows the live roster on its own.
    All via a Yjs crdt-update with modality:'apply'.
    """
    weight = 1
    wait_time = constant_pacing(1)

    def on_start(self):
        self.name = f"editor-{CTX.node}-{uuid.uuid4().hex[:6]}"
        self.sink = MetricSink(CTX, "editor")
        self.doc = MetaprogramDoc(node_bin=NODE_BIN)
        self._updates = 0
        self._last_nc = {}          # token -> last seen t (for cadence)
        self._last_program_text = None
        self._turn_mode = CTX.turn_mode or "explicit"
        self._directives = SCEN.get("program_directives", SCEN.get("directives", ""))
        self.client_sc = SidecarClient(
            CTX.sidecar_url(ROOM, "player"), display_name=self.name,
            stable_id=uuid.uuid4().hex, on_event=self._ev, name=self.name,
        )
        self.client_sc.connect(timeout=45)
        self.client_sc.wait_roster(timeout=45)
        self.sink.event("connected", entity=self.name, roomIndex=self.client_sc.my_room_index,
                        turn_mode=self._turn_mode)

    def _publish(self, program_text: str, *, tokens: int):
        if program_text == self._last_program_text:
            return
        result = self.doc.set_text(program_text, snapshot=(self._updates % 25 == 0))
        if not result:
            return
        self._last_program_text = program_text
        self._updates += 1
        self.client_sc.send_crdt_update(result["update"], snapshot=result["snapshot"],
                                        modality="apply", channel="metaprogram")
        self.sink.event("metaprogram_apply", entity=self.name, tokens=tokens,
                        update_bytes=result["bytes"], snapshot=result["snapshot"],
                        turn_mode=self._turn_mode)

    def _ev(self, kind, data):
        if kind == "nc-active":
            tok = data.get("token")
            now = time.time()
            if tok is not None and tok in self._last_nc:
                self.sink.sample("nc_active_gap_s", now - self._last_nc[tok], entity=self.name, token=str(tok))
            if tok is not None:
                self._last_nc[tok] = now
            self.sink.event("nc_active", entity=self.name, token=tok, index=data.get("index"),
                            kind=data.get("kind"), ring=len(self._last_nc))
        elif kind == "crdt-update":
            self.sink.sample("crdt_update_bytes_in", len(data.get("update", "") or ""), entity=self.name)
        elif kind == "disconnected":
            self.sink.event("disconnected", entity=self.name,
                            involuntary=not data.get("intentional"), reason=data.get("reason"))

    def _room_tokens(self):
        toks = []
        for p in self.client_sc.peers.values():
            ri = p.get("roomIndex")
            if ri is not None and not p.get("isAggregator"):
                toks.append(str(ri))
        if self.client_sc.my_room_index:
            toks.append(str(self.client_sc.my_room_index))
        # stable order: humans (ints) then bots (suffixed)
        toks = sorted(set(toks), key=lambda t: (not t.isdigit(), len(t), t))
        return toks or ["0"]

    @task
    def maintain_program(self):
        if CTX.scenario == "S3":
            # grow toward the step's token count, repeating the room's tokens
            target = _state.current_level()
            available = self._room_tokens()
            sequence = [available[i % len(available)] for i in range(target)]
            self._publish(build_program(sequence, self._directives), tokens=target)
            gevent.sleep(max(1.0, float(SCEN.get("edit_interval_s", 6))))
            return

        # S5 / S6
        if self._turn_mode == "hash":
            # write it once; the scheduler tracks the roster from here on
            self._publish(build_program(["0"], "# ring hash\n" + self._directives), tokens=0)
            gevent.sleep(5)
        else:  # explicit: keep the literal in step with the live roster
            tokens = self._room_tokens()
            self._publish(build_program(tokens, self._directives), tokens=len(tokens))
            gevent.sleep(max(1.0, float(SCEN.get("edit_interval_s", 3))))

    def on_stop(self):
        try:
            result = self.doc.set_text(build_program(["0"], self._directives), snapshot=True)
            if result:
                self.client_sc.send_crdt_update(result["update"], snapshot=True, modality="apply")
            gevent.sleep(1)
            self.client_sc.close(intentional=True)
            self.doc.close()
        finally:
            self.sink.close()


# --------------------------------------------------------------------------- #
class MediaAgentHandle:
    """
    Owns one harness/media_agent.py subprocess: start, wait for AGENT_READY,
    pump its stdout for AGENT_DROPOUT, push stdin commands, and kill it either
    gracefully (SIGTERM -> the agent leaves the conference cleanly) or hard
    (SIGKILL -> an involuntary drop with no leave). Shared by HumanParticipantUser
    (via its own inline copy) and ChurnUser.
    """

    def __init__(self, name: str, sink: MetricSink, *, on_dropout=None):
        self.name = name
        self.sink = sink
        self.on_dropout = on_dropout
        self.proc = None
        self.ready = False

    def start(self, *, join_timeout_s: float) -> bool:
        argv = [
            sys.executable, str(LOADTEST_DIR / "harness" / "media_agent.py"),
            "--room", ROOM, "--name", self.name,
            "--host", CTX.host, "--scheme", CTX.scheme,
            "--stats-interval", str(MEDIA.get("stats_interval_s", 2)),
            "--join-timeout", str(join_timeout_s),
            "--video-height", str(MEDIA.get("video_height", 240)),
            "--fps", str(MEDIA.get("fps", 15)),
            "--seed-video", SEED_VIDEO, "--seed-audio", SEED_AUDIO,
        ]
        if MEDIA.get("strudel_on", True):
            argv.append("--strudel-on")
        if MEDIA.get("hydra"):
            argv.append("--hydra")
        env = dict(os.environ, PYTHONPATH=str(LOADTEST_DIR))
        started_at = time.time()
        self.proc = subprocess.Popen(argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.DEVNULL, text=True, bufsize=1, env=env)
        gevent.spawn(self._pump_stdout)
        deadline = started_at + join_timeout_s + 15
        while time.time() < deadline and not self.ready and self.proc.poll() is None:
            gevent.sleep(0.5)
        return self.ready

    def _pump_stdout(self):
        for line in iter(self.proc.stdout.readline, ""):
            line = line.strip()
            if line.startswith("AGENT_READY"):
                self.ready = True
            elif line.startswith("AGENT_JOIN_FAIL"):
                self.ready = False
                return
            elif line.startswith("AGENT_DROPOUT"):
                involuntary = "involuntary=True" in line
                self.sink.event("dropout", entity=self.name, involuntary=involuntary, line=line)
                if self.on_dropout:
                    self.on_dropout(involuntary, line)

    def send(self, obj: dict):
        try:
            import json
            self.proc.stdin.write(json.dumps(obj) + "\n")
            self.proc.stdin.flush()
        except (BrokenPipeError, ValueError, AttributeError):
            pass

    def leave_graceful(self):
        """Ask the agent to hang up, then SIGTERM — a voluntary departure."""
        self.send({"cmd": "leave"})
        gevent.sleep(1.5)
        self._terminate(sig_kill=False)

    def leave_hard(self):
        """SIGKILL with no hangup — the sidecar/observer see an involuntary drop."""
        self._terminate(sig_kill=True)

    def _terminate(self, *, sig_kill: bool):
        if not self.proc:
            return
        try:
            if sig_kill:
                self.proc.kill()
            else:
                self.proc.terminate()
                for _ in range(16):
                    if self.proc.poll() is not None:
                        break
                    gevent.sleep(0.25)
                if self.proc.poll() is None:
                    self.proc.kill()
        except Exception:
            pass
        self.proc = None
        self.ready = False


class ChurnUser(User):
    """
    One slot in the churn pool (S5 / S6). Repeats: join (real browser) -> hold
    -> leave (a `involuntary_frac` share as SIGKILL) -> wait rejoin_delay -> rejoin.
    The pool-wide join+leave rate targets current_level() events/minute, so a
    single ChurnUser cycles every  pool / level * 60  seconds.
    """
    weight = 1
    wait_time = constant_pacing(1)

    def on_start(self):
        self.base_name = f"churn-{CTX.node}-{uuid.uuid4().hex[:6]}"
        self.sink = MetricSink(CTX, "churn")
        self.pool_size = max(1, _state.CHURN_POOL or SCEN.get("churn_pool", 8))
        self.involuntary_frac = float(SCEN.get("involuntary_frac", 0.35))
        self.rejoin_delay_range = SCEN.get("rejoin_delay_s", [3, 12])
        self._cycle = 0
        self._stop = False

    @task
    def churn_cycle(self):
        level = max(1, _state.current_level()) if CTX.scenario == "S5" \
            else max(1, SCEN.get("background_churn_per_min", 8))
        # pool-wide `level` events/min  ->  this slot's full cycle period
        cycle_period_s = max(8.0, self.pool_size / level * 60.0)
        alive_s = cycle_period_s * 0.6
        gone_s = max(self.rejoin_delay_range[0],
                     min(self.rejoin_delay_range[1], cycle_period_s - alive_s))

        self._cycle += 1
        agent_name = f"{self.base_name}.{self._cycle}"
        handle = MediaAgentHandle(agent_name, self.sink, on_dropout=self._on_dropout)
        joined_at = time.time()
        ok = handle.start(join_timeout_s=MEDIA.get("join_timeout_s", 45))
        join_ms = (time.time() - joined_at) * 1000
        events.request.fire(request_type="BROWSER", name="churn_join",
                            response_time=join_ms, response_length=0,
                            exception=None if ok else RuntimeError("join failed"))
        self.sink.event("churn_join", entity=agent_name, ok=ok, ms=join_ms, cycle=self._cycle)
        if not ok:
            handle.leave_hard()
            gevent.sleep(gone_s)
            return

        gevent.sleep(alive_s)

        involuntary = random.random() < self.involuntary_frac
        if involuntary:
            handle.leave_hard()
        else:
            handle.leave_graceful()
        self.sink.event("churn_leave", entity=agent_name, involuntary=involuntary,
                        lived_s=alive_s, cycle=self._cycle)
        gevent.sleep(gone_s)

    def _on_dropout(self, involuntary, line):
        events.request.fire(request_type="BROWSER", name="churn_dropout",
                            response_time=0, response_length=0,
                            exception=RuntimeError(line) if involuntary else None)

    def on_stop(self):
        self._stop = True
        self.sink.close()

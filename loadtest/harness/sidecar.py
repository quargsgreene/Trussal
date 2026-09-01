"""
Client for the Trussal latency sidecar  ( wss://<host>/ws?room=<r>&role=<role> ).

Protocol mirrored from latency-instrument/server.js and src/peer-state.js:

  <- welcome {peerId}
  -> hello {jitsiId, displayName, stableId?, isBot?, isAggregator?, ownerIndex?, isFleet?}
  <- roster {peers[], you}            <- crdt-state {updates[]}      <- nc-active {...}
  <- peer-join {peer}    <- peer-leave {peerId}    <- peer-update {peerId, patch}
  <- fleet-status {...}  <- crdt-update {update,...}  <- scss-compiled/scss-error
  <- remote-control {...}   <- pong {clientSentAt, rtt}

  -> pattern {code}      -> scss {source}       -> datapacks {packs[]}
  -> effects {state}     -> play | stop         -> metrics {rtt,jitter,packetLoss,...}
  -> crdt-update {update, snapshot?, modality?, channel?}
  -> fleet-request {action, count?, targets?, code?}
  -> sample-file {bank, name, data(b64)}    -> research-event {kind, data}
  -> ping {sentAt}

Works from a plain thread (collectors) and from a gevent greenlet (locust): it
uses websocket-client's blocking create_connection(), which yields to the hub
under monkey-patching.  Not a reconnecting client — a close is an observation
(ghost users and the observer report it; the campaign shape decides what a drop
means).
"""

from __future__ import annotations

import json
import threading
import time
import uuid
from typing import Callable

import websocket  # websocket-client

CONTROL_TOKEN_HEADER = "x-trussal-control-token"


class SidecarClient:
    def __init__(
        self,
        url: str,
        *,
        display_name: str = "loadtest",
        is_bot: bool = False,
        is_aggregator: bool = False,
        is_fleet: bool = False,
        owner_index: str | None = None,
        stable_id: str | None = None,
        control_token: str | None = None,
        on_event: Callable[[str, dict], None] | None = None,
        name: str | None = None,
    ):
        self.url = url
        self.name = name or display_name
        self.display_name = display_name
        self.is_bot = is_bot
        self.is_aggregator = is_aggregator
        self.is_fleet = is_fleet
        self.owner_index = owner_index
        # Humans carry a persistent stableId; give ghost users a fresh one each
        # session (matches a private-mode browser: fresh index path).
        self.stable_id = stable_id
        self.control_token = control_token
        self.on_event = on_event or (lambda kind, data: None)

        self.jitsi_id = f"lt-{uuid.uuid4()}"
        self.ws: websocket.WebSocket | None = None
        self.my_peer_id: str | None = None
        self.my_room_index: str | None = None
        self.peers: dict[str, dict] = {}          # peerId -> public view
        self.roster_ready = threading.Event()
        self.closed = threading.Event()
        self.close_code: int | None = None
        self.close_reason: str = ""

        # intentional-leave marker: set true just before we close on purpose, so
        # the observer can classify our disappearance.
        self.leaving_intentionally = False

        # RTT (app-plane, ws ping/pong to the sidecar)
        self._rtt_samples: list[float] = []
        self.rtt_ms: float | None = None
        self.jitter_ms: float | None = None

        self._send_lock = threading.Lock()
        self._reader: threading.Thread | None = None
        self._pinger: threading.Thread | None = None
        self._helloed = threading.Event()

    # ---------------- lifecycle ----------------
    def connect(self, timeout: float = 20.0) -> "SidecarClient":
        header = []
        if self.control_token:
            header.append(f"{CONTROL_TOKEN_HEADER}: {self.control_token}")
        self.ws = websocket.create_connection(
            self.url,
            timeout=timeout,
            header=header or None,
            enable_multithread=True,
            # accept the staging stack's self-signed cert
            sslopt={"cert_reqs": 0},
        )
        self._reader = threading.Thread(target=self._read_loop, name=f"sc-read-{self.name}", daemon=True)
        self._reader.start()
        self._pinger = threading.Thread(target=self._ping_loop, name=f"sc-ping-{self.name}", daemon=True)
        self._pinger.start()
        return self

    def wait_roster(self, timeout: float = 20.0) -> bool:
        return self.roster_ready.wait(timeout)

    def close(self, *, intentional: bool = True) -> None:
        self.leaving_intentionally = intentional
        self.closed.set()
        try:
            if self.ws:
                self.ws.close()
        except Exception:
            pass

    # ---------------- outbound ----------------
    def _send(self, obj: dict) -> None:
        if self.closed.is_set():
            return
        data = json.dumps(obj, separators=(",", ":"))
        with self._send_lock:
            try:
                self.ws.send(data)
            except Exception as e:  # a broken pipe is an observation, not a crash
                self.close_reason = self.close_reason or f"send-failed:{e!r}"
                self.close(intentional=False)

    def hello(self) -> None:
        msg = {
            "type": "hello",
            "jitsiId": self.jitsi_id,
            "displayName": self.display_name,
            "isBot": self.is_bot,
            "isAggregator": self.is_aggregator,
        }
        if self.is_fleet:
            msg["isFleet"] = True
        if self.is_bot and self.owner_index:
            msg["ownerIndex"] = str(self.owner_index)
        if not self.is_bot and self.stable_id:
            msg["stableId"] = self.stable_id
        self._send(msg)

    def send_pattern(self, code: str) -> None:
        self._send({"type": "pattern", "code": code})

    def send_scss(self, source: str) -> None:
        self._send({"type": "scss", "source": source})

    def send_datapacks(self, packs: list[dict]) -> None:
        self._send({"type": "datapacks", "packs": packs})

    def send_effects(self, distortion=False, noise=False, reverb=False) -> None:
        self._send({"type": "effects", "state": {"distortion": distortion, "noise": noise, "reverb": reverb}})

    def send_play(self, playing: bool = True) -> None:
        self._send({"type": "play" if playing else "stop"})

    def send_metrics(self, **fields) -> None:
        self._send({"type": "metrics", **fields})

    def send_crdt_update(self, update_b64: str, *, snapshot=False, modality="keyboard", channel="metaprogram") -> None:
        self._send({
            "type": "crdt-update", "update": update_b64,
            "snapshot": snapshot, "modality": modality, "channel": channel,
        })

    def send_fleet_request(self, action: str, *, count: int | None = None, targets=None, code: str | None = None) -> None:
        msg = {"type": "fleet-request", "action": action}
        if count is not None:
            msg["count"] = int(count)
        if targets is not None:
            msg["targets"] = targets
        if code is not None:
            msg["code"] = code
        self._send(msg)

    def send_sample_file(self, bank: str, name: str, data_b64: str) -> None:
        self._send({"type": "sample-file", "bank": bank, "name": name, "data": data_b64})

    def send_research_event(self, kind: str, data=None) -> None:
        self._send({"type": "research-event", "kind": kind, "data": data})

    # ---------------- inbound ----------------
    def _read_loop(self) -> None:
        try:
            while not self.closed.is_set():
                raw = self.ws.recv()
                if raw is None or raw == "":
                    continue
                try:
                    msg = json.loads(raw)
                except (ValueError, TypeError):
                    continue
                self._handle(msg)
        except websocket.WebSocketConnectionClosedException:
            self.close_reason = self.close_reason or "peer-closed"
        except OSError as e:
            self.close_reason = self.close_reason or f"os-error:{e!r}"
        except Exception as e:
            self.close_reason = self.close_reason or f"read-error:{e!r}"
        finally:
            try:
                self.close_code = getattr(self.ws, "close_code", None)
            except Exception:
                pass
            self.closed.set()
            self.on_event("disconnected", {
                "reason": self.close_reason,
                "code": self.close_code,
                "intentional": self.leaving_intentionally,
                "peerId": self.my_peer_id,
                "roomIndex": self.my_room_index,
            })

    def _handle(self, msg: dict) -> None:
        mt = msg.get("type")
        if mt == "welcome":
            self.my_peer_id = msg.get("peerId")
            self.hello()
            self._helloed.set()
        elif mt == "roster":
            for p in msg.get("peers", []) or []:
                if p.get("peerId"):
                    self.peers[p["peerId"]] = p
            you = msg.get("you") or {}
            if you.get("roomIndex") is not None:
                self.my_room_index = str(you["roomIndex"])
            self.roster_ready.set()
            self.on_event("roster", {"size": len(self.peers), "roomIndex": self.my_room_index})
        elif mt == "peer-join":
            p = msg.get("peer") or {}
            if p.get("peerId"):
                self.peers[p["peerId"]] = p
            self.on_event("peer-join", {"peer": p, "size": len(self.peers)})
        elif mt == "peer-leave":
            pid = msg.get("peerId")
            gone = self.peers.pop(pid, None)
            self.on_event("peer-leave", {"peerId": pid, "peer": gone, "size": len(self.peers)})
        elif mt == "peer-update":
            pid = msg.get("peerId")
            if pid in self.peers and isinstance(msg.get("patch"), dict):
                self.peers[pid].update(msg["patch"])
            self.on_event("peer-update", {"peerId": pid, "patch": msg.get("patch")})
        elif mt == "pong":
            sent = msg.get("clientSentAt")
            rtt = (time.time() * 1000 - sent) if isinstance(sent, (int, float)) else msg.get("rtt")
            if isinstance(rtt, (int, float)) and rtt >= 0:
                self._rtt_samples.append(rtt)
                self._rtt_samples = self._rtt_samples[-8:]
                mean = sum(self._rtt_samples) / len(self._rtt_samples)
                var = sum((x - mean) ** 2 for x in self._rtt_samples) / len(self._rtt_samples)
                self.rtt_ms = rtt
                self.jitter_ms = var ** 0.5
                self.on_event("rtt", {"rtt": rtt, "jitter": self.jitter_ms})
        elif mt == "fleet-status":
            self.on_event("fleet-status", msg)
        elif mt == "crdt-update":
            self.on_event("crdt-update", msg)
        elif mt == "crdt-state":
            self.on_event("crdt-state", {"count": len(msg.get("updates", []) or [])})
        elif mt == "nc-active":
            self.on_event("nc-active", {"token": msg.get("token"), "index": msg.get("index"), "kind": msg.get("kind")})
        elif mt == "scss-compiled":
            self.on_event("scss-compiled", {"bytes": len(msg.get("css", "") or "")})
        elif mt == "scss-error":
            self.on_event("scss-error", {"message": msg.get("message")})
        elif mt == "control-denied":
            self.close_reason = "control-denied"
            self.close(intentional=False)
        elif mt == "aggregator-claim-result":
            self.on_event("aggregator-claim-result", {"granted": bool(msg.get("granted"))})
        elif mt == "remote-control":
            self.on_event("remote-control", msg)
        # 'session-reset', others: ignored

    def _ping_loop(self) -> None:
        self._helloed.wait(10)
        while not self.closed.is_set():
            self._send({"type": "ping", "sentAt": time.time() * 1000})
            # broadcast our synthetic app-plane metrics too, like a real client
            if self.rtt_ms is not None:
                self.send_metrics(rtt=self.rtt_ms, jitter=self.jitter_ms or 0.0)
            for _ in range(20):
                if self.closed.is_set():
                    return
                time.sleep(0.1)

    # ---------------- helpers ----------------
    @property
    def roster_size(self) -> int:
        return len(self.peers)

    def peers_by_kind(self) -> dict[str, int]:
        out = {"human": 0, "bot": 0, "aggregator": 0}
        for p in self.peers.values():
            if p.get("isAggregator"):
                out["aggregator"] += 1
            elif p.get("isBot"):
                out["bot"] += 1
            else:
                out["human"] += 1
        return out

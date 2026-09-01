"""
Python front-end for tools/ymeta.mjs.

Holds one long-lived `node ymeta.mjs` subprocess and speaks its line protocol.
Give it program text, get back a base64 Yjs update to hand to
`SidecarClient.send_crdt_update(...)`. One `MetaprogramDoc` per editor user.

Thread-safe for a single writer (the MetaprogramEditorUser greenlet). Not
meant for concurrent callers — make one per user.
"""

from __future__ import annotations

import json
import subprocess
import threading
from pathlib import Path

_TOOL = Path(__file__).resolve().parent.parent / "tools" / "ymeta.mjs"


class MetaprogramDoc:
    def __init__(self, node_bin: str = "node"):
        if not _TOOL.exists():
            raise FileNotFoundError(_TOOL)
        self._p = subprocess.Popen(
            [node_bin, str(_TOOL)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        self._lock = threading.Lock()
        self._id = 0
        self.text = ""
        self._rpc({"cmd": "reset"})

    def _rpc(self, obj: dict) -> dict:
        with self._lock:
            self._id += 1
            obj = {"id": self._id, **obj}
            self._p.stdin.write(json.dumps(obj) + "\n")
            self._p.stdin.flush()
            line = self._p.stdout.readline()
            if not line:
                err = self._p.stderr.read()
                raise RuntimeError(f"ymeta.mjs died: {err.strip()[:400]}")
            res = json.loads(line)
            if not res.get("ok"):
                raise RuntimeError(f"ymeta error: {res.get('error')}")
            if "text" in res:
                self.text = res["text"]
            return res

    def set_text(self, text: str, *, snapshot: bool = False) -> dict | None:
        """Return {'update': b64, 'snapshot': bool, 'bytes': int} or None if unchanged."""
        res = self._rpc({"cmd": "settext", "text": text, "snapshot": snapshot})
        if not res.get("update"):
            return None
        return {"update": res["update"], "snapshot": res["snapshot"], "bytes": res["bytes"]}

    def snapshot(self) -> dict:
        res = self._rpc({"cmd": "snapshot"})
        return {"update": res["update"], "snapshot": True, "bytes": res["bytes"]}

    def apply_remote(self, update_b64: str) -> str:
        return self._rpc({"cmd": "apply_remote", "update": update_b64})["text"]

    def close(self) -> None:
        try:
            self._p.stdin.close()
            self._p.wait(timeout=5)
        except Exception:
            self._p.kill()


def build_program(participant_tokens: list[str], directives: str = "") -> str:
    """`$ participants < ... >` + trailing `#` directive lines."""
    seq = " ".join(str(t) for t in participant_tokens)
    lines = [f"$ participants <{seq}>"]
    if directives.strip():
        lines.extend(directives.strip().splitlines())
    return "\n".join(lines) + "\n"

#!/usr/bin/env python3
"""
Tiny config accessor for the bash orchestration scripts.

  cfg.py inv <inventory.yaml> <dotted.path>         -> value (scalar) or JSON
  cfg.py generators <inventory.yaml>                -> one TSV row per generator:
        name<TAB>ssh<TAB>iface<TAB>role_csv<TAB>media_browsers<TAB>ghost_ws<TAB>numa_nodes
  cfg.py netem-line <netem_profiles.yaml> <profile_id>
        -> "<delay> <jitter> <loss> <loss_corr> <reorder> <dup> <corrupt> <rate_down> <rate_up> <backlog>"
  cfg.py netem-handover <netem_profiles.yaml>
        -> "<base> <stall_min> <stall_max> <burst_loss> <burst_s> <every_min> <every_max>"
  cfg.py scenario <scenarios.yaml> <SID> <dotted.path>
  cfg.py matrix <scenarios.yaml>                    -> "profiles=... scenarios=... settle=..."
"""
import json
import sys

import yaml


def load(p):
    with open(p) as fh:
        return yaml.safe_load(fh)


def dig(d, path):
    cur = d
    for part in path.split("."):
        if part == "":
            continue
        if isinstance(cur, list):
            cur = cur[int(part)]
        else:
            cur = cur[part]
    return cur


def main(argv):
    mode = argv[0]
    if mode == "inv":
        v = dig(load(argv[1]), argv[2])
        print(v if isinstance(v, (str, int, float)) else json.dumps(v))
    elif mode == "targets":
        inv = load(argv[1])
        for name, spec in (inv.get("targets") or {}).items():
            print("\t".join([name, spec.get("host", "?"), spec.get("scheme", "https"),
                             spec.get("turn_mode", "")]))
    elif mode == "generators":
        inv = load(argv[1])
        for g in inv.get("generators", []):
            print("\t".join(str(x) for x in [
                g["name"], g["ssh"], g.get("iface", "eth0"),
                ",".join(g.get("role", [])), g.get("media_browsers", 0),
                g.get("ghost_ws", 0), g.get("numa_nodes", 1),
            ]))
    elif mode == "netem-line":
        prof = next(p for p in load(argv[1])["profiles"] if p["id"] == argv[2])
        print(" ".join(str(prof[k]) for k in [
            "delay_ms", "jitter_ms", "loss_pct", "loss_corr_pct", "reorder_pct",
            "dup_pct", "corrupt_pct", "rate_down_kbit", "rate_up_kbit", "backlog_pkts",
        ]))
    elif mode == "netem-handover":
        h = load(argv[1])["handover_overlay"]
        print(" ".join(str(h[k]) for k in [
            "base", "stall_ms_min", "stall_ms_max", "burst_loss_pct",
            "burst_duration_s", "stall_every_s_min", "stall_every_s_max",
        ]))
    elif mode == "scenario":
        scen = load(argv[1])["scenarios"]
        by_id = {v["id"]: v for v in scen.values()}
        v = dig(by_id[argv[2]], argv[3])
        print(v if isinstance(v, (str, int, float)) else json.dumps(v))
    elif mode == "matrix":
        m = load(argv[1])["matrix"]
        print(f"profiles={','.join(m['profiles'])} scenarios={','.join(m['scenarios'])} "
              f"settle={m.get('intercell_settle_s', 60)}")
    else:
        print(f"unknown mode {mode}", file=sys.stderr)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))

"""
Escalating "diverse media" payloads for scenario S4 (and the code-churn task of
HumanParticipantUser everywhere else).

`code_payload(kind, target_bytes, seed)` returns a string of ~target_bytes that
is plausible for that media kind, so the real bundle actually evaluates it and
the right server path is exercised:

  plain       s("...") / note("...")            — Strudel only
  samples     s("bank") sample-bank references  — needs the bank uploaded; here
                                                  we reference names the bots
                                                  ffmpeg-bed provides
  images      img("bank") inside a Hydra chain  — Hydra + image bank
  datapack    "Name:col" data-pack references   — pairs with send_datapacks()
  hydra       await initHydra( ... ) preamble   — Hydra code path (never gated)
  textcycles  await initTextCycles() + word(..) — chat-bubble renderer, silent
  csscycles   await initCss() + css(`...SCSS...`) — forces a sidecar SCSS compile

`build_datapack(name, rows, cols, seed)` builds a `datapacks` payload row within
the sidecar's caps (PACK_MAX_SAMPLES=64, PACK_MAX_VALUES_PER_SAMPLE=1024,
PACK_MAX_VALUES_TOTAL=16384, PACK_MAX_PACKS=32 — see sanitizeDataPacks()).
"""

from __future__ import annotations

import base64
import math
import random
import struct

KINDS = ["plain", "samples", "images", "datapack", "hydra", "textcycles", "csscycles"]

_NOTES = ["c3", "e3", "g3", "a3", "c4", "d4", "e4", "g4", "a4", "c5", "e5"]
_DRUMS = ["bd", "sd", "hh", "oh", "cp", "rim", "lt", "mt", "ht"]
_SAMPLE_BANKS = ["fieldrec", "vinyl", "metal", "voice", "glass", "water"]  # names the ffmpeg-bed provides
_IMG_BANKS = ["plates", "satellite", "textures", "faces"]
_DATA_NAMES = ["Weather", "Tides", "Seismic", "Traffic", "Pollen"]


def _pad_comment(s: str, target: int, seed: int) -> str:
    """Pad to ~target bytes with a trailing block comment of pseudo-random words."""
    if len(s) >= target:
        return s
    rng = random.Random(seed)
    words = ["cycle", "phase", "drift", "jitter", "detune", "swarm", "lattice",
             "aliasing", "harmonic", "granular", "feedback", "wavefold", "bitcrush"]
    pad = []
    while len(s) + len("\n/* " + " ".join(pad) + " */") < target:
        pad.append(rng.choice(words))
    return s + "\n/* " + " ".join(pad) + " */\n"


def _strudel_layers(rng: random.Random, n: int) -> list[str]:
    out = []
    for _ in range(n):
        if rng.random() < 0.5:
            seq = " ".join(rng.choice(_DRUMS) if rng.random() < 0.7 else "~" for _ in range(rng.randint(4, 12)))
            out.append(f's("{seq}")' + rng.choice(["", ".fast(2)", ".gain(0.7)", ".room(0.3)", ".jux(rev)"]))
        else:
            seq = " ".join(rng.choice(_NOTES) for _ in range(rng.randint(3, 9)))
            out.append(f'note("{seq}")' + rng.choice(["", ".s('sawtooth')", ".lpf(800)", ".slow(2)", ".add(12)"]))
    return out


def code_payload(kind: str, target_bytes: int, seed: int = 0) -> str:
    rng = random.Random(f"{seed}:{kind}:{target_bytes}")
    target = max(40, int(target_bytes))

    if kind == "plain":
        layers = _strudel_layers(rng, max(1, target // 120))
        body = "stack(\n  " + ",\n  ".join(layers) + "\n)" if len(layers) > 1 else layers[0]
        return _pad_comment(body, target, seed)

    if kind == "samples":
        banks = [rng.choice(_SAMPLE_BANKS) for _ in range(max(1, target // 200))]
        layers = [f's("{b}*{rng.randint(1,4)}").gain({round(rng.uniform(0.4,0.9),2)})' for b in banks]
        layers += _strudel_layers(rng, max(1, target // 300))
        body = "stack(\n  " + ",\n  ".join(layers) + "\n)"
        return _pad_comment(body, target, seed)

    if kind == "images":
        bank = rng.choice(_IMG_BANKS)
        body = (
            "await initHydra({detectAudio:false})\n"
            f'osc(10, 0.1, 0.8).modulate(noise(3)).diff(src(s0)).blend(solid(0,0,0,0.2))\n'
            f'  .add(shape(4).scale(1.5))\n'
            f'  .modulateScale(osc(2))\n'
            f'// img bank: {bank}\n'
            f's0.initImage && s0.initImage("{bank}")\n'
            "  .out(o0)\n"
        )
        return _pad_comment(body, target, seed)

    if kind == "datapack":
        name = rng.choice(_DATA_NAMES)
        cols = max(1, target // 250)
        refs = [f'"{name}:{c}"' for c in range(1, cols + 1)]
        body = (
            f'note(irand(8).segment(4).scale("C:minor"))\n'
            f'  .add(seq({", ".join(refs)}))\n'
            f'  .s("sawtooth").lpf(sine.range(200,2000))\n'
        )
        return _pad_comment(body, target, seed)

    if kind == "hydra":
        chain = ["await initHydra({detectAudio:false})"]
        ops = max(2, target // 90)
        expr = f"osc({rng.randint(2,40)}, {round(rng.uniform(0,0.3),3)}, {round(rng.uniform(0,2),2)})"
        for _ in range(ops):
            expr += rng.choice([
                f".rotate({round(rng.uniform(0,3.14),2)})",
                f".modulate(noise({rng.randint(1,6)}))",
                f".kaleid({rng.randint(3,8)})",
                f".color({round(rng.uniform(0,2),2)},{round(rng.uniform(0,2),2)},{round(rng.uniform(0,2),2)})",
                f".scale({round(rng.uniform(0.5,2),2)})",
                f".diff(shape({rng.randint(3,7)}))",
                f".repeat({rng.randint(2,5)},{rng.randint(2,5)})",
            ])
        chain.append(expr + ".out(o0)")
        return _pad_comment("\n".join(chain), target, seed)

    if kind == "textcycles":
        rng2 = random.Random(seed)
        words = " ".join(rng2.choice(["latency", "swarm", "phase", "drift", "signal",
                                      "packet", "cycle", "edge", "fade", "jitter"])
                          for _ in range(max(3, target // 40)))
        body = (
            "await initTextCycles()\n"
            f'word("{words}")\n'
            '  .typeface("<serif mono sans>")\n'
            '  .fontSize("<18 24 32>")\n'
            "  .slow(2)\n"
        )
        return _pad_comment(body, target, seed)

    if kind == "csscycles":
        # Benign SCSS that WILL compile (no display:none / zero-size / alpha:0 /
        # z-index / hiding filters — those are refused by the guardrails). Nests
        # and variables so the sidecar's sass compile does real work.
        rng2 = random.Random(seed)
        n = max(1, target // 220)
        blocks = []
        for i in range(n):
            hue = rng2.randint(0, 360)
            blocks.append(
                f"$h{i}: {hue};\n"
                f".ts-fx-{i} {{\n"
                f"  background: hsl(#{{$h{i}}}, 60%, 45%);\n"
                f"  border: 2px solid hsl(#{{$h{i} + 40}}, 50%, 35%);\n"
                f"  filter: saturate(1.2) hue-rotate(#{{$h{i}}}deg);\n"
                f"  transform: translateY(#{{$h{i} % 5}}px) rotate(#{{$h{i} % 7}}deg);\n"
                f"  opacity: 0.9;\n"
                f"  &:hover {{ background: hsl(#{{$h{i} + 120}}, 70%, 50%); }}\n"
                f"}}\n"
            )
        scss = "\n".join(blocks)
        body = "await initCss()\ncss(`\n" + scss + "`)\n"
        return _pad_comment(body, target, seed)

    raise ValueError(f"unknown kind {kind!r}")


def build_datapack(name: str, rows: int, cols: int, seed: int = 0) -> dict:
    """One `datapacks` payload row. rows<=64, cols<=1024, rows*cols<=16384."""
    rows = max(1, min(64, rows))
    cols = max(1, min(1024, cols))
    if rows * cols > 16384:
        cols = max(1, 16384 // rows)
    rng = random.Random(f"{seed}:{name}")
    samples = []
    for r in range(rows):
        base = rng.uniform(-1, 1)
        vals = [round(base + math.sin(c / 3.0) * 0.5 + rng.uniform(-0.1, 0.1), 4) for c in range(cols)]
        samples.append({"label": f"{name}-{r}", "values": vals, "truncated": False})
    return {"name": name, "kind": "csv", "samples": samples}


def fake_sample_wav_b64(seconds: float = 0.5, freq: float = 220.0, rate: int = 16000) -> str:
    """A tiny mono 16-bit PCM WAV, base64 — for `sample-file` payload load."""
    n = int(seconds * rate)
    frames = b"".join(
        struct.pack("<h", int(12000 * math.sin(2 * math.pi * freq * i / rate)))
        for i in range(n)
    )
    data_len = len(frames)
    header = b"RIFF" + struct.pack("<I", 36 + data_len) + b"WAVE"
    header += b"fmt " + struct.pack("<IHHIIHH", 16, 1, 1, rate, rate * 2, 2, 16)
    header += b"data" + struct.pack("<I", data_len)
    return base64.b64encode(header + frames).decode("ascii")

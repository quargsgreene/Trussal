# Metaprogram audio effects — impulse responses

Impulse response of each master-bus effect from `src/audio-net/av-effects/`,
rendered through the **real** `createRoomNode` / `createEchoNode` /
`createCrushNode` / `createNoiseNode` graphs in a Chrome `OfflineAudioContext`
at 48000 Hz. Regenerate with `node impulse-responses/measure.mjs`.

## Metric

**WCL** (worst-case one-way mouth-to-ear latency) drives every parameter of
every effect and is **pinned at 100 ms** (`metrics = { wcl: 100 }`). The echo
delay is written in cycles; the cycle grid is the metaprogram default
`# cycles "wcl" 20` → **2s** at WCL 100 ms, so it too is a
pure function of WCL.

## Method

- Unit-sample impulse → `node.input`; `node.output` → destination; offline render.
- `*.impulse-response.png` — time domain. For `room`/`echo` the 1.0-amplitude dry
  impulse is clipped so the reverb tail / echo taps are legible.
- `*.frequency-response.png` — magnitude spectrum: FFT of the impulse response,
  DC removed, normalised to the peak bin. `room`/`echo` are Hann-windowed (energy
  spread through the record; this also suppresses the flat-spectrum dry impulse);
  `crush` uses a rectangular window (its ring is a few samples — Hann’s `w[0]=0`
  would delete it); `noise` is a **Welch PSD** of the rendered output (a stochastic
  bed, not one transform).
- `noise` is **additive** — `input` passes straight through and the bed is summed
  on, so its impulse response is `δ + bed`; the spectrum plot characterises the bed.
- `crush` is a memoryless quantiser plus an SR-reduction lowpass; an impulse only
  excites the lowpass, so `crush.quantiser-transfer.png` shows the bit-depth
  nonlinearity directly (`makeCrushCurve`).
- `room` RT60 is the ISO 3382 **T20** estimator (least-squares slope of the
  Schroeder energy-decay curve over −5…−25 dB, from the reverb onset).
- `echo`'s wet path runs through a `DynamicsCompressor` limiter (~6 ms lookahead
  in Chrome), so taps land ~6 ms after each `n × delay`.

## Parameters at WCL = 100 ms

| effect | key parameters |
| --- | --- |
| room | RT60 `decayS` = 0.1s · lowpass 8182 Hz · wet 0.5 · comb fb [0.129,0.077,0.058,0.049] |
| crush | bitDepth 4 (16 steps) · srDivisor 2 → lowpass 12000 Hz · reduction 2 |
| noise | tilt 0.1 (brown) · 30 dB (gain 0.213) · mix brown 0.95 / pink 0.31 / white 0 |
| echo | delay 0.2s (0.1 cyc × 2s) · feedback 0.1 · wet 0.2 · echoGain 0.2 |

## Measured

- **room** — measured RT60 (T20, ISO 3382) ≈ 99.5 ms, early-decay ≈ 103.5 ms, both on the 100 ms `decayS = scale × wcl/1000` target. Cascaded 2nd-order lowpass 8182 Hz, wet 0.5. First reflections at the comb delays [29.7,37.1,41.1,43.7] ms.
- **echo** — taps at 206 ms (0.19694), 408.67 ms (0.02001).
- **crush** — SR-reduction lowpass −3 dB ≈ 14156 Hz (design corner Nyquist/2 = 12000 Hz); 16-step quantiser, IR settles to 0.
- **noise** — bed spectral slope ≈ -5.22 dB/oct (brown −6, pink −3, white 0); bed RMS -27.41 dB.

_generated 2026-09-01T09:04:57.427Z · Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36_

#!/usr/bin/env node
// Impulse-response measurement for the metaprogram's four master-bus audio
// effects — room, crush, noise, echo (src/audio-net/av-effects/).
//
// WHY A BROWSER STEP
//   createRoomNode / createEchoNode / createCrushNode / createNoiseNode build
//   real WebAudio graphs (DelayNode, BiquadFilterNode, WaveShaperNode,
//   DynamicsCompressorNode, AudioBufferSourceNode). Those exist only in a
//   browser, and the mix the room actually hears is rendered by a Chromium
//   aggregator — so the faithful place to measure them is an
//   OfflineAudioContext in Chrome, not a Node polyfill. This script does
//   everything else: it derives the parameters, bundles the real effect source
//   with the render/FFT/plot harness, serves it, and writes the plot images
//   the browser hands back.
//
// METRIC
//   WCL (worst-case one-way mouth-to-ear latency) is the driving metric for
//   every parameter of every effect, pinned at 100 ms:  metrics = { wcl: 100 }.
//   The echo's delay is written in CYCLES, and the cycle grid is the
//   metaprogram default `# cycles "wcl" 20`, so it too is a pure function of
//   WCL (2.0 s at 100 ms) and nothing else.
//
// USAGE
//   node impulse-responses/measure.mjs            # build + serve, wait for the browser
//   node impulse-responses/measure.mjs build      # just (re)build .build/ + harness.html
//   node impulse-responses/measure.mjs ingest x.json   # write plots from a saved result
//
//   Then, in a browser tab on an open meeting room, either open
//   http://127.0.0.1:8973/  (it runs itself and POSTs the result back), or
//   inject .build/harness.iife.js and run:
//       await TrussalIR.measureAll(await (await fetch('http://127.0.0.1:8973/config.json')).json())
//   then POST the return value to http://127.0.0.1:8973/ingest .
//
// OUTPUT   impulse-responses/<effect>/
//   <effect>.impulse-response.png     time domain
//   <effect>.frequency-response.png   magnitude spectrum (FFT; Welch PSD for noise)
//   crush.quantiser-transfer.png      crush's bit-depth nonlinearity (an impulse
//                                     only excites its SR-reduction lowpass)
//   <effect>.data.json               params + measured stats (readable)
//   <effect>.plot-data.json          decimated x/y series behind each PNG (compact)

import http from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

import { roomParams } from '../src/audio-net/av-effects/Room.js';
import { echoParams } from '../src/audio-net/av-effects/Echo.js';
import { crushParams } from '../src/audio-net/av-effects/Crush.js';
import { noiseParams } from '../src/audio-net/av-effects/Noise.js';
import { cycleLength } from '../src/audio-net/MetaprogramScheduler.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BUILD = join(HERE, '.build');
const HARNESS_SRC = join(HERE, 'src', 'harness.js');
const BUNDLE = join(BUILD, 'harness.iife.js');
const CONFIG_JSON = join(BUILD, 'config.json');
const HTML = join(HERE, 'harness.html');
const PORT = 8973;

const SAMPLE_RATE = 48000;
const WCL_MS = 100;

// --------------------------------------------------------------------------
// Parameter derivation — the real *Params functions, WCL pinned at 100 ms
// --------------------------------------------------------------------------

function computeConfig() {
  const metrics = { wcl: WCL_MS };

  // echo length is in cycles; the grid is the metaprogram default.
  const cyc = cycleLength({ cycles: { metric: 'wcl', factor: 20, fixed: null }, tempo: null, metrics });

  const room = roomParams(metrics, {}, 0);
  const crush = crushParams(metrics, {}, 0);
  // `# noise` names no metric by itself; ask for wcl on both axes (factor 1) so
  // WCL drives spectrum and volume, matching the other three.
  const noise = noiseParams(metrics, {
    spectrum: { metric: 'wcl', factor: 1 },
    volume: { metric: 'wcl', factor: 1 },
  });
  const echo = echoParams(metrics, {}, { cycleSeconds: cyc.seconds, cyclePos: 0 });

  return {
    sampleRate: SAMPLE_RATE,
    wclMs: WCL_MS,
    metric: 'wcl',
    metrics,
    cycle: { seconds: cyc.seconds, beats: cyc.beats, directive: '# cycles "wcl" 20' },
    effects: {
      room: { params: room, seconds: 1.0, impulseWindowMs: 400, spectrum: 'fft' },
      // crush's IR is a few-sample biquad ring; a Hann window would zero the
      // sample that carries it, so its spectrum uses a rectangular window.
      crush: { params: crush, seconds: 0.06, impulseWindowMs: 6, spectrum: 'fft', fftWindow: 'none' },
      noise: { params: noise, seconds: 2.0, impulseWindowMs: 40, spectrum: 'welch' },
      // echo's magnitude response is a fine feedback comb (teeth every 5 Hz) —
      // cap the axis at 2 kHz so individual teeth are visible; they continue to Nyquist.
      echo: { params: echo, seconds: 2.0, impulseWindowMs: 1000, spectrum: 'fft', freqXMax: 2000 },
    },
  };
}

function printConfig(cfg) {
  const j = (v) => JSON.stringify(v);
  console.log(`\nWCL pinned at ${cfg.wclMs} ms  (metrics = ${j(cfg.metrics)})`);
  console.log(`cycle grid   ${cfg.cycle.directive}  ->  ${cfg.cycle.seconds}s / ${cfg.cycle.beats} beats  (drives echo length)\n`);
  const p = cfg.effects;
  console.log('room   decayS %s  cutoffHz %s  wetGain %s\n       combFeedbacks %s',
    p.room.params.decayS, Math.round(p.room.params.cutoffHz), p.room.params.wetGain,
    j(p.room.params.combFeedbacks.map((v) => +v.toFixed(4))));
  console.log('crush  bitDepth %s  srDivisor %s  reduction %s  (%s quant steps, SR-lowpass %s Hz)',
    +p.crush.params.bitDepth.toFixed(4), p.crush.params.srDivisor, +p.crush.params.reduction.toFixed(4),
    Math.round(2 ** p.crush.params.bitDepth), Math.round(SAMPLE_RATE / 2 / p.crush.params.srDivisor));
  console.log('noise  tilt %s (%s)  gainDb %s  gain %s  mix %s',
    +p.noise.params.tilt.toFixed(4), p.noise.params.type, +p.noise.params.gainDb.toFixed(2),
    +p.noise.params.gain.toFixed(4),
    j({ brown: +p.noise.params.mix.brown.toFixed(3), pink: +p.noise.params.mix.pink.toFixed(3), white: +p.noise.params.mix.white.toFixed(3) }));
  console.log('echo   delayS %s  (%s cyc)  feedback %s  wetGain %s  echoGain %s\n',
    +p.echo.params.delayS.toFixed(4), +p.echo.params.lengthCycles.toFixed(4),
    +p.echo.params.feedback.toFixed(4), +p.echo.params.wetGain.toFixed(4), +p.echo.params.gain.toFixed(4));
}

// --------------------------------------------------------------------------
// Build
// --------------------------------------------------------------------------

async function buildBundle() {
  mkdirSync(BUILD, { recursive: true });
  await build({
    entryPoints: [HARNESS_SRC],
    bundle: true,
    format: 'iife',
    globalName: 'TrussalIR',
    platform: 'browser',
    target: ['es2020'],
    legalComments: 'none',
    outfile: BUNDLE,
    logLevel: 'warning',
  });
  const cfg = computeConfig();
  writeFileSync(CONFIG_JSON, JSON.stringify(cfg, null, 2));
  writeHtml(cfg);
  console.log(`built  ${BUNDLE}`);
  console.log(`       ${CONFIG_JSON}`);
  console.log(`       ${HTML}`);
  return cfg;
}

function writeHtml(cfg) {
  const html = `<!doctype html>
<meta charset="utf-8">
<title>Trussal effect impulse responses — WCL 100 ms</title>
<style>
  body{font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;margin:24px;color:#111827;background:#f9fafb}
  h1{font-size:18px} h2{font-size:15px;margin:28px 0 6px;text-transform:capitalize}
  img{display:block;border:1px solid #e5e7eb;background:#fff;max-width:100%;margin:6px 0}
  pre{background:#fff;border:1px solid #e5e7eb;padding:10px;overflow:auto;font-size:12px;max-height:280px}
  #status{padding:8px 12px;border-radius:6px;background:#eef2ff;display:inline-block;font-weight:600}
</style>
<h1>Metaprogram audio effects — impulse response @ WCL = 100&nbsp;ms</h1>
<p id="status">running…</p>
<div id="out"></div>
<script src="./harness.iife.js"></script>
<script>
const CONFIG = ${JSON.stringify(cfg)};
(async () => {
  const status = document.getElementById('status');
  const out = document.getElementById('out');
  try {
    const res = await TrussalIR.measureAll(CONFIG);
    for (const [name, eff] of Object.entries(res.effects)) {
      const h = document.createElement('h2'); h.textContent = name; out.appendChild(h);
      if (eff.error) { const p = document.createElement('pre'); p.textContent = eff.error; out.appendChild(p); continue; }
      for (const [key, url] of Object.entries(eff.plots)) {
        const img = document.createElement('img'); img.src = url; img.alt = name + ' ' + key; out.appendChild(img);
      }
      const pre = document.createElement('pre');
      pre.textContent = JSON.stringify({ params: eff.params, stats: eff.stats }, null, 2);
      out.appendChild(pre);
    }
    let tail = '';
    try {
      const r = await fetch('/ingest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(res) });
      tail = ' — ' + (r.ok ? (await r.json()).message : ('POST /ingest -> ' + r.status));
    } catch (e) {
      tail = ' — POST /ingest skipped (' + e + '); copy the JSON below into a file and run: node measure.mjs ingest <file>';
      const pre = document.createElement('pre'); pre.id = 'result-json'; pre.textContent = JSON.stringify(res); out.appendChild(pre);
    }
    status.textContent = 'done: ' + Object.keys(res.effects).join(', ') + tail;
    status.style.background = '#dcfce7';
  } catch (e) {
    status.textContent = 'error: ' + (e && e.stack || e);
    status.style.background = '#fee2e2';
  }
})();
</script>`;
  writeFileSync(HTML, html);
}

// --------------------------------------------------------------------------
// Ingest — write the plot images + data the browser produced
// --------------------------------------------------------------------------

function ingest(results, { outDir = HERE, quiet = false } = {}) {
  if (!results || !results.effects) throw new Error('ingest: expected { effects: {...} }');
  const written = [];
  const summary = [];
  for (const [name, eff] of Object.entries(results.effects)) {
    const dir = join(outDir, name);
    mkdirSync(dir, { recursive: true });
    if (eff.error) {
      const f = join(dir, `${name}.ERROR.txt`);
      writeFileSync(f, eff.error);
      written.push(f);
      summary.push({ effect: name, error: true });
      continue;
    }
    for (const [key, dataUrl] of Object.entries(eff.plots || {})) {
      const b64 = String(dataUrl).replace(/^data:image\/png;base64,/, '');
      const f = join(dir, `${name}.${key}.png`);
      writeFileSync(f, Buffer.from(b64, 'base64'));
      written.push(f);
    }
    // data.json — the human-facing summary (params + measured stats), pretty.
    const f = join(dir, `${name}.data.json`);
    writeFileSync(f, JSON.stringify({
      effect: name,
      wclMs: results.meta && results.meta.wclMs,
      metric: 'wcl',
      cycle: results.meta && results.meta.cycle,
      params: eff.params,
      stats: eff.stats,
      meta: results.meta || null,
    }, null, 2));
    written.push(f);
    // plot-data.json — the decimated x/y series behind each PNG, compact (one
    // line): useful for re-plotting or diffing values without a browser, but
    // thousands of numbers, so it stays out of the readable diff.
    const pf = join(dir, `${name}.plot-data.json`);
    writeFileSync(pf, JSON.stringify({ effect: name, sampleRate: eff.sampleRate, previews: eff.previews }));
    written.push(pf);
    summary.push({ effect: name, plots: Object.keys(eff.plots || {}), stats: eff.stats });
  }
  const readme = writeReadme(outDir, results, summary);
  written.push(readme);
  if (!quiet) {
    console.log(`\ningested ${Object.keys(results.effects).length} effect(s):`);
    for (const s of summary) {
      if (s.error) { console.log(`  ${s.effect.padEnd(6)} ERROR -> ${s.effect}/${s.effect}.ERROR.txt`); continue; }
      console.log(`  ${s.effect.padEnd(6)} -> ${s.plots.map((k) => `${s.effect}.${k}.png`).join(', ')}`);
    }
    console.log(`\n${written.length} files under ${outDir}\n`);
  }
  return written;
}

function writeReadme(outDir, results, summary) {
  const cfg = computeConfig();
  const p = cfg.effects;
  const s = (name) => (summary.find((x) => x.effect === name) || {}).stats || {};
  const lines = [];
  lines.push('# Metaprogram audio effects — impulse responses');
  lines.push('');
  lines.push('Impulse response of each master-bus effect from `src/audio-net/av-effects/`,');
  lines.push('rendered through the **real** `createRoomNode` / `createEchoNode` /');
  lines.push('`createCrushNode` / `createNoiseNode` graphs in a Chrome `OfflineAudioContext`');
  lines.push(`at ${cfg.sampleRate} Hz. Regenerate with \`node impulse-responses/measure.mjs\`.`);
  lines.push('');
  lines.push('## Metric');
  lines.push('');
  lines.push('**WCL** (worst-case one-way mouth-to-ear latency) drives every parameter of');
  lines.push('every effect and is **pinned at 100 ms** (`metrics = { wcl: 100 }`). The echo');
  lines.push('delay is written in cycles; the cycle grid is the metaprogram default');
  lines.push(`\`${cfg.cycle.directive}\` → **${cfg.cycle.seconds}s** at WCL 100 ms, so it too is a`);
  lines.push('pure function of WCL.');
  lines.push('');
  lines.push('## Method');
  lines.push('');
  lines.push('- Unit-sample impulse → `node.input`; `node.output` → destination; offline render.');
  lines.push('- `*.impulse-response.png` — time domain. For `room`/`echo` the 1.0-amplitude dry');
  lines.push('  impulse is clipped so the reverb tail / echo taps are legible.');
  lines.push('- `*.frequency-response.png` — magnitude spectrum: FFT of the impulse response,');
  lines.push('  DC removed, normalised to the peak bin. `room`/`echo` are Hann-windowed (energy');
  lines.push('  spread through the record; this also suppresses the flat-spectrum dry impulse);');
  lines.push('  `crush` uses a rectangular window (its ring is a few samples — Hann’s `w[0]=0`');
  lines.push('  would delete it); `noise` is a **Welch PSD** of the rendered output (a stochastic');
  lines.push('  bed, not one transform).');
  lines.push('- `noise` is **additive** — `input` passes straight through and the bed is summed');
  lines.push('  on, so its impulse response is `δ + bed`; the spectrum plot characterises the bed.');
  lines.push('- `crush` is a memoryless quantiser plus an SR-reduction lowpass; an impulse only');
  lines.push('  excites the lowpass, so `crush.quantiser-transfer.png` shows the bit-depth');
  lines.push('  nonlinearity directly (`makeCrushCurve`).');
  lines.push('- `room` RT60 is the ISO 3382 **T20** estimator (least-squares slope of the');
  lines.push('  Schroeder energy-decay curve over −5…−25 dB, from the reverb onset).');
  lines.push('- `echo`\'s wet path runs through a `DynamicsCompressor` limiter (~6 ms lookahead');
  lines.push('  in Chrome), so taps land ~6 ms after each `n × delay`.');
  lines.push('');
  lines.push('## Parameters at WCL = 100 ms');
  lines.push('');
  lines.push('| effect | key parameters |');
  lines.push('| --- | --- |');
  lines.push(`| room | RT60 \`decayS\` = ${p.room.params.decayS}s · lowpass ${Math.round(p.room.params.cutoffHz)} Hz · wet ${p.room.params.wetGain} · comb fb ${JSON.stringify(p.room.params.combFeedbacks.map((v) => +v.toFixed(3)))} |`);
  lines.push(`| crush | bitDepth ${+p.crush.params.bitDepth.toFixed(3)} (${Math.round(2 ** p.crush.params.bitDepth)} steps) · srDivisor ${p.crush.params.srDivisor} → lowpass ${Math.round(cfg.sampleRate / 2 / p.crush.params.srDivisor)} Hz · reduction ${+p.crush.params.reduction.toFixed(3)} |`);
  lines.push(`| noise | tilt ${+p.noise.params.tilt.toFixed(3)} (${p.noise.params.type}) · ${+p.noise.params.gainDb.toFixed(1)} dB (gain ${+p.noise.params.gain.toFixed(3)}) · mix brown ${+p.noise.params.mix.brown.toFixed(2)} / pink ${+p.noise.params.mix.pink.toFixed(2)} / white ${+p.noise.params.mix.white.toFixed(2)} |`);
  lines.push(`| echo | delay ${+p.echo.params.delayS.toFixed(3)}s (${+p.echo.params.lengthCycles.toFixed(3)} cyc × ${cfg.cycle.seconds}s) · feedback ${+p.echo.params.feedback.toFixed(3)} · wet ${+p.echo.params.wetGain.toFixed(3)} · echoGain ${+p.echo.params.gain.toFixed(3)} |`);
  lines.push('');
  lines.push('## Measured');
  lines.push('');
  const rt = s('room');
  lines.push(`- **room** — measured RT60 (T20, ISO 3382) ≈ ${rt.measuredRt60Ms ?? 'n/a'} ms, early-decay ≈ ${rt.measuredEarlyRt60Ms ?? 'n/a'} ms, both on the ${(p.room.params.decayS * 1000).toFixed(0)} ms \`decayS = scale × wcl/1000\` target. Cascaded 2nd-order lowpass ${Math.round(p.room.params.cutoffHz)} Hz, wet ${p.room.params.wetGain}. First reflections at the comb delays ${JSON.stringify(p.room.params.combDelaysS.map((d) => +(d * 1000).toFixed(1)))} ms.`);
  const ec = s('echo');
  if (ec.measuredTaps) lines.push(`- **echo** — taps at ${ec.measuredTaps.map((t) => `${t.ms} ms (${t.amp})`).join(', ')}.`);
  const cr = s('crush');
  lines.push(`- **crush** — SR-reduction lowpass −3 dB ≈ ${cr.measuredMinus3dBHz ?? 'n/a'} Hz (design corner Nyquist/${p.crush.params.srDivisor} = ${Math.round(cfg.sampleRate / 2 / p.crush.params.srDivisor)} Hz); ${cr.quantSteps}-step quantiser, IR settles to ${cr.settlesTo}.`);
  const no = s('noise');
  if (no.measuredSlopeDbPerOct != null) lines.push(`- **noise** — bed spectral slope ≈ ${no.measuredSlopeDbPerOct} dB/oct (brown −6, pink −3, white 0); bed RMS ${no.bedRmsDb} dB.`);
  lines.push('');
  lines.push(`_generated ${results.meta && results.meta.generatedAt || new Date().toISOString()} · ${results.meta && results.meta.userAgent || ''}_`);
  lines.push('');
  const f = join(outDir, 'README.md');
  writeFileSync(f, lines.join('\n'));
  return f;
}

// --------------------------------------------------------------------------
// Serve
// --------------------------------------------------------------------------

function serve(cfg) {
  const CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
  const routes = {
    '/harness.iife.js': () => [readFileSync(BUNDLE), 'text/javascript; charset=utf-8'],
    '/config.json': () => [Buffer.from(JSON.stringify(cfg)), 'application/json'],
    '/': () => [readFileSync(HTML), 'text/html; charset=utf-8'],
    '/index.html': () => [readFileSync(HTML), 'text/html; charset=utf-8'],
  };
  const keep = process.argv.includes('--keep');
  const server = http.createServer((req, res) => {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }
    const url = req.url.split('?')[0];
    if (req.method === 'GET' && routes[url]) {
      const [body, type] = routes[url]();
      res.writeHead(200, { ...CORS, 'content-type': type, 'cache-control': 'no-store' });
      return res.end(body);
    }
    if (req.method === 'POST' && url === '/ingest') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const results = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const w = ingest(results, {});
          res.writeHead(200, { ...CORS, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, message: `wrote ${w.length} files`, files: w }));
          console.log('\n✓ results ingested from the browser.');
          if (!keep) { server.close(); setTimeout(() => process.exit(0), 100); }
        } catch (e) {
          res.writeHead(400, { ...CORS, 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: String(e) }));
          console.error('ingest failed:', e);
        }
      });
      return;
    }
    res.writeHead(404, CORS);
    res.end('not found');
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\nimpulse-response harness on http://127.0.0.1:${PORT}`);
    console.log(`  standalone page:   http://127.0.0.1:${PORT}/`);
    console.log(`  bundle for inject: ${BUNDLE}`);
    console.log(`\nwaiting for POST /ingest …  (Ctrl-C to stop${keep ? '' : '; exits on first ingest, --keep to stay up'})\n`);
  });
  return server;
}

// --------------------------------------------------------------------------
// CLI
// --------------------------------------------------------------------------

const cmd = process.argv[2] || 'serve';
if (cmd === 'build') {
  const cfg = await buildBundle();
  printConfig(cfg);
} else if (cmd === 'ingest') {
  const file = process.argv[3];
  if (!file) { console.error('usage: node impulse-responses/measure.mjs ingest <results.json>'); process.exit(1); }
  ingest(JSON.parse(readFileSync(file, 'utf8')), {});
} else if (cmd === 'serve') {
  const cfg = await buildBundle();
  printConfig(cfg);
  serve(cfg);
} else {
  console.error(`unknown command: ${cmd}  (use: serve | build | ingest)`);
  process.exit(1);
}

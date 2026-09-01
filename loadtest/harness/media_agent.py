#!/usr/bin/env python3
"""
media_agent.py — ONE real Chromium participant in a Trussal room, with
RTCPeerConnection.getStats() polling.

Run as a subprocess by locust/locustfile.py (HumanParticipantUser) or standalone
for debugging. It joins exactly like bots/jitsi-bot.js (same URL fragment, same
`#trussal-studio-toggle` gesture, same `trussal-kbd-eval` start), then every
`--stats-interval` seconds reads getStats() off every RTCPeerConnection the page
created and emits one metric row per (pc, ssrc, direction) through
harness.common.MetricSink.

Media-plane metrics captured: outbound/inbound bitrate, frame rate, RTP jitter,
packet loss, RTT (candidate-pair + remote-inbound), freezes, NACK/PLI, jitter-
buffer delay. Plus join latency and ICE/connection-state transitions, from which
involuntary dropout is derived.

The Chromium process is deliberately outside the locust/gevent process.

Env (exported by run_campaign.sh): RUN_ID, PROFILE, SCENARIO, STEP_LEVEL,
TRUSSAL_HOST, TRUSSAL_SCHEME.
"""

from __future__ import annotations

import argparse
import json
import os
import queue
import signal
import sys
import threading
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from harness.common import MetricSink, RunContext  # noqa: E402

try:
    from playwright.sync_api import sync_playwright, Error as PWError
except ImportError:
    print("playwright not installed; run: pip install playwright && python -m playwright install chromium",
          file=sys.stderr)
    raise


# Injected before any page script: wrap RTCPeerConnection so we can find every
# PC and log its ICE/connection-state history.
PC_HOOK_JS = r"""
(() => {
  const Orig = window.RTCPeerConnection || window.webkitRTCPeerConnection;
  if (!Orig) return;
  window.__ltPCs = [];
  window.__ltIce = [];
  window.__ltConn = [];
  function Wrapped(...args) {
    const pc = new Orig(...args);
    window.__ltPCs.push(pc);
    pc.addEventListener('iceconnectionstatechange', () =>
      window.__ltIce.push({ t: Date.now(), state: pc.iceConnectionState }));
    pc.addEventListener('connectionstatechange', () =>
      window.__ltConn.push({ t: Date.now(), state: pc.connectionState }));
    return pc;
  }
  Wrapped.prototype = Orig.prototype;
  Object.defineProperty(Wrapped, 'name', { value: 'RTCPeerConnection' });
  window.RTCPeerConnection = Wrapped;
  if (window.webkitRTCPeerConnection) window.webkitRTCPeerConnection = Wrapped;
})();
"""

COLLECT_JS = r"""
async () => {
  const pcs = window.__ltPCs || [];
  const num = (v) => (typeof v === 'number' && isFinite(v)) ? v : null;
  const out = [];
  for (let i = 0; i < pcs.length; i++) {
    let report;
    try { report = await pcs[i].getStats(); } catch (e) { continue; }
    const rec = { pc: i, inbound: [], outbound: [], remoteInbound: [], cp: null };
    report.forEach((s) => {
      if (s.type === 'inbound-rtp') {
        rec.inbound.push({
          ssrc: s.ssrc, kind: s.kind || s.mediaType,
          bytesReceived: num(s.bytesReceived), packetsReceived: num(s.packetsReceived),
          packetsLost: num(s.packetsLost), jitter: num(s.jitter),
          framesPerSecond: num(s.framesPerSecond), framesDecoded: num(s.framesDecoded),
          framesDropped: num(s.framesDropped), freezeCount: num(s.freezeCount),
          totalFreezesDuration: num(s.totalFreezesDuration), pauseCount: num(s.pauseCount),
          totalPausesDuration: num(s.totalPausesDuration),
          jitterBufferDelay: num(s.jitterBufferDelay),
          jitterBufferEmittedCount: num(s.jitterBufferEmittedCount),
          nackCount: num(s.nackCount), pliCount: num(s.pliCount),
          frameWidth: num(s.frameWidth), frameHeight: num(s.frameHeight),
        });
      } else if (s.type === 'outbound-rtp') {
        rec.outbound.push({
          ssrc: s.ssrc, kind: s.kind || s.mediaType, rid: s.rid || null,
          bytesSent: num(s.bytesSent), packetsSent: num(s.packetsSent),
          framesPerSecond: num(s.framesPerSecond), framesEncoded: num(s.framesEncoded),
          frameWidth: num(s.frameWidth), frameHeight: num(s.frameHeight),
          qualityLimitationReason: s.qualityLimitationReason || null,
          nackCount: num(s.nackCount), pliCount: num(s.pliCount),
          totalPacketSendDelay: num(s.totalPacketSendDelay),
          retransmittedBytesSent: num(s.retransmittedBytesSent),
        });
      } else if (s.type === 'remote-inbound-rtp') {
        rec.remoteInbound.push({
          ssrc: s.ssrc, kind: s.kind || s.mediaType,
          roundTripTime: num(s.roundTripTime), fractionLost: num(s.fractionLost),
          packetsLost: num(s.packetsLost), jitter: num(s.jitter),
        });
      } else if (s.type === 'candidate-pair' && (s.nominated || s.state === 'succeeded')) {
        rec.cp = {
          currentRoundTripTime: num(s.currentRoundTripTime),
          availableOutgoingBitrate: num(s.availableOutgoingBitrate),
          availableIncomingBitrate: num(s.availableIncomingBitrate),
          bytesSent: num(s.bytesSent), bytesReceived: num(s.bytesReceived),
          state: s.state,
        };
      }
    });
    out.push(rec);
  }
  let confParticipants = null, confJoined = null;
  try {
    const c = window.APP && window.APP.conference;
    confJoined = !!(c && ((c.isJoined && c.isJoined()) || (c._room && c._room.isJoined && c._room.isJoined())));
    if (c && c._room && c._room.getParticipants) confParticipants = c._room.getParticipants().length;
  } catch (e) {}
  return { t: Date.now(), pcs: out, ice: window.__ltIce || [], conn: window.__ltConn || [],
           confParticipants, confJoined, hidden: document.hidden };
}
"""


class MediaAgent:
    def __init__(self, args):
        self.a = args
        self.ctx = RunContext.from_env()
        if args.host:
            self.ctx.host = args.host
        if args.scheme:
            self.ctx.scheme = args.scheme
        self.sink = MetricSink(self.ctx, "media_agent")
        self.entity = args.name
        self.stop = False
        self.intentional_leave = False
        self._prev = {}          # (pc,ssrc,dir) -> last raw counters + t
        self._ice_seen = 0
        self._conn_seen = 0
        self._dropped = False
        self._page = None
        self._cmdq: "queue.Queue[dict]" = queue.Queue()

    # -------- stdin command channel (locust HumanParticipantUser drives per-step behaviour) --------
    def _stdin_loop(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                self._cmdq.put(json.loads(line))
            except ValueError:
                pass

    def _drain_commands(self) -> None:
        while True:
            try:
                cmd = self._cmdq.get_nowait()
            except queue.Empty:
                return
            self._do_command(cmd)

    def _do_command(self, cmd: dict) -> None:
        c = cmd.get("cmd")
        if self._page is None:
            return
        try:
            if c == "eval":
                self._page.evaluate(
                    "(code) => document.dispatchEvent(new CustomEvent('trussal-kbd-eval', {detail:{code}}))",
                    cmd.get("code", ""),
                )
                self.sink.event("churn_eval", entity=self.entity, bytes=len(cmd.get("code", "")),
                                media=cmd.get("media", ""))
            elif c == "netcycles":
                self._page.evaluate(
                    "(text) => document.dispatchEvent(new CustomEvent('trussal-netcycles-program',"
                    " {detail:{text, modality:'keyboard'}}))",
                    cmd.get("text", ""),
                )
                if cmd.get("apply", True):
                    self._page.evaluate(
                        "() => document.dispatchEvent(new CustomEvent('trussal-netcycles-apply'))"
                    )
                self.sink.event("metaprogram_edit", entity=self.entity,
                                tokens=cmd.get("tokens", -1), bytes=len(cmd.get("text", "")))
            elif c == "effects":
                # no DOM hook — toggle via the studio checkboxes if present
                self._page.evaluate(
                    "(st) => { const q = (s)=>document.querySelector(s);"
                    " for (const [k,sel] of Object.entries({distortion:'.ts-fx-distortion',"
                    " noise:'.ts-fx-noise',reverb:'.ts-fx-reverb'})) {"
                    " const el = q(sel); if (el && !!el.checked !== !!st[k]) el.click(); } }",
                    cmd.get("state", {}),
                )
            elif c == "leave":
                self.stop = True
                self.intentional_leave = True
        except PWError as e:
            self.sink.event("command_failed", entity=self.entity, cmd=c, reason=str(e)[:160])

    # -------- lifecycle --------
    def run(self) -> int:
        signal.signal(signal.SIGTERM, self._on_sig)
        signal.signal(signal.SIGINT, self._on_sig)
        url = (f"{self.ctx.scheme}://{self.ctx.host}/{self.a.room}"
               f"#config.prejoinPageEnabled=false&userInfo.displayName={self.entity}")
        launch_args = [
            "--no-sandbox", "--disable-setuid-sandbox",
            "--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream",
            "--autoplay-policy=no-user-gesture-required",
            "--disable-features=WebRtcHideLocalIpsWithMdns",
            "--disable-gpu", "--disable-dev-shm-usage",
        ]
        if self.a.seed_video and Path(self.a.seed_video).exists():
            launch_args.append(f"--use-file-for-fake-video-capture={self.a.seed_video}")
        if self.a.seed_audio and Path(self.a.seed_audio).exists():
            launch_args.append(f"--use-file-for-fake-audio-capture={self.a.seed_audio}")

        t_start = time.time()
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True, args=launch_args)
            context = browser.new_context(
                permissions=["camera", "microphone"],
                ignore_https_errors=True,
                viewport={"width": 900, "height": 640},
            )
            context.add_init_script(PC_HOOK_JS)
            page = context.new_page()
            self._page = page
            page.on("pageerror", lambda e: None)
            threading.Thread(target=self._stdin_loop, name="agent-stdin", daemon=True).start()

            try:
                page.goto(url, timeout=self.a.join_timeout * 1000, wait_until="domcontentloaded")
                self._prejoin_fallback(page)
                page.wait_for_function(
                    "() => { try { const c = window.APP && window.APP.conference;"
                    " return !!(c && ((c.isJoined && c.isJoined()) ||"
                    " (c._room && c._room.isJoined && c._room.isJoined()))); } catch(e){ return false; } }",
                    timeout=self.a.join_timeout * 1000, polling=1000,
                )
                page.wait_for_selector("#trussal-studio-toggle", timeout=15000)
                page.click("#trussal-studio-toggle")
                join_ms = (time.time() - t_start) * 1000
                self.sink.event("join", entity=self.entity, value=join_ms)
                print(f"AGENT_READY {join_ms:.0f}", flush=True)
            except PWError as e:
                self.sink.event("join_failed", entity=self.entity, value=(time.time() - t_start) * 1000,
                                reason=str(e)[:200])
                print(f"AGENT_JOIN_FAIL {str(e)[:160]}", flush=True)
                try:
                    browser.close()
                finally:
                    self.sink.close()
                return 2

            time.sleep(2.0)
            if self.a.strudel_on:
                pattern = self.a.pattern or 's("bd ~ sd ~").bank("RolandTR909")'
                page.evaluate(
                    "(code) => document.dispatchEvent(new CustomEvent('trussal-kbd-eval', {detail:{code}}))",
                    pattern,
                )
                self.sink.event("strudel_start", entity=self.entity)
            if self.a.hydra:
                page.evaluate(
                    "(code) => document.dispatchEvent(new CustomEvent('trussal-kbd-eval', {detail:{code}}))",
                    "await initHydra({detectAudio:false})\nosc(20,0.1,0.9).rotate(0.3).out(o0)",
                )

            deadline = time.time() + self.a.duration if self.a.duration > 0 else float("inf")
            interval = self.a.stats_interval
            while not self.stop and time.time() < deadline:
                loop_t = time.time()
                self._drain_commands()
                if self.stop:
                    break
                try:
                    data = page.evaluate(COLLECT_JS)
                    self._ingest(data)
                except PWError as e:
                    # page/browser gone mid-run and we didn't ask it to → involuntary
                    self._emit_dropout(involuntary=not self.intentional_leave,
                                       reason=f"evaluate-failed:{str(e)[:120]}")
                    break
                sleep = interval - (time.time() - loop_t)
                if sleep > 0:
                    time.sleep(sleep)

            # graceful leave
            self.intentional_leave = True
            try:
                page.evaluate(
                    "() => { try { const c = window.APP && window.APP.conference;"
                    " if (c && c.hangup) return c.hangup(true);"
                    " if (c && c._room && c._room.leave) return c._room.leave(); } catch(e){} }"
                )
                time.sleep(1.0)
            except PWError:
                pass
            self.sink.event("agent_exit", entity=self.entity, intentional=True)
            try:
                browser.close()
            except PWError:
                pass
        self.sink.close()
        return 0

    # -------- helpers --------
    def _on_sig(self, *_):
        self.stop = True
        self.intentional_leave = True

    def _prejoin_fallback(self, page):
        try:
            page.wait_for_selector('[class*="premeeting"], [class*="prejoin"]', timeout=4000)
            page.evaluate(
                "() => { const b = Array.from(document.querySelectorAll('button,[role=\"button\"]'))"
                ".find(e => /join/i.test(e.textContent) || /join/i.test(e.getAttribute('aria-label')||''));"
                " b && b.click(); }"
            )
        except PWError:
            pass

    def _emit_dropout(self, involuntary: bool, reason: str):
        if self._dropped:
            return
        self._dropped = True
        self.sink.event("dropout", entity=self.entity, value=1,
                        involuntary=involuntary, reason=reason)
        print(f"AGENT_DROPOUT involuntary={involuntary} {reason}", flush=True)

    def _ingest(self, data: dict):
        now = time.time()
        # ICE / connection state history (only new entries)
        for row in data.get("ice", [])[self._ice_seen:]:
            self.sink.event("ice_state", entity=self.entity, state=row["state"])
            if row["state"] in ("failed", "disconnected", "closed"):
                self._emit_dropout(involuntary=not self.intentional_leave,
                                   reason=f"ice:{row['state']}")
        self._ice_seen = len(data.get("ice", []))
        for row in data.get("conn", [])[self._conn_seen:]:
            self.sink.event("conn_state", entity=self.entity, state=row["state"])
            if row["state"] == "failed":
                self._emit_dropout(involuntary=not self.intentional_leave, reason="conn:failed")
        self._conn_seen = len(data.get("conn", []))

        if data.get("confParticipants") is not None:
            self.sink.sample("conf_participants", data["confParticipants"], entity=self.entity)
        if data.get("confJoined") is False and not self.intentional_leave:
            self._emit_dropout(involuntary=True, reason="conf_left")

        tot = {"in_kbps": 0.0, "out_kbps": 0.0}
        for rec in data.get("pcs", []):
            pc = rec["pc"]
            for s in rec.get("inbound", []):
                self._rate_row(pc, s.get("ssrc"), "in", s.get("kind"), now, {
                    "bytes": s.get("bytesReceived"), "packets": s.get("packetsReceived"),
                    "lost": s.get("packetsLost"), "frames": s.get("framesDecoded"),
                    "freeze_s": s.get("totalFreezesDuration"), "jb_delay": s.get("jitterBufferDelay"),
                    "jb_emitted": s.get("jitterBufferEmittedCount"),
                }, s, tot)
            for s in rec.get("outbound", []):
                self._rate_row(pc, f"{s.get('ssrc')}/{s.get('rid') or ''}", "out", s.get("kind"), now, {
                    "bytes": s.get("bytesSent"), "packets": s.get("packetsSent"),
                    "frames": s.get("framesEncoded"),
                }, s, tot)
            for s in rec.get("remoteInbound", []):
                if s.get("roundTripTime") is not None:
                    self.sink.sample("rtt_remote_ms", s["roundTripTime"] * 1000.0,
                                     entity=self.entity, pc=pc, kind=s.get("kind"))
                if s.get("fractionLost") is not None:
                    self.sink.sample("fraction_lost", s["fractionLost"],
                                     entity=self.entity, pc=pc, kind=s.get("kind"))
            cp = rec.get("cp")
            if cp:
                if cp.get("currentRoundTripTime") is not None:
                    self.sink.sample("rtt_ms", cp["currentRoundTripTime"] * 1000.0, entity=self.entity, pc=pc)
                if cp.get("availableOutgoingBitrate") is not None:
                    self.sink.sample("bwe_out_kbps", cp["availableOutgoingBitrate"] / 1000.0,
                                     entity=self.entity, pc=pc)
                if cp.get("availableIncomingBitrate") is not None:
                    self.sink.sample("bwe_in_kbps", cp["availableIncomingBitrate"] / 1000.0,
                                     entity=self.entity, pc=pc)
        self.sink.sample("bitrate_in_kbps_total", round(tot["in_kbps"], 2), entity=self.entity)
        self.sink.sample("bitrate_out_kbps_total", round(tot["out_kbps"], 2), entity=self.entity)

    def _rate_row(self, pc, ssrc, direction, kind, now, cur, raw, tot):
        key = (pc, str(ssrc), direction)
        prev = self._prev.get(key)
        self._prev[key] = {**cur, "t": now}
        if not prev:
            return
        dt = now - prev["t"]
        if dt <= 0:
            return

        def d(field):
            a, b = prev.get(field), cur.get(field)
            return (b - a) if (a is not None and b is not None and b >= a) else None

        db = d("bytes")
        if db is not None:
            kbps = db * 8 / dt / 1000.0
            self.sink.sample(f"bitrate_{direction}_kbps", round(kbps, 2),
                             entity=self.entity, pc=pc, kind=kind, ssrc=str(ssrc))
            tot[f"{direction}_kbps"] += kbps

        # frame rate: prefer the reported instantaneous fps, else derive
        fps = raw.get("framesPerSecond")
        df = d("frames")
        if fps is None and df is not None:
            fps = df / dt
        if fps is not None and kind == "video":
            self.sink.sample(f"fps_{direction}", round(fps, 2),
                             entity=self.entity, pc=pc, ssrc=str(ssrc))

        if direction == "in":
            dl, dp = d("lost"), d("packets")
            if dl is not None and dp is not None and (dl + dp) > 0:
                self.sink.sample("packet_loss_frac", dl / (dl + dp),
                                 entity=self.entity, pc=pc, kind=kind, ssrc=str(ssrc))
            if raw.get("jitter") is not None:
                self.sink.sample("jitter_ms", raw["jitter"] * 1000.0,
                                 entity=self.entity, pc=pc, kind=kind, ssrc=str(ssrc))
            dfz = d("freeze_s")
            if dfz is not None and kind == "video":
                self.sink.sample("freeze_seconds_rate", dfz / dt, entity=self.entity, pc=pc, ssrc=str(ssrc))
            if raw.get("freezeCount") is not None and kind == "video":
                self.sink.sample("freeze_count", raw["freezeCount"], entity=self.entity, pc=pc, ssrc=str(ssrc))
            jbd, jbe = d("jb_delay"), d("jb_emitted")
            if jbd is not None and jbe and jbe > 0:
                self.sink.sample("jitter_buffer_ms", jbd / jbe * 1000.0,
                                 entity=self.entity, pc=pc, kind=kind, ssrc=str(ssrc))


def parse_args(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--room", required=True)
    p.add_argument("--name", required=True)
    p.add_argument("--host", default=os.environ.get("TRUSSAL_HOST"))
    p.add_argument("--scheme", default=os.environ.get("TRUSSAL_SCHEME", "https"))
    p.add_argument("--duration", type=float, default=0, help="seconds; 0 = until SIGTERM")
    p.add_argument("--stats-interval", type=float, default=2.0)
    p.add_argument("--join-timeout", type=float, default=45.0)
    p.add_argument("--video-height", type=int, default=240)
    p.add_argument("--fps", type=int, default=15)
    p.add_argument("--strudel-on", action="store_true")
    p.add_argument("--hydra", action="store_true")
    p.add_argument("--pattern", default="")
    p.add_argument("--seed-video", default=os.environ.get("LT_SEED_VIDEO", ""))
    p.add_argument("--seed-audio", default=os.environ.get("LT_SEED_AUDIO", ""))
    return p.parse_args(argv)


if __name__ == "__main__":
    sys.exit(MediaAgent(parse_args()).run())

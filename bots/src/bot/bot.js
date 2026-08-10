/**
 * The Bot: one headless Chromium joining Jitsi with a Hydra camera and
 * playing varied Strudel audio out through the ALSA loopback.
 *
 * Dependency injection: the Puppeteer launcher is a constructor option so
 * unit tests drive the full lifecycle with fakes (no Chromium on the test
 * host), and the container entrypoint passes the real puppeteer-core. Same
 * reason `puppeteer-core` is only imported lazily in index.js, never here.
 */

import { INIT_HYDRA_PATTERN } from '../../../src/hydra-code.js';
import { INIT_TEXT_CYCLES_PATTERN, WORD_CALL_RE } from '../../../src/text-cycles-core.js';
import { INIT_CSS_PATTERN, CSS_CALL_RE } from '../../../src/css-cycles-core.js';
import { browserLaunchOptions, spoofedUserAgent, jitsiRoomUrl } from './chromium-args.js';
import {
  pageAudioBridge, pageForcePreserveDrawingBuffer, pageGumOverride, pageStrudelBoot,
  pageEnsureAudioPublished, pageInstallVideoPublisher, pageFpsSampler, pageReadSamples,
  pageMarkBot, pageRemoteControl,
} from './page-scripts.js';

export class Bot {
  /**
   * @param {object} cfg  { botId, name, jitsiUrl, script: {strudel, hydra, entryDelayMs}, executablePath? }
   * @param {object} deps { launcher } — anything with launch(opts) → browser
   */
  constructor(cfg, { launcher } = {}) {
    if (!launcher) throw new TypeError('a puppeteer-compatible launcher is required');
    this.cfg = cfg;
    this.launcher = launcher;
    this.browser = null;
    this.page = null;
  }

  async start() {
    const { botId, name, jitsiUrl, script, executablePath, bandwidth = {}, ownerIndex } = this.cfg;

    // Launch config (and the rolling-Chromium-150 workaround) lives in
    // browserLaunchOptions so the build-time smoke test (docker/verify-launch.mjs)
    // exercises the exact same config the bot runs with.
    this.browser = await this.launcher.launch(browserLaunchOptions(executablePath));
    this.page = await this.browser.newPage();
    await this.page.setUserAgent(spoofedUserAgent(botId));

    // Must be installed before navigation: Jitsi enumerates devices on load.
    // pageMarkBot first — it sets window.__trussalIsBot before the Trussal bundle
    // loads, so peer-state announces this peer as a bot (studio can drive/mute it).
    await this.page.evaluateOnNewDocument(pageMarkBot, typeof ownerIndex === 'string' ? ownerIndex : '');
    // pageAudioBridge next — it creates window.__trussalMicStream, which the
    // getUserMedia override hands Jitsi as the bot's microphone.
    await this.page.evaluateOnNewDocument(pageAudioBridge);
    // Operator control (studio edit/mute) → re-eval the REPL / mute the fan.
    // The capability rules travel as JSON because page scripts are function
    // bodies puppeteer serialises — they cannot import the modules that own
    // them, so the bot hands them over rather than letting the page re-type
    // them and drift from the browser's answer.
    await this.page.evaluateOnNewDocument(pageRemoteControl, [
      INIT_HYDRA_PATTERN,
      INIT_TEXT_CYCLES_PATTERN,
    ], {
      // Same reasoning, same JSON-only constraint: the bot's own REPL is bare
      // vanilla Strudel (see pageStrudelBoot), so word()/css() and their init
      // calls are undefined there. cluster-source.js strips these from a
      // bot's GENERATED script before it ever reaches this REPL
      // (dropTextStatements/dropCssStatements) — pageRemoteControl needs the
      // same patterns to do the same strip on a manually-pushed edit.
      word: { source: WORD_CALL_RE.source, flags: WORD_CALL_RE.flags },
      css: { source: CSS_CALL_RE.source, flags: CSS_CALL_RE.flags },
      initTextCycles: INIT_TEXT_CYCLES_PATTERN,
      initCss: INIT_CSS_PATTERN,
    });
    // Before Hydra creates its WebGL canvas, so captureStream of it isn't blank.
    await this.page.evaluateOnNewDocument(pageForcePreserveDrawingBuffer);
    await this.page.evaluateOnNewDocument(pageGumOverride, bandwidth.captureFps ?? 15, bandwidth.videoHeight ?? 360);
    await this.page.evaluateOnNewDocument(pageInstallVideoPublisher);
    await this.page.evaluateOnNewDocument(pageFpsSampler);

    // networkidle2 instead of domcontentloaded: Jitsi keeps performing
    // client-side navigations while joining, and each one destroys the
    // page's execution context.
    //
    // Video off on arrival, like every other non-aggregator participant: the
    // room's visuals come from the aggregator's mosaic, and a bot's own tile
    // stays dark until its owner turns it on (the 'video' remote-control
    // action, handled in-page by pageRemoteControl).
    await this.page.goto(jitsiRoomUrl(jitsiUrl, name, { ...bandwidth, videoMuted: true }), {
      waitUntil: 'networkidle2',
      timeout: 60000,
    });
    // Belt and braces: wait until Jitsi's app object exists (i.e. the SPA
    // has settled). Optional — older/customized Jitsi builds may differ.
    if (this.page.waitForFunction) {
      await this.page
        .waitForFunction(() => globalThis.APP !== undefined, { timeout: 30000 })
        .catch(() => {});
    }

    // Staggered-round entry (role 2): wait this bot's WCL-subdivision offset
    // before making any sound or visuals.
    if (script.entryDelayMs > 0) {
      await new Promise((r) => setTimeout(r, script.entryDelayMs));
    }
    await this.#bootStrudel(script);
    // Publish the Strudel tap as the mic and the Hydra canvas as the camera —
    // startWith*Muted=false alone doesn't give a headless bot either track, so
    // drive jitsi-meet explicitly. Don't swallow the .catch: a failed publish is
    // exactly the "bot streams silence" bug (pageEnsureAudioPublished also
    // logs+throws internally), so surface it.
    await this.page.evaluate(pageEnsureAudioPublished)
      .catch((e) => console.error('[bot] pageEnsureAudioPublished failed', e));
    // No video publish here: the bot joins dark and its owner toggles it on.
  }

  /**
   * Inject the Strudel REPL, retrying once if a late Jitsi navigation
   * destroys the execution context between our readiness check and the
   * evaluate call.
   */
  async #bootStrudel(script, attempt = 0) {
    try {
      await this.page.evaluate(pageStrudelBoot, {
        strudel: script.strudel,
        hydra: script.hydra,
        // What gets announced to peer-state differs from what this REPL
        // evaluates whenever textParrot/cssParrot kept a word()/css() voice
        // this REPL can't run — see cluster-source.js's botScriptFor. Any
        // generated word() voice of the bot's own is already folded in here
        // too, never into `strudel` — that REPL can't run it either.
        announceStrudel: script.announceStrudel ?? script.strudel,
        samples: this.cfg.samples || {},
      });
    } catch (err) {
      if (attempt === 0 && /context was destroyed/i.test(String(err.message))) {
        await new Promise((r) => setTimeout(r, 3000));
        return this.#bootStrudel(script, 1);
      }
      throw err;
    }
  }

  /**
   * One metrics sample for the conductor: RAM from CDP, fps + runtime eval
   * errors from the page, latency measured by the caller's HTTP reporter
   * (round-trip of the previous POST).
   */
  async sampleMetrics() {
    const [cdp, page] = await Promise.all([
      this.page.metrics(),
      this.page.evaluate(pageReadSamples),
    ]);
    return {
      botId: this.cfg.botId,
      name: this.cfg.name,
      ramBytes: cdp.JSHeapUsedSize ?? 0,
      fps: page?.fps ?? 0,
      errors: page?.errors ?? [],
      diag: page?.diag ?? null,
      at: Date.now(),
    };
  }

  async stop() {
    // Leave the Jitsi conference EXPLICITLY before tearing down the browser, so
    // the XMPP unavailable-presence actually reaches prosody. browser.close()
    // alone kills Chromium before the page's unload leave can complete its
    // network round-trip, leaving a ghost session that keeps the room alive
    // (meetings then can't be ended). Best-effort: a torn-down/absent page just
    // falls through to the close. Prefer the room's own leave(); fall back to the
    // meet wrapper's hangup().
    if (this.page && typeof this.page.evaluate === 'function') {
      await this.page.evaluate(() => {
        const conf = window.APP && window.APP.conference;
        const room = conf && (conf._room || conf.room);
        if (room && typeof room.leave === 'function') return room.leave();
        if (conf && typeof conf.hangup === 'function') return conf.hangup();
      }).catch((e) => console.error(`[bot] conference leave before stop failed: ${e.message}`));
    }
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.page = null;
  }
}

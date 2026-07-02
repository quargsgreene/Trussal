/**
 * The Bot: one headless Chromium joining Jitsi with a Hydra camera and
 * playing varied Strudel audio out through the ALSA loopback.
 *
 * Dependency injection: the Puppeteer launcher is a constructor option so
 * unit tests drive the full lifecycle with fakes (no Chromium on the test
 * host), and the container entrypoint passes the real puppeteer-core. Same
 * reason `puppeteer-core` is only imported lazily in index.js, never here.
 */

import { chromiumArgs, spoofedUserAgent, jitsiRoomUrl } from './chromium-args.js';
import {
  pageAudioBridge, pageForcePreserveDrawingBuffer, pageGumOverride, pageStrudelBoot,
  pageEnsureAudioPublished, pageEnsureVideoPublished, pageFpsSampler, pageReadSamples,
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

    this.browser = await this.launcher.launch({
      // headless: false — Xvfb is already running per bot (entrypoint sets
      // DISPLAY=:9N). headless:'new' routes Web Audio to a null Ozone sink;
      // non-headless X11 mode falls through to ALSA, which is the path to
      // the loopback → JACK → Jamulus chain.
      headless: false,
      executablePath,
      args: chromiumArgs(),
      ignoreDefaultArgs: ['--mute-audio'],
    });
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
    await this.page.evaluateOnNewDocument(pageRemoteControl);
    // Before Hydra creates its WebGL canvas, so captureStream of it isn't blank.
    await this.page.evaluateOnNewDocument(pageForcePreserveDrawingBuffer);
    await this.page.evaluateOnNewDocument(pageGumOverride, bandwidth.captureFps ?? 15);
    await this.page.evaluateOnNewDocument(pageFpsSampler);

    // networkidle2 instead of domcontentloaded: Jitsi keeps performing
    // client-side navigations while joining, and each one destroys the
    // page's execution context.
    await this.page.goto(jitsiRoomUrl(jitsiUrl, name, bandwidth), {
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
    // startWithAudioMuted=false alone doesn't reliably give a headless bot a
    // published audio track; explicitly publish the Strudel tap as the mic.
    await this.page.evaluate(pageEnsureAudioPublished).catch(() => {});
    // Likewise, jitsi-meet never requests the camera headlessly, so explicitly
    // publish the Hydra canvas stream as the bot's video.
    await this.page.evaluate(pageEnsureVideoPublished).catch(() => {});
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
    if (this.browser) await this.browser.close();
    this.browser = null;
    this.page = null;
  }
}

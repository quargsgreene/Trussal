// Build-time launch guard.
//
// Debian bookworm ships a ROLLING Chromium; each bump can outpace the pinned
// puppeteer-core and make Chromium abort instantly at startup ("Failed to
// launch the browser process: Code: null"). If that ships, bots spawn and
// silently die without ever joining Jitsi. This runs as a Dockerfile RUN step
// (under Xvfb) and FAILS THE IMAGE BUILD if the pinned puppeteer-core cannot
// launch the installed Chromium — turning a silent runtime failure into a loud
// build failure with the exact fix. See the bot-chromium-puppeteer-launch note.
//
// Uses the SAME launch config as the runtime bot (browserLaunchOptions), plus
// --disable-dev-shm-usage for the constrained 64 MB /dev/shm build environment.

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { browserLaunchOptions } from '../src/bot/chromium-args.js';

const require = createRequire(import.meta.url);
const executablePath = process.env.CHROMIUM_PATH || '/usr/bin/chromium';

function chromiumVersion() {
  try { return execFileSync(executablePath, ['--version'], { encoding: 'utf8' }).trim(); }
  catch { return 'unknown'; }
}
function puppeteerVersion() {
  try { return require('puppeteer-core/package.json').version; }
  catch { return 'unknown'; }
}

const puppeteer = (await import('puppeteer-core')).default;

let browser;
try {
  browser = await puppeteer.launch(
    browserLaunchOptions(executablePath, { extraArgs: ['--disable-dev-shm-usage'], userDataDir: '/tmp/verify-profile' })
  );
  const v = await browser.version();
  console.log(`[verify-launch] OK — puppeteer-core ${puppeteerVersion()} launched ${v}`);
} catch (e) {
  const first = String(e && e.message ? e.message : e).split('\n')[0];
  console.error(
    '\n[verify-launch] FAILED to launch the browser.\n' +
    `  Chromium:       ${chromiumVersion()}\n` +
    `  puppeteer-core: ${puppeteerVersion()}\n` +
    `  error:          ${first}\n\n` +
    "Debian's Chromium is rolling and has outpaced the pinned puppeteer-core,\n" +
    'so bots would spawn and immediately crash without joining. Fix:\n' +
    '  1) cd bots && npm install puppeteer-core@latest\n' +
    '  2) commit bots/package.json + bots/package-lock.json, then rebuild.\n' +
    'If launch still fails after that, the launch options themselves need\n' +
    'revisiting (see the bot-chromium-puppeteer-launch isolation-test recipe).\n'
  );
  process.exitCode = 1;
} finally {
  if (browser) { try { await browser.close(); } catch { /* ignore */ } }
}

#!/usr/bin/env node
// jitsi-bot.js — joins a Trussal/Jitsi meeting as a full participant via headless browser.
//
// Full WebRTC join = visible in the meeting's participant list and video grid.
// Trussal's custom-config.js runs in-page, so the sidecar connection, pattern,
// and play state follow the same code path as a real user. The bot drives it
// from outside via the trussal-kbd-eval DOM event that studio.js already listens for.
//
// First run: `npm install` downloads ~200 MB of bundled Chrome.
//
// Usage:
//   node jitsi-bot.js [options]
//
// Options:
//   --url      Jitsi base URL  (default: https://trussal.com)
//   --room     Room name        (default: 0)
//   --name     Display name     (default: strudel-bot)
//   --pattern  Strudel code     (default: s("bd ~ sd ~"))

import puppeteer from 'puppeteer-core';
import { fileURLToPath } from 'url';
import { join, dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Chrome extracted from google-chrome-stable_current_amd64.deb.
// Run `npm run install-chrome` to (re)install it.
const CHROME_PATH = join(__dirname, 'chrome/opt/google/chrome/chrome');

const args = parseArgs(process.argv.slice(2));
const baseUrl = args.url     ?? 'https://trussal.com';
const room    = args.room    ?? '0';
const name    = args.name    ?? 'strudel-bot';
const pattern = args.pattern ?? 's("bd ~ sd ~")';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}

// Skip the prejoin screen and set the display name via Jitsi's URL fragment
// config overrides. The server may ignore these if it has them disabled, in
// which case the fallback below handles the prejoin UI instead.
const meetingUrl = `${baseUrl}/${encodeURIComponent(room)}`
  + `#config.prejoinPageEnabled=false&userInfo.displayName=${encodeURIComponent(name)}`;

console.log(`launching  url=${meetingUrl}`);

const browser = await puppeteer.launch({
  headless: true,
  executablePath: CHROME_PATH,
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--use-fake-ui-for-media-stream',       // auto-grant camera/mic browser dialog
    '--use-fake-device-for-media-stream',   // fake audio/video device (no real input needed)
    '--autoplay-policy=no-user-gesture-required', // AudioContext without gesture
    '--disable-features=WebRtcHideLocalIpsWithMdns',
  ],
});

browser.on('disconnected', () => {
  console.error('browser disconnected');
  process.exit(1);
});

const page = await browser.newPage();

const origin = new URL(baseUrl).origin;
await page.browserContext().overridePermissions(origin, ['camera', 'microphone']);

page.on('console', msg => {
  const text = msg.text();
  if (['[peer-state]', '[strudel]', '[studio]', '[latency]', '[participants]', '[Trussal]']
      .some(p => text.startsWith(p))) {
    console.log(`[browser] ${text}`);
  }
});
page.on('pageerror', err => console.warn('[browser] error:', err.message));

await page.goto(meetingUrl);

// Fallback: handle the prejoin screen if config.prejoinPageEnabled=false was
// overridden or ignored server-side. Trussal patches the button text to
// "Join session"; we find any button whose text contains "join".
try {
  await page.waitForSelector('[class*="premeeting"], [class*="prejoin"]', { timeout: 5000 });
  console.log('prejoin screen present — filling name and clicking join');
  const nameInput = await page.$('[data-testid="prejoin.displayName"], #premeeting-name-input');
  if (nameInput) {
    await nameInput.click({ clickCount: 3 });
    await nameInput.type(name);
  }
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button, [role="button"]'))
      .find(el => /join/i.test(el.textContent) || /join/i.test(el.getAttribute('aria-label') ?? ''));
    btn?.click();
  });
} catch {
  // No prejoin screen — already joining
}

// Wait until Jitsi has joined the conference. Mirrors the same check used in
// studio.js's isInMeeting() to avoid a second source of truth.
console.log('waiting for conference join...');
await page.waitForFunction(() => {
  try {
    const conf = window.APP?.conference;
    if (typeof conf?.isJoined === 'function' && conf.isJoined()) return true;
    if (conf?._room && typeof conf._room.isJoined === 'function' && conf._room.isJoined()) return true;
  } catch { /* ignore */ }
  return false;
}, { timeout: 60000, polling: 1000 });
console.log('conference joined');

// Wait for the Trussal Studio toggle button. studio.js creates it inside
// tickUi() only after isInMeeting() is true, so its presence means the full
// Trussal overlay system is initialised and the sidecar has had time to connect.
await page.waitForSelector('#trussal-studio-toggle', { timeout: 15000 });

// Click the Studio button: (a) opens the overlay, (b) provides the user-gesture
// activation that allows AudioContext.resume() in the same page task queue.
await page.click('#trussal-studio-toggle');

// Give participants.js one poll cycle (≤1 s) and the sidecar hello/roster
// exchange time to complete before firing the eval.
await new Promise(r => setTimeout(r, 2000));

// studio.js listens for trussal-kbd-eval and calls onEvalAndPlay(), which:
//   1. sendLocalPattern(code)   — sends the pattern to the sidecar
//   2. bootStrudelOnUserGesture() — boots the AudioContext
//   3. sendLocalPlaying(true)   — broadcasts play state
// Every other browser in the room then includes this pattern in its combined
// Strudel program, so participants hear it through their own Strudel engine.
console.log(`sending pattern: ${pattern}`);
await page.evaluate((code) => {
  document.dispatchEvent(new CustomEvent('trussal-kbd-eval', { detail: { code } }));
}, pattern);

console.log('bot is playing — Ctrl+C to stop');

process.on('SIGINT', async () => {
  console.log('\nstopping...');
  try { await browser.close(); } catch { /* ignore */ }
  process.exit(0);
});

// Keep the process alive — the headless browser holds the WebRTC/sidecar connection.
await new Promise(() => {});

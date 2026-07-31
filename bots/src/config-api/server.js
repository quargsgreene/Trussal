/**
 * Admin/config API. node:http, two GETs and two POSTs — a framework would
 * be pure weight. Bound by the caller to 0.0.0.0 so the page is reachable
 * from a GUI browser outside the VM (spec).
 *
 * The server owns no state: every read/write goes straight to the Conductor,
 * so what the page shows (including the per-bot inspector modals) is always
 * the code actually distributed to bots.
 */

import http from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Loaded once at startup: the page is static; all live data arrives via
// fetch('/api/...') from the inline script.
const ADMIN_HTML = readFileSync(
  fileURLToPath(new URL('./admin.html', import.meta.url)),
  'utf8',
);

export function createAdminServer(conductor) {
  return http.createServer((req, res) => {
    const send = (code, body, type = 'application/json') => {
      res.writeHead(code, { 'content-type': type });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };

    const readJson = () => new Promise((resolve, reject) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid JSON body')); }
      });
    });

    (async () => {
      if (req.method === 'GET' && (req.url === '/' || req.url === '/index.html')) {
        return send(200, ADMIN_HTML, 'text/html');
      }

      if (req.method === 'GET' && req.url === '/api/bots') {
        return send(200, conductor.listBots());
      }

      if (req.method === 'GET' && req.url === '/api/config') {
        return send(200, conductor.cfg);
      }

      // Which meetings the fleet is actually serving, and whether each has a
      // live aggregator. The fleet discovers rooms at runtime, so this is the
      // only way to answer "why is there no aggregator in my room" — the older
      // per-room accessors need a room name you would have to guess.
      if (req.method === 'GET' && req.url === '/api/rooms') {
        return send(200, typeof conductor.roomsStatus === 'function' ? conductor.roomsStatus() : []);
      }

      if (req.method === 'POST' && req.url === '/api/config') {
        const overrides = await readJson();
        try {
          await conductor.applyConfig(overrides);
          return send(200, { ok: true });
        } catch (err) {
          // mergeConfig rejects unknown keys/roles — surface the message.
          return send(400, { error: err.message });
        }
      }

      if (req.method === 'POST' && req.url === '/api/master-script') {
        const json = await readJson();
        const result = conductor.setMasterScript(json);
        return send(result.ok ? 200 : 400, result.ok ? { ok: true } : { error: result.error });
      }

      return send(404, { error: 'not found' });
    })().catch((err) => send(400, { error: err.message }));
  });
}

import { defineConfig } from 'vite';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { build as esbuildBuild } from 'esbuild';
import { buildPages } from './build-pages.mjs';
import { trussalHmr } from './vite-plugin-trussal-hmr.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const STRUDEL_FORK_WEB = resolve(__dirname, 'strudel-fork/packages/web');
const DEPLOY_DIR = resolve(__dirname, 'docker-jitsi-meet/jitsi-web');

// Environment variables set by dev.sh
const PROXY_TARGET = process.env.VITE_PROXY_TARGET || 'localhost:8443';
const HTTPS_KEY = process.env.VITE_HTTPS_KEY;
const HTTPS_CERT = process.env.VITE_HTTPS_CERT;

export default defineConfig(({ mode, command }) => {
  const isDev = command === 'serve';
  
  // Dev server config
  const serverConfig = isDev ? {
    server: {
      port: 3456,
      // Fail loudly instead of silently moving to another port: every printed
      // URL and every browser tab assumes 3456, so a second dev server (or a
      // stray process) must not be able to masquerade on 3457+.
      strictPort: true,
      host: '0.0.0.0',
      https: (HTTPS_KEY && HTTPS_CERT && existsSync(HTTPS_KEY) && existsSync(HTTPS_CERT)) ? {
        key: readFileSync(HTTPS_KEY),
        cert: readFileSync(HTTPS_CERT),
      } : undefined,
      // HMR on its own port: the catch-all proxy below has ws:true, which
      // would otherwise swallow the HMR websocket upgrade for '/'.
      hmr: {
        port: 3457,
        host: 'localhost',
        protocol: 'wss',
      },
      proxy: {
        '/': {
          target: `https://${PROXY_TARGET}`,
          changeOrigin: true,
          secure: false,
          ws: true,
          bypass: (req, res, options) => {
            const url = req.url || '';
            // Let Vite handle these (returning the url from bypass skips the
            // proxy; the request then reaches the middleware chain below).
            if (url.startsWith('/custom-config.js') ||
                url.startsWith('/custom-config.css') ||
                url.startsWith('/@vite') ||
                url.startsWith('/@fs/') ||
                url.startsWith('/@id/') ||
                url.startsWith('/node_modules/') ||
                url.startsWith('/src/') ||
                // The local strudel packages (vite alias targets). Vite serves
                // them root-relative from the repo; without this they reach the
                // Jitsi container and come back as HTML, which the module
                // loader rejects (MIME).
                url.startsWith('/strudel-fork/') ||
                // Repo-root dirs that src/ imports via relative paths; Vite
                // normalizes those to root-relative URLs (same HTML-vs-module
                // hazard as above).
                url.startsWith('/components/') ||
                url.startsWith('/latency-instrument/') ||
                url.startsWith('/public/') ||
                url.startsWith('/__docs-version') ||
                url.startsWith('/documentation') ||
                url.startsWith('/about') ||
                url.startsWith('/css/src/docs-images/')) {
              return url;
            }
          },
        },
      },
    },
  } : {};
  
  return {
    root: __dirname,
    base: '/',
    publicDir: false,
    
    ...serverConfig,
    
    resolve: {
      alias: {
        '@strudel/web': resolve(STRUDEL_FORK_WEB, 'dist/index.mjs'),
        '@strudel/soundfonts': resolve(__dirname, 'strudel-fork/packages/soundfonts/dist/index.mjs'),
        '@strudel/core': resolve(__dirname, 'node_modules/@strudel/core/dist/index.mjs'),
        '@strudel/webaudio': resolve(__dirname, 'node_modules/@strudel/webaudio/dist/index.mjs'),
        'mondolang': resolve(__dirname, 'src/audio-net/mondo.mjs'),
      },
    },
    
    build: {
      lib: {
        entry: resolve(__dirname, 'src/index.js'),
        name: 'TrussalCustomConfig',
        formats: ['es'],
        fileName: () => 'custom-config.js',
      },
      outDir: resolve(__dirname, 'dist'),
      emptyOutDir: true,
      minify: false,
      sourcemap: true,
      rollupOptions: {
        external: [],
        output: {
          manualChunks: undefined,
        },
      },
    },
    
    // Use HMR entry point for dev
    optimizeDeps: {
      exclude: ['@strudel/web', '@strudel/soundfonts', '@strudel/core', '@strudel/webaudio'],
      entries: isDev ? ['src/entry-hmr.js'] : [],
    },
    
    // CSS is a normal Vite module graph concern: src/styles.css is the app's
    // single entry and Vite injects/hot-updates it like any other stylesheet.
    css: {
      modules: false,
    },
    
    plugins: [
      // Dev-only per-module HMR boundaries (CSS dep accepts, leaf
      // self-accepts, state hand-off). Kept out of the app modules and out of
      // the production bundle; see the file header.
      trussalHmr(),
      // Dev-only CommonJS interop for the latency-instrument modules. They
      // are CommonJS on purpose (see the header of room-indices.js): the node
      // sidecar requires them and build.mjs bundles them into the browser
      // entry through esbuild's CJS interop. Vite dev would serve the raw
      // file, whose `module.exports` gives the browser's module linker no
      // exports ("does not provide an export named ..."). Prebundle just
      // these files with esbuild — the same engine and interop the
      // production build uses.
      {
        name: 'trussal-latency-cjs',
        apply: 'serve',
        enforce: 'pre',
        async transform(code, id) {
          if (!id.endsWith('.js') || !id.includes('/latency-instrument/')) return null;
          if (!/\bmodule\.exports\b/.test(code)) return null; // already ESM: leave alone
          // Shape: `export default <module.exports>`, matching how esbuild
          // interops a require()d CJS module into the production bundle.
          // (Named exports are not synthesized — esbuild only rewrites named
          // *imports* of CJS, it doesn't extract names — so browser code
          // default-imports these and destructures; see
          // src/audio-net/o2lite_driver.js for the pattern.)
          const result = await esbuildBuild({
            stdin: { contents: code, sourcefile: id, resolveDir: dirname(id), loader: 'js' },
            bundle: true,
            format: 'esm',
            platform: 'browser',
            write: false,
            logLevel: 'silent',
          });
          return { code: result.outputFiles[0].text, map: null };
        },
      },
      {
        name: 'trussal-docs-images',
        apply: 'serve',
        configureServer(server) {
          const docsImagesDir = resolve(__dirname, 'src/docs-images');

          // Serve docs-images directly from the local filesystem with no-cache
          // headers, so a hard refresh always shows the bytes on disk (the
          // container path relies on the /css/src/ nginx headers for the same).
          server.middlewares.use((req, res, next) => {
            if (req.url && req.url.startsWith('/css/src/docs-images/')) {
              const filePath = resolve(docsImagesDir, req.url.replace('/css/src/docs-images/', '').split('?')[0]);
              if (existsSync(filePath)) {
                res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
                res.setHeader('Pragma', 'no-cache');
                res.setHeader('Expires', '0');
                res.setHeader('Access-Control-Allow-Origin', '*');
                const ext = filePath.split('.').pop().toLowerCase();
                const mimeTypes = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', webp: 'image/webp', bmp: 'image/bmp' };
                res.setHeader('Content-Type', mimeTypes[ext] || 'application/octet-stream');
                return res.end(readFileSync(filePath));
              }
            }
            next();
          });

          // Version token for the standalone /documentation + /about pages.
          // The pages poll this (see build-pages.mjs hotReloadScript) and
          // reload themselves when any docs source or image changes. No
          // file watching and no websocket involvement, so it can never
          // reload-loop and never disturbs the app tab's HMR.
          const docsVersion = () => {
            const parts = [];
            for (const f of ['src/docs-about.js', 'src/docs-about-content.js', 'src/docs-about.css', 'src/docs-page.css']) {
              try { parts.push(`${f}:${statSync(resolve(__dirname, f)).mtimeMs}`); } catch { /* ignore */ }
            }
            try {
              for (const f of readdirSync(docsImagesDir)) {
                try { parts.push(`${f}:${statSync(resolve(docsImagesDir, f)).mtimeMs}`); } catch { /* ignore */ }
              }
            } catch { /* ignore */ }
            return parts.join('|');
          };
          server.middlewares.use((req, res, next) => {
            if (req.url && req.url.startsWith('/__docs-version')) {
              res.setHeader('Cache-Control', 'no-store');
              res.setHeader('Content-Type', 'text/plain');
              return res.end(docsVersion());
            }
            next();
          });
        },
      },
      {
        name: 'trussal-custom-config',
        apply: 'serve',
        configureServer(server) {
          // /custom-config.js in dev is a module shim: the page loads it as a
          // classic script (Jitsi's index.html), so it dynamically imports the
          // Vite client + the HMR entry. Everything the entry pulls in is then
          // served transformed by Vite with hot updates — no static dist
          // bundle, no reloads for code edits.
          const shim = [
            '// served by vite.config.js (dev): module shim, not the built bundle',
            'import("/@vite/client");',
            'import("/src/entry-hmr.js");',
            '',
          ].join('\n');
          server.middlewares.use((req, res, next) => {
            // Production's body.html links the bundled stylesheet. In dev the
            // CSS comes from Vite's module graph (src/styles.css is imported by
            // src/index.js), so answer the link with an empty sheet instead of
            // letting the request fall through to Jitsi.
            if (req.url && (req.url === '/custom-config.css' || req.url.startsWith('/custom-config.css?'))) {
              res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
              res.setHeader('Content-Type', 'text/css');
              res.end('/* dev: Vite injects src/styles.css through the module graph */');
              return;
            }
            if (req.url && (req.url === '/custom-config.js' || req.url.startsWith('/custom-config.js?'))) {
              res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
              res.setHeader('Pragma', 'no-cache');
              res.setHeader('Expires', '0');
              res.setHeader('Content-Type', 'application/javascript');
              res.setHeader('Access-Control-Allow-Origin', '*');
              return res.end(shim);
            }
            next();
          });
        },
      },
      {
        name: 'trussal-docs-pages',
        apply: 'serve',
        configureServer(server) {
          // Serve docs/about pages, rebuilt from source on every request (so
          // they are always current after the poll-driven reload) with the
          // dev-only reload poll injected.
          const servePage = (file) => (req, res, next) => {
            try {
              buildPages(resolve(__dirname, 'dist'), { hotReload: true });
              const page = resolve(__dirname, 'dist', file);
              res.setHeader('Content-Type', 'text/html');
              res.setHeader('Cache-Control', 'no-store');
              res.end(readFileSync(page));
            } catch (e) {
              next(e);
            }
          };
          server.middlewares.use('/documentation', servePage('documentation.html'));

          server.middlewares.use('/about', servePage('about.html'));

          server.middlewares.use('/documentation/', (req, res) => {
            res.writeHead(301, { Location: '/documentation' });
            res.end();
          });
          server.middlewares.use('/about/', (req, res) => {
            res.writeHead(301, { Location: '/about' });
            res.end();
          });
        },
      },
      {
        name: 'trussal-deploy',
        apply: 'build',
        closeBundle() {
          // Copy to deploy dir for container bind mount
          import('node:fs').then(fs => {
            import('node:path').then(path => {
              const files = fs.readdirSync(resolve(__dirname, 'dist'));
              for (const file of files) {
                fs.copyFileSync(
                  path.join(__dirname, 'dist', file),
                  path.join(DEPLOY_DIR, file)
                );
              }
              // Copy assets
              if (fs.existsSync(resolve(__dirname, 'dist/assets'))) {
                fs.cpSync(resolve(__dirname, 'dist/assets'), path.join(DEPLOY_DIR, 'assets'), { recursive: true });
              }
              // Copy docs-images
              const docsImagesSrc = path.join(__dirname, 'src/docs-images');
              const docsImagesDest = path.join(DEPLOY_DIR, 'css/src/docs-images');
              if (fs.existsSync(docsImagesSrc)) {
                fs.cpSync(docsImagesSrc, docsImagesDest, { recursive: true });
              }
              console.log(`[vite] deployed → ${DEPLOY_DIR}`);
            });
          });
        },
      },
      {
        name: 'trussal-pages-build',
        apply: 'build',
        closeBundle() {
          // Build static pages for production
          buildPages(resolve(__dirname, 'dist'), { hotReload: false });
          import('node:fs').then(fs => {
            import('node:path').then(path => {
              for (const file of ['documentation.html', 'about.html']) {
                fs.copyFileSync(
                  path.join(__dirname, 'dist', file),
                  path.join(DEPLOY_DIR, file)
                );
              }
            });
          });
        },
      },
    ],
    
    define: {
      'import.meta.env.DEV': isDev,
      'import.meta.env.PROD': !isDev,
    },
  };
});
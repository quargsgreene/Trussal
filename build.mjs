import 'dotenv/config';
import esbuild from 'esbuild';
import { mkdirSync, copyFileSync, readdirSync, existsSync, cpSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STRUDEL_FORK_WEB = resolve(__dirname, 'strudel-fork/packages/web');
const STRUDEL_ASSETS_SRC = join(STRUDEL_FORK_WEB, 'dist/assets');
const STRUDEL_ASSETS_DEST = 'dist/assets';

// Bind-mount dir the Jitsi `web` container serves /custom-config.js + /assets
// from (see docker-compose.yml). Copying the fresh bundle here is all a running
// container needs to pick up a rebuild — no image rebuild, no restart.
const DEPLOY_DIR = resolve(__dirname, 'docker-jitsi-meet/jitsi-web');

const argv = new Set(process.argv.slice(2));
const WATCH = argv.has('--watch');
const DEPLOY = argv.has('--deploy'); // also copy into the container bind mount

// Strudel's bundle references a SharedWorker via `new URL("assets/clockworker-*.js", import.meta.url)`,
// which resolves relative to wherever the bundled custom-config.js is served from.
// esbuild does not rewrite that pattern, so copy the asset file(s) alongside our bundle.
function copyStrudelAssets() {
	if (!existsSync(STRUDEL_ASSETS_SRC)) {
		console.warn('[build] strudel assets dir not found:', STRUDEL_ASSETS_SRC);
		return;
	}
	mkdirSync(STRUDEL_ASSETS_DEST, { recursive: true });
	for (const f of readdirSync(STRUDEL_ASSETS_SRC)) {
		copyFileSync(join(STRUDEL_ASSETS_SRC, f), join(STRUDEL_ASSETS_DEST, f));
	}
}

// Mirror dist/ into the container's bind-mount dir (same effect as the
// `deploy:local` npm script, but callable on every incremental rebuild).
function deployToContainer() {
	copyFileSync('dist/custom-config.js', join(DEPLOY_DIR, 'custom-config.js'));
	const assetsDest = join(DEPLOY_DIR, 'assets');
	mkdirSync(assetsDest, { recursive: true });
	cpSync('dist/assets', assetsDest, { recursive: true });
}

// esbuild runs onEnd after every (re)build — including the first — so the copy
// steps stay in sync in one-shot and --watch modes alike.
const postBuild = {
	name: 'trussal-postbuild',
	setup(build) {
		build.onEnd((result) => {
			if (result.errors.length) return; // leave stale output on a failed rebuild
			copyStrudelAssets();
			if (DEPLOY) {
				deployToContainer();
				console.log(`[build] deployed → docker-jitsi-meet/jitsi-web/  ${new Date().toLocaleTimeString()}`);
			}
		});
	},
};

const options = {
	entryPoints: ['src/index.js'],
	outfile: 'dist/custom-config.js',
	bundle: true,
	// Redirect strudel packages to the local strudel-fork builds. Core and
	// webaudio are pinned to Trussal's node_modules so esbuild doesn't walk
	// into strudel-fork's pnpm workspace and encounter ?audioworklet imports.
	alias: {
		'@strudel/web': join(STRUDEL_FORK_WEB, 'dist/index.mjs'),
		'@strudel/soundfonts': resolve(__dirname, 'strudel-fork/packages/soundfonts/dist/index.mjs'),
		'@strudel/core': resolve(__dirname, 'node_modules/@strudel/core/dist/index.mjs'),
		'@strudel/webaudio': resolve(__dirname, 'node_modules/@strudel/webaudio/dist/index.mjs'),
		// The Mondo parser/runner is vendored at src/audio-net/mondo.mjs (see
		// its header); this alias only catches any stray bare `mondolang` import.
		'mondolang': resolve(__dirname, 'src/audio-net/mondo.mjs'),
	},
	// Capture our own <script> URL synchronously at script load so
	// `import.meta.url` (used by Strudel for its SharedWorker asset) resolves
	// to a path relative to custom-config.js. document.currentScript is only
	// valid during top-level synchronous execution, hence the banner.
	banner: {
		js: `var __TRUSSAL_BUNDLE_URL = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || (typeof location !== 'undefined' ? location.href : '');`
	},
	define: {
		'process.env.JAMULUS_HOST': JSON.stringify(process.env.JAMULUS_HOST || 'jamulus.example.com'),
		'import.meta.url': '__TRUSSAL_BUNDLE_URL'
	},
	// Modules inject their own <style> tags at runtime (no <link> mechanism
	// exists for this bundle to hook into Jitsi's page with), so a .css
	// import is pulled in as a plain string rather than esbuild's own CSS
	// loader (which would try to bundle/emit it as a separate stylesheet).
	loader: { '.css': 'text' },
	plugins: [postBuild],
};

if (WATCH) {
	const ctx = await esbuild.context(options);
	await ctx.watch();
	console.log('[build] watching src/ for changes… (Ctrl-C to stop)');
} else {
	await esbuild.build(options);
}

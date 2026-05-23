import 'dotenv/config';
import esbuild from 'esbuild';
import { mkdirSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const STRUDEL_ASSETS_SRC = 'node_modules/@strudel/web/dist/assets';
const STRUDEL_ASSETS_DEST = 'dist/assets';

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

await esbuild.build({
	entryPoints: ['src/index.js'],
	outfile: 'dist/custom-config.js',
	bundle: true,
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
	}
});

copyStrudelAssets();

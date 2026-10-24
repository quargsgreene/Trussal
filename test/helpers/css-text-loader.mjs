// css-text-loader.mjs — lets `import styles from './x.css'` work under
// node:test the way it works in the bundle.
//
// build.mjs loads every .css import as raw text (esbuild's '.css': 'text'
// loader); src/styles.js installs them as <style> tags at runtime. Node has no
// such loader, so a module under test that reaches styles.js (or imports a
// stylesheet directly) would otherwise fail to load with
// ERR_UNKNOWN_FILE_EXTENSION. Registered from package.json's test script:
// `node --import ./test/helpers/css-text-loader.mjs --test …`.
import { register } from 'node:module';

register('./css-text-loader-hooks.mjs', import.meta.url);

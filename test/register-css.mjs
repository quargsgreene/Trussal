// Register the CSS ESM hooks before the test runner loads any module that
// imports a .css file. Loaded via `node --import ./test/register-css.mjs`.
import { register } from 'node:module';

register('./css-loader.mjs', import.meta.url);

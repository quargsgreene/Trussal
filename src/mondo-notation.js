// mondo-notation.js — Mondo pattern language for the personal editor, so mini
// and mondo are both available and picked per fragment.
//
// This is strudel-fork/packages/mondough/mondough.mjs, ported so it draws its
// Strudel primitives from the bundle's own `@strudel/web` build (which
// re-exports all of them) instead of a separate `@strudel/core` +
// `@strudel/transpiler` the bundle does not carry. `MondoRunner` is the
// self-contained parser/runner vendored at src/audio-net/mondo.mjs.
//
// Importing this module for its side effect registers `mondo` and `mondolang`
// as transpiler languages, so `mondo`...`` in an editor gets its mini-notation
// locations mapped for highlighting; the `mondo` / `mondi` tag functions
// themselves must be in evalScope (strudel.js adds them).

import {
  strudelScope,
  reify,
  fast,
  slow,
  seq,
  stepcat,
  replicate,
  expand,
  pace,
  chooseIn,
  degradeBy,
  silence,
  bjork,
  registerLanguage,
  // Head words a mondo list can name. This fork's build does not seed these
  // into `strudelScope` (only Pattern-method-derived names live there), and
  // `cat` is spelled `slowcat`, so mondo-notation.js supplies them as the
  // runner's scope rather than leaning on the global one.
  fastcat,
  slowcat,
  stack,
  s as sStrudel,
  n as nStrudel,
  note,
  sound,
} from '@strudel/web';
import { MondoRunner } from './audio-net/mondo.mjs';

// This fork's Pattern has neither markcss (editor caret styling) nor a
// throwing withLoc; both are cosmetic here, so call them only if present.
const withMarkcss = (pat) =>
  pat && typeof pat.markcss === 'function'
    ? pat.markcss('color: var(--caret,--foreground);text-decoration:underline')
    : pat;

const tail = (friend, pat) => pat.fmap((a) => (b) => (Array.isArray(a) ? [...a, b] : [a, b])).appLeft(friend);

const arrayRange = (start, stop, step = 1) =>
  Array.from({ length: Math.abs(stop - start) / step + 1 }, (_, index) =>
    start < stop ? start + index * step : start - index * step,
  );
const range = (max, min) => min.squeezeBind((a) => max.bind((b) => seq(...arrayRange(a, b))));

let nope = (...args) => args[args.length - 1];

let lib = {};
lib['nope'] = nope;
lib['-'] = (a, b) => b.early(a);
lib['+'] = (a, b) => b.late(a);
lib['_'] = silence;
lib['~'] = silence;
lib.curly = stepcat;
lib.square = (...args) => stepcat(...args).setSteps(1);
lib.angle = (...args) => stepcat(...args).pace(1);
lib['*'] = fast;
lib['/'] = slow;
lib['!'] = replicate;
lib['@'] = expand;
lib['%'] = pace;
lib['?'] = degradeBy;
lib['&'] = bjork;
lib[':'] = tail;
lib['..'] = range;
lib['def'] = () => silence;
lib['or'] = (...children) => chooseIn(...children);
// Head words. `cat` is `slowcat` in this build; the rest are direct exports.
lib['cat'] = slowcat;
lib['slowcat'] = slowcat;
lib['fastcat'] = fastcat;
lib['seq'] = seq;
lib['fastseq'] = fastcat;
lib['stack'] = stack;
lib['stepcat'] = stepcat;
lib['fast'] = fast;
lib['slow'] = slow;
lib['silence'] = silence;
// Controls take ONE pattern; `(s bd sd)` means `s("bd sd")`, so several
// argument tokens are sequenced first.
const control = (fn) => (...as) => fn(as.length > 1 ? seq(...as) : as[0]);
lib['s'] = control(sStrudel);
lib['sound'] = control(sound);
lib['n'] = control(nStrudel);
lib['note'] = control(note);

function evaluator(node, scope) {
  const { type } = node;
  if (type === 'list') {
    const { children } = node;
    const [name, ...args] = children;
    if (typeof name === 'function') {
      return name(...args);
    }
    if (name.value === 'def') {
      return silence;
    }
    const first = name.firstCycle(true)[0];
    const t = typeof first?.value;
    if (t !== 'function') {
      throw new Error(`[mondo] expected function, got "${first?.value}"`);
    }
    return name
      .fmap((fn) => {
        if (typeof fn !== 'function') {
          throw new Error(`[mondo] "${fn}" is not a function`);
        }
        return fn(...args);
      })
      .innerJoin();
  }
  let { value } = node;
  if (type === 'plain' && scope[value]) {
    return reify(scope[value]);
  }
  const variable = lib[value] ?? strudelScope[value];
  let pat;
  if (type === 'plain' && typeof variable !== 'undefined') {
    if (['!', 'extend', '@', 'expand', 'square', 'angle', 'all', 'setcpm', 'setcps'].includes(value)) {
      return variable;
    }
    pat = reify(variable);
  } else {
    pat = reify(value);
  }
  if (node.loc && typeof pat.withLoc === 'function') {
    pat = pat.withLoc(node.loc[0], node.loc[1]);
  }
  return pat;
}

const runner = new MondoRunner({ evaluator });

export function mondo(code, offset = 0) {
  if (Array.isArray(code)) {
    code = code.join('');
  }
  const pat = runner.run(code, undefined, offset);
  return withMarkcss(pat);
}

export const getLocations = (code, offset) => runner.parser.get_locations(code, offset);

export const mondi = (str, offset) => mondo(`[${str}]`, offset);

registerLanguage('mondo', { getLocations });

export const mondolang = (code) => mondo(code, 0);
registerLanguage('mondolang', { getLocations: (code) => getLocations(code, 0) });

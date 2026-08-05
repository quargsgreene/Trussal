import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTRAST_FLOOR,
  adjustColorForBackground,
  buildPeerScss,
  checkCompiledCss,
  checkDeclaration,
  checkSheet,
  clampValue,
  contrastRatio,
  cssPropForMethod,
  cssVarName,
  encodeCssValue,
  extractKeyframes,
  hasCssCycles,
  keepSilentStatements,
  methodForCssProp,
  parseColor,
  parseScssDeclarations,
  rewriteCssCalls,
} from '../src/css-cycles-core.js';

// --- declaring the capability -----------------------------------------------

test('initCss declares styling presence, the other capabilities do not', () => {
  assert.equal(hasCssCycles('await initCss()\n\n$: css(`.x {}`)'), true);
  assert.equal(hasCssCycles('await initTextCycles()\n\n$: word("hi")'), false);
  assert.equal(hasCssCycles('await initHydra()\n\n$: s("bd")'), false);
  assert.equal(hasCssCycles('$: css(`.x {}`)'), false);
});

test('silent statements survive the aggregator exclusion, audio voices do not', () => {
  const src = '$: s("bd*4")\n$: css(`.x {}`).color("red")\n$: word("hi")\n$: n("0 1").s("piano")';
  assert.equal(keepSilentStatements(src), '$: css(`.x {}`).color("red")\n$: word("hi")');
});

// --- property naming ---------------------------------------------------------

test('camelCase chain names map to hyphenated properties', () => {
  assert.equal(cssPropForMethod('borderRadius'), 'border-radius');
  assert.equal(cssPropForMethod('color'), 'color');
  assert.equal(cssPropForMethod('backgroundImage'), 'background-image');
  assert.equal(cssPropForMethod('webkitTextFillColor'), '-webkit-text-fill-color');
  assert.equal(methodForCssProp('border-radius'), 'borderRadius');
  assert.equal(methodForCssProp('-webkit-text-fill-color'), 'webkitTextFillColor');
});

test('Strudel structural methods are not CSS properties', () => {
  // These have to fall through the rewrite untouched or `.fast(3)` stops
  // meaning tempo.
  for (const name of ['fast', 'slow', 'every', 'off', 'jux', 'rev', 'segment', 'euclid', 'degrade']) {
    assert.equal(cssPropForMethod(name), null, `${name} should not be a CSS property`);
  }
});

// --- the ^…^ literal fence ---------------------------------------------------

test('spaces are mini steps, carets fence one literal CSS value', () => {
  const seen = [];
  const mint = (t) => { seen.push(t); return `cc${seen.length - 1}`; };
  // The user's own example: a two-step sequence, not one shorthand.
  assert.equal(encodeCssValue('2em 1em', mint), 'cc0 cc1');
  assert.deepEqual(seen, ['2em', '1em']);

  const seen2 = [];
  const mint2 = (t) => { seen2.push(t); return `cc${seen2.length - 1}`; };
  encodeCssValue('<^2em / 1em 3em 0.5em^ ^0.2em 1em 4em 1em^>', mint2);
  assert.deepEqual(seen2, ['2em / 1em 3em 0.5em', '0.2em 1em 4em 1em']);
});

test('mini operators survive the fence scan', () => {
  const seen = [];
  const mint = (t) => { seen.push(t); return 'x'; };
  assert.equal(encodeCssValue('<#fff #eee #34e3df>/4', mint), '<x x x>/4');
  assert.deepEqual(seen, ['#fff', '#eee', '#34e3df']);
});

test('a function call is one value without needing carets', () => {
  const seen = [];
  const mint = (t) => { seen.push(t); return 'x'; };
  encodeCssValue('rgb(255, 0, 0)', mint);
  assert.deepEqual(seen, ['rgb(255, 0, 0)']);
});

// --- statement rewriting -----------------------------------------------------

test('a css statement becomes a scss token plus namespaced property controls', () => {
  const src = '$: css(`.example { color: red }`).color("<#fff #eee>").borderRadius("2em").fast(3)';
  const { code, atoms, sheets } = rewriteCssCalls(src, { peer: 'abc' });

  assert.match(code, /css\("cc0"\)/);
  // Namespaced: registering `color` outright would clobber the audio control
  // every other voice in the room uses.
  assert.match(code, /\._cc_color\("<cc1 cc2>"\)/);
  assert.match(code, /\._cc_borderRadius\("cc3"\)/);
  // Strudel structure is left exactly where the performer put it.
  assert.match(code, /\.fast\(3\)/);
  // The dominant trigger that keeps a css voice silent, per statement.
  assert.match(code, /\n\._ccRender\(\)$/);

  assert.equal(atoms.cc0.kind, 'scss');
  assert.equal(atoms.cc0.text, '.example { color: red }');
  assert.equal(atoms.cc1.text, '#fff');
  assert.equal(atoms.cc1.peer, 'abc');
  assert.deepEqual(sheets[0].props.map((p) => p.prop), ['color', 'border-radius']);
});

test('a non-css statement is untouched', () => {
  const { code } = rewriteCssCalls('$: s("bd*4").gain(0.8)');
  assert.equal(code, '$: s("bd*4").gain(0.8)');
});

test('css() without backticks is refused with an explanation', () => {
  const { errors } = rewriteCssCalls('$: css(".example").color("red")');
  assert.equal(errors.length, 1);
  assert.match(errors[0], /backticks/);
});

test('a runtime value is carried through and marked non-literal', () => {
  const { code, sheets } = rewriteCssCalls('$: css(`.x {}`).opacity(sliderWithID("o", 1))');
  assert.match(code, /_cc_opacity\(sliderWithID\("o", 1\)\)/);
  assert.equal(sheets[0].props[0].literal, false);
  assert.deepEqual(sheets[0].props[0].values, []);
});

test('tokens are unique across peers sharing one rebuild', () => {
  const counter = { n: 0 };
  const a = rewriteCssCalls('$: css(`.a {}`)', { peer: 'a', counter });
  const b = rewriteCssCalls('$: css(`.b {}`)', { peer: 'b', counter });
  assert.notDeepEqual(Object.keys(a.atoms), Object.keys(b.atoms));
});

test('the custom property name is derived from the statement token', () => {
  // Both the sheet the sidecar compiled and the trigger running in every
  // browser have to arrive at this name without coordinating.
  assert.equal(cssVarName('cc0', 'border-radius'), '--cc-cc0-border-radius');
});

// --- SCSS scanning -----------------------------------------------------------

test('declarations are found through nesting, media queries and variables', () => {
  assert.deepEqual(
    parseScssDeclarations('.x { color: red; &:hover { color: blue } }').map((d) => [d.prop, d.value]),
    [['color', 'red'], ['color', 'blue']],
  );
  assert.deepEqual(
    parseScssDeclarations('@media (max-width: 600px) { .x { visibility: hidden } }').map((d) => d.prop),
    ['visibility'],
  );
  // `$brand: #f00` is a variable binding, not a declaration to police.
  assert.deepEqual(
    parseScssDeclarations('$brand: #f00;\n.x { color: $brand }').map((d) => d.prop),
    ['color'],
  );
});

test('a declaration with no trailing semicolon is still seen', () => {
  // It would otherwise reach the sheet having never been checked.
  assert.deepEqual(
    parseScssDeclarations('.x { display: none }').map((d) => [d.prop, d.value]),
    [['display', 'none']],
  );
});

test('keyframes are lifted out of the block that carries them', () => {
  const { frames, rest } = extractKeyframes('.x { color: red }\n@keyframes spin { to { rotate: 1turn } }');
  assert.equal(frames.length, 1);
  assert.equal(frames[0].name, 'spin');
  assert.match(rest, /\.x \{ color: red \}/);
  assert.doesNotMatch(rest, /@keyframes/);
});

// --- guardrails --------------------------------------------------------------

test('the hiding properties are refused', () => {
  assert.match(checkDeclaration('display', 'none'), /hide/);
  assert.match(checkDeclaration('overflow', 'hidden'), /hide/);
  assert.match(checkDeclaration('visibility', 'hidden'), /hide/);
  assert.match(checkDeclaration('opacity', '0'), /hide/);
  assert.match(checkDeclaration('color', 'rgba(0,0,0,0)'), /hide/);
  assert.equal(checkDeclaration('display', 'flex'), null);
  assert.equal(checkDeclaration('opacity', '0.2'), null);
});

test('sizes may not be zero, but margin, padding and radius may', () => {
  assert.match(checkDeclaration('width', '0'), /collapse/);
  assert.match(checkDeclaration('font-size', '0px'), /collapse/);
  assert.match(checkDeclaration('min-height', '0'), /collapse/);
  assert.equal(checkDeclaration('margin', '0'), null);
  assert.equal(checkDeclaration('padding', '0'), null);
  assert.equal(checkDeclaration('border-radius', '0'), null);
  assert.equal(checkDeclaration('border-width', '0'), null);
});

test('z-index may not be changed at all', () => {
  assert.match(checkDeclaration('z-index', '5'), /z-index/);
  assert.match(checkDeclaration('z-index', '-1'), /z-index/);
  assert.match(checkDeclaration('z-index', 'auto'), /z-index/);
});

test('off-screen positions are refused, including through a transform', () => {
  assert.match(checkDeclaration('left', '-9999px'), /off-screen/);
  assert.match(checkDeclaration('top', '120vh'), /off-screen/);
  assert.match(checkDeclaration('text-indent', '-9999px'), /off-screen/);
  assert.match(checkDeclaration('transform', 'translateX(-200%)'), /off-screen/);
  assert.match(checkDeclaration('transform', 'scale(0)'), /collapse/);
  assert.equal(checkDeclaration('left', '20px'), null);
  assert.equal(checkDeclaration('transform', 'rotate(20deg)'), null);
});

test('filters are policed as thoroughly as the properties they imitate', () => {
  assert.match(checkDeclaration('filter', 'brightness(0)'), /hides/);
  assert.match(checkDeclaration('filter', 'opacity(0)'), /hides/);
  assert.match(checkDeclaration('filter', 'contrast(0)'), /hides/);
  assert.match(checkDeclaration('filter', 'blur(80px)'), /illegible/);
  assert.equal(checkDeclaration('filter', 'blur(4px)'), null);
  assert.equal(checkDeclaration('filter', 'hue-rotate(90deg) saturate(2)'), null);
});

test('values that could execute or break out of the rule are refused', () => {
  assert.match(checkDeclaration('background-image', 'url(javascript:alert(1))'), /execute/);
  assert.match(checkDeclaration('color', 'expression(alert(1))'), /execute/);
  assert.match(checkDeclaration('content', '"}</style>"'), /break out/);
  assert.match(checkDeclaration('behavior', 'url(x.htc)'), /execute code/);
});

test('url() is confined to the properties where an image is the point', () => {
  assert.equal(checkDeclaration('background-image', 'url(https://example.com/a.png)'), null);
  assert.equal(checkDeclaration('background-image', 'url(data:image/png;base64,AAA)'), null);
  assert.match(checkDeclaration('color', 'url(https://example.com/a.png)'), /not permitted/);
  assert.match(checkDeclaration('background-image', 'url(ftp://example.com/a.png)'), /http/);
});

test('outside Trussal only background, border, filter and text properties apply', () => {
  for (const [p, v] of [['color', 'red'], ['background-image', 'none'], ['border', '1px solid'],
    ['filter', 'blur(2px)'], ['font-family', 'Courier'], ['font-size', '20px']]) {
    assert.equal(checkDeclaration(p, v, { inTrussal: false }), null, `${p} should reach outside`);
  }
  for (const [p, v] of [['width', '300px'], ['display', 'flex'], ['position', 'fixed'],
    ['opacity', '0.5'], ['margin', '50%']]) {
    assert.match(checkDeclaration(p, v, { inTrussal: false }), /only applies inside Trussal/);
  }
});

// --- statement refusal -------------------------------------------------------

test('one illegal value anywhere in a pattern refuses the whole statement', () => {
  // Legal on two cycles in three; the statement still does not run.
  const { sheets } = rewriteCssCalls('$: css(`.x {}`).opacity("<1 0.5 0>")');
  assert.deepEqual(checkSheet(sheets[0]).length, 1);
  assert.match(checkSheet(sheets[0])[0], /opacity/);

  const ok = rewriteCssCalls('$: css(`.x {}`).opacity("<1 0.5 0.2>")');
  assert.deepEqual(checkSheet(ok.sheets[0]), []);
});

test('declarations inside the SCSS are refused too, at any nesting', () => {
  const cases = [
    '$: css(`.x { display: none }`)',
    '$: css(`.x { &:hover { visibility: hidden } }`)',
    '$: css(`@media (max-width: 600px) { .x { opacity: 0 } }`)',
    '$: css(`.x { animation: spin 2s }\n@keyframes spin { to { transform: translateX(-9999px) } }`)',
  ];
  for (const src of cases) {
    const { sheets } = rewriteCssCalls(src);
    assert.ok(checkSheet(sheets[0]).length > 0, `should refuse: ${src}`);
  }
});

// --- runtime clamping --------------------------------------------------------

test('a runtime value is clamped rather than refused', () => {
  assert.equal(clampValue('opacity', '0'), '0.04');
  assert.equal(clampValue('width', '0'), '1px');
  assert.equal(clampValue('display', 'none'), 'block');
  assert.equal(clampValue('filter', 'blur(80px)'), 'blur(8px)');
  assert.equal(clampValue('filter', 'brightness(0)'), 'brightness(0.1)');
  // A legal value is returned untouched.
  assert.equal(clampValue('opacity', '0.5'), '0.5');
  // Nothing sensible to clamp to: the declaration is dropped and the previous
  // value stands.
  assert.equal(clampValue('left', '-9999px'), null);
  assert.equal(clampValue('z-index', '4'), null);
});

// --- contrast ----------------------------------------------------------------

test('contrast is a ratio, so a near-match does not slip through', () => {
  assert.ok(contrastRatio('#ffffff', '#ffffff') < CONTRAST_FLOOR);
  assert.ok(contrastRatio('#fffffe', '#ffffff') < CONTRAST_FLOOR);
  assert.ok(contrastRatio('#000000', '#ffffff') >= CONTRAST_FLOOR);
});

test('colliding text is walked away from its background, not refused', () => {
  const onWhite = adjustColorForBackground('#ffffff', '#ffffff');
  assert.notEqual(onWhite, '#ffffff');
  assert.ok(contrastRatio(onWhite, '#ffffff') >= CONTRAST_FLOOR);

  const onBlack = adjustColorForBackground('#111111', '#000000');
  assert.ok(contrastRatio(onBlack, '#000000') >= CONTRAST_FLOOR);

  // Already legible: left exactly as written.
  assert.equal(adjustColorForBackground('#000000', '#ffffff'), '#000000');
});

test('colours parse from every form a performer might type', () => {
  assert.deepEqual(parseColor('#fff'), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseColor('#ff000080').a, 128 / 255);
  assert.deepEqual(parseColor('rgb(255, 0, 0)'), { r: 255, g: 0, b: 0, a: 1 });
  assert.equal(parseColor('rgba(0,0,0,0)').a, 0);
  assert.equal(parseColor('transparent').a, 0);
  assert.deepEqual(parseColor('hsl(0, 100%, 50%)'), { r: 255, g: 0, b: 0, a: 1 });
  assert.equal(parseColor('not-a-colour'), null);
});

// --- sheet assembly ----------------------------------------------------------

test('a sheet is emitted scoped for Trussal and allowlisted for the page', () => {
  const { sheets } = rewriteCssCalls('$: css(`.example {}`).color("red").width("40px")');
  const scss = buildPeerScss(sheets, { peerClass: 'tc-p-abc' });

  // Scoped copy carries everything, with the id that gives it the specificity.
  assert.match(scss, /#trussal-studio-overlay[\s\S]*\.example \{[\s\S]*width: var\(--cc-cc0-width\)/);
  // The bare copy carries colour but not width.
  const bare = scss.slice(scss.lastIndexOf('}') + 1);
  assert.match(scss, /color: var\(--cc-cc0-color\)/);
  assert.doesNotMatch(bare, /width/);
});

test('keyframes are namespaced per peer and their references rewritten', () => {
  const { sheets } = rewriteCssCalls(
    '$: css(`.x { animation: spin 2s linear infinite }\n@keyframes spin { to { rotate: 1turn } }`)',
  );
  const scss = buildPeerScss(sheets, { peerClass: 'tc-p-abc' });
  // Two performers animating `spin` must not collide.
  assert.match(scss, /@keyframes tc-p-abc-spin/);
  assert.match(scss, /animation: tc-p-abc-spin 2s linear infinite/);
});

test('a refused statement contributes nothing to the sheet', () => {
  const { sheets } = rewriteCssCalls('$: css(`.x { display: none }`)');
  assert.equal(buildPeerScss(sheets, { peerClass: 'tc-p-abc' }).trim(), '');
});

// --- the receiving side ------------------------------------------------------
//
// The sidecar compiles whatever it is sent and cannot tell an honest client
// from a patched one, so these are the room's actual defence.

test('an honest compiled sheet is accepted', () => {
  assert.deepEqual(checkCompiledCss('.example{color:red;background-color:blue}'), []);
  assert.deepEqual(checkCompiledCss('#trussal-studio-overlay .a{width:40px}'), []);
  assert.deepEqual(checkCompiledCss('@media(max-width:600px){#trussal-studio-overlay .a{color:red}}'), []);
  assert.deepEqual(checkCompiledCss('@keyframes k{to{transform:rotate(360deg)}}'), []);
});

test('a sheet that never passed an outbound guardrail is refused inbound', () => {
  for (const css of [
    '.videocontainer{display:none}',
    'body{width:0}',
    '.toolbox{opacity:0}',
    '@media(max-width:600px){.toolbox{visibility:hidden}}',
    '@keyframes k{to{transform:translateX(-9999px)}}',
    '#trussal-studio-overlay .a{z-index:-99}',
  ]) {
    assert.ok(checkCompiledCss(css).length > 0, `should refuse: ${css}`);
  }
});

test('a selector cannot escape its Trussal scope to earn the full property set', () => {
  // Starting at the root is not enough — a sibling combinator leaves it.
  assert.ok(checkCompiledCss('#trussal-studio-overlay ~ *{display:none}').length > 0);
  // One escaping alternative holds the whole rule to the allowlist, since they
  // share a declaration block.
  assert.ok(checkCompiledCss('#trussal-studio-overlay .a,body{display:none}').length > 0);
});

test('the hot path plumbing is not mistaken for a value to police', () => {
  // The var() is assigned per hap and checked there, not here.
  assert.deepEqual(checkCompiledCss('.a{color:var(--cc-cc0-color)}'), []);
});

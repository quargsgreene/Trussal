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
  selectorOf,
} from '../src/css-cycles-core.js';

// --- declaring the capability -----------------------------------------------

test('initCss declares styling presence, the other capabilities do not', () => {
  assert.equal(hasCssCycles('await initCss()\n\n$: css(`.x {}`)'), true);
  assert.equal(hasCssCycles('await initTextCycles()\n\n$: word("hi")'), false);
  assert.equal(hasCssCycles('await initHydra()\n\n$: s("bd")'), false);
  assert.equal(hasCssCycles('$: css(`.x {}`)'), false);
});


test('camelCase chain names map to hyphenated properties', () => {
  assert.equal(cssPropForMethod('borderRadius'), 'border-radius');
  assert.equal(cssPropForMethod('color'), 'color');
  assert.equal(cssPropForMethod('backgroundImage'), 'background-image');
  assert.equal(cssPropForMethod('webkitTextFillColor'), '-webkit-text-fill-color');
  assert.equal(methodForCssProp('border-radius'), 'borderRadius');
  assert.equal(methodForCssProp('-webkit-text-fill-color'), 'webkitTextFillColor');
});

test('Strudel structural methods are not CSS properties', () => {
  for (const name of ['fast', 'slow', 'every', 'off', 'jux', 'rev', 'segment', 'euclid', 'degrade']) {
    assert.equal(cssPropForMethod(name), null, `${name} should not be a CSS property`);
  }
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

test('a css statement becomes a scss token plus namespaced property controls', () => {
  const src = '$: css(`.example { color: red }`).color("<#fff #eee>").borderRadius("2em").fast(3)';
  const { code, atoms, sheets } = rewriteCssCalls(src, { peer: 'abc' });

  assert.match(code, /css\("cc0"\)/);
  assert.match(code, /\._cc_color\("<cc1 cc2>"\)/);
  assert.match(code, /\._cc_borderRadius\("cc3"\)/);
  assert.match(code, /\.fast\(3\)/);
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

test('css() takes a quoted selector, so camelCase properties chain off it', () => {
  // The form the docs show, and the only one mondo can write on one line.
  for (const quoted of ['".ts-chip"', "'.ts-chip'"]) {
    const { code, atoms, sheets, errors } = rewriteCssCalls(
      `$:css(${quoted})\n.borderRadius("<1em 2em>")`, { peer: 'abc' });
    assert.deepEqual(errors, []);
    assert.match(code, /css\("cc0"\)\._cc_borderRadius\("<cc1 cc2>"\)/);
    assert.doesNotMatch(code, /\.borderRadius\(/);
    assert.equal(atoms.cc0.text, '.ts-chip {}');
    assert.equal(selectorOf(sheets[0]), '.ts-chip');
    assert.deepEqual(sheets[0].props.map((p) => p.prop), ['border-radius']);
  }
});

test('css() takes SCSS in plain quotes too, unescaping them', () => {
  const { atoms, errors } = rewriteCssCalls('$: css(".x { content: \\"a\\" }").color("red")', { peer: 'abc' });
  assert.deepEqual(errors, []);
  assert.equal(atoms.cc0.text, '.x { content: "a" }');
});

test('a css() that cannot be read is refused without taking the program down', () => {
  // Left in place its `.borderRadius` reaches Strudel raw, and that throw stops
  // every voice in the room, not just this one.
  for (const bad of ['css(sel)', 'css("")', 'css(`.a`, 2)', 'css()']) {
    const { code, errors, sheets } = rewriteCssCalls(`$: s("bd")\n\n$: ${bad}.borderRadius("1em")`, { peer: 'abc' });
    assert.equal(errors.length, 1, bad);
    assert.match(errors[0], /selector or SCSS/);
    assert.equal(code, '$: s("bd")', bad);
    assert.deepEqual(sheets, []);
  }
});

test('every css() in a statement is rewritten, not just the first', () => {
  const { code, sheets, errors } = rewriteCssCalls(
    '$: stack(css(`.a {}`).color("red"), css(`.b {}`).borderRadius("1em"))', { peer: 'abc' });
  assert.deepEqual(errors, []);
  assert.doesNotMatch(code, /\.borderRadius\(/);
  assert.match(code, /_cc_borderRadius/);
  assert.deepEqual(sheets.map(selectorOf), ['.a', '.b']);
  assert.equal(code.match(/\._ccRender\(\)/g).length, 1);
});

test('a css() nested in a chained call is rewritten', () => {
  const { code, sheets } = rewriteCssCalls(
    '$: css(`.a {}`).color("red").stack(css(`.b {}`).borderRadius("1em")).fast(2)', { peer: 'abc' });
  assert.doesNotMatch(code, /\.borderRadius\(/);
  assert.match(code, /\.fast\(2\)/);
  assert.equal(sheets.length, 2);
});

test('comments inside a chain do not end it', () => {
  const { code, sheets } = rewriteCssCalls(
    '$: css(`.a {}`)\n  // round it\n  .borderRadius("1em")\n  /* then tint */\n  .color("red")', { peer: 'abc' });
  assert.doesNotMatch(code, /\.borderRadius\(/);
  assert.deepEqual(sheets[0].props.map((p) => p.prop), ['border-radius', 'color']);
});

test('multi-line SCSS stays one statement, whatever its lines look like', () => {
  const bodies = [
    '.a {\n  color: #eee;\n}',                  // reads as a label
    '.a {\n  color: #eee;\n\n  margin: 0;\n}',  // a blank line
    'a:hover {\n  color: #eee;\n}',             // the selector reads as a label too
    '/* note: here */\n.a {\n  color: #eee;\n}',
  ];
  for (const body of bodies) {
    const { code, atoms, sheets, errors } = rewriteCssCalls(`$: css(\`${body}\`).borderRadius("1em")`, { peer: 'abc' });
    assert.deepEqual(errors, [], body);
    assert.equal(atoms.cc0.text, body);
    assert.equal(sheets.length, 1, body);
    assert.equal(code, '$: css("cc0")._cc_borderRadius("cc1")\n._ccRender()', body);
  }
});

test('a real label after multi-line SCSS still starts its own statement', () => {
  const { code } = rewriteCssCalls('$: css(`.a {\n  color: #eee;\n}`).color("red")\n$: s("bd")', { peer: 'abc' });
  assert.match(code, /\._ccRender\(\)\n\$: s\("bd"\)$/);
});

test('keepSilentStatements keeps a whole multi-line css() and drops the audio', () => {
  const css = '$: css(`.a {\n  color: #eee;\n\n  margin: 0;\n}`).borderRadius("1em")';
  assert.equal(keepSilentStatements(`${css}\n\n$: s("bd")`), css);
});

test('css( inside a string or comment is not a call', () => {
  for (const src of ['$: word("try css(foo) out")', '$: s("bd") // css(foo) later']) {
    const { code, errors, sheets } = rewriteCssCalls(src, { peer: 'abc' });
    assert.equal(code, src);
    assert.deepEqual(errors, []);
    assert.deepEqual(sheets, []);
  }
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
  assert.ok(checkCompiledCss('#trussal-studio-overlay ~ *{display:none}').length > 0);
  assert.ok(checkCompiledCss('#trussal-studio-overlay .a,body{display:none}').length > 0);
});

test('the hot path plumbing is not mistaken for a value to police', () => {
  assert.deepEqual(checkCompiledCss('.a{color:var(--cc-cc0-color)}'), []);
});

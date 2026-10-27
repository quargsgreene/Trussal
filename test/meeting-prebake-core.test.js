import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';

import {
  parsePrebake,
  validatePrebake,
  assembleProgram,
  themePatch,
  gestureConfigWithDefaults,
  humanEntryFor,
  codeFileStore,
  chatKindFor,
  flattenFiles,
  flattenSamples,
  botsForOwner,
  spawnCountFor,
  chatEntryFor,
  chatMessages,
  editorLanguageFor,
  latestFiringAt,
  nextFiringAt,
  settingsFiringAt,
  metaprogramApplierIndex,
  PREBAKE_MAX_BYTES,
  MIN_ALTERNATIVE_INTERVAL_S,
  TOP_LEVEL_KEYS,
  HUMAN_KEYS,
  CODE_KEYS,
  THEME_KEYS,
} from '../src/meeting-prebake-core.js';
import { readDirective } from '../src/program-directive.js';
import { splitHydraCode } from '../src/hydra-code.js';
import { parseMetaprogram } from './helpers/metaprogram.js';
import { DEFAULT_GESTURE_MAPPINGS, CURSOR_TUNING } from '../src/landmark-gesture-core.js';
import { DEFAULT_FONT, DEFAULT_FONT_SCALE } from '../src/theme-context.js';

const EXAMPLES = new URL('../examples/prebake/', import.meta.url);

test('every shipped example prebake validates with no errors or warnings', () => {
  const names = readdirSync(EXAMPLES).filter((n) => n.endsWith('.json'));
  assert.ok(names.length >= 4, 'expected the full example plus a few smaller ones');
  for (const name of names) {
    const { ok, errors, warnings } = parsePrebake(readFileSync(new URL(name, EXAMPLES), 'utf8'));
    assert.deepEqual(errors, [], name);
    assert.deepEqual(warnings, [], name);
    assert.equal(ok, true, name);
  }
});

test('every shipped example metaprogram parses, alternatives\' included', () => {
  for (const name of readdirSync(EXAMPLES).filter((n) => n.endsWith('.json'))) {
    const prebake = JSON.parse(readFileSync(new URL(name, EXAMPLES), 'utf8'));
    const all = [prebake.metaprogram, ...(prebake.alternatives || []).map((a) => a.settings.metaprogram)];
    for (const metaprogram of all) {
      if (metaprogram == null) continue;
      assert.deepEqual(parseMetaprogram(metaprogram).errors, [], name);
    }
  }
});

test('the shipped examples cover every top-level, human, code and theme property between them', () => {
  const seen = { top: new Set(), human: new Set(), code: new Set(), theme: new Set() };
  const visit = (settings) => {
    for (const k of Object.keys(settings)) seen.top.add(k);
    for (const entry of [...Object.values(settings.humans || {}), ...Object.values(settings.bots || {})]) {
      for (const k of Object.keys(entry)) seen.human.add(k);
      for (const k of Object.keys(entry.code || {})) seen.code.add(k);
      for (const k of Object.keys(entry.personalTheme || {})) seen.theme.add(k);
    }
  };
  for (const name of readdirSync(EXAMPLES).filter((n) => n.endsWith('.json'))) {
    const prebake = JSON.parse(readFileSync(new URL(name, EXAMPLES), 'utf8'));
    visit(prebake);
    for (const alt of prebake.alternatives || []) visit(alt.settings);
  }
  for (const k of TOP_LEVEL_KEYS) assert.ok(seen.top.has(k), `no example uses $.${k}`);
  for (const k of HUMAN_KEYS) assert.ok(seen.human.has(k), `no example uses a human's ${k}`);
  for (const k of CODE_KEYS) assert.ok(seen.code.has(k), `no example uses code.${k}`);
  for (const k of THEME_KEYS) assert.ok(seen.theme.has(k), `no example uses personalTheme.${k}`);
});

test('an empty object is a valid (no-op) prebake', () => {
  assert.deepEqual(validatePrebake({}), { errors: [], warnings: [] });
});

test('parsePrebake rejects non-JSON, non-objects and oversize files', () => {
  assert.equal(parsePrebake('{ nope').ok, false);
  assert.match(parsePrebake('[]').errors[0], /JSON object/);
  assert.match(parsePrebake(' '.repeat(PREBAKE_MAX_BYTES + 1)).errors[0], /limit/);
});

test('human and bot keys must be the right kind of participant token', () => {
  const { errors } = validatePrebake({
    humans: { '0a': {}, abc: {}, 1: {} },
    bots: { 2: {}, '1b': {}, '1bc': {} },
  });
  assert.equal(errors.length, 4);
  assert.ok(errors.some((e) => e.startsWith('$.humans.0a')));
  assert.ok(errors.some((e) => e.startsWith('$.humans.abc')));
  assert.ok(errors.some((e) => e.startsWith('$.bots.2')));
  assert.ok(errors.some((e) => e.startsWith('$.bots.1bc')));
});

test('unknown properties and human-only settings on bots are warnings, not errors', () => {
  const { errors, warnings } = validatePrebake({
    extra: 1,
    humans: { 0: { colour: 'red' } },
    bots: { '0a': { personalTheme: {}, gestureAndLandmarkConfig: {}, enableMediaPipe: true } },
  });
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.startsWith('$.extra')));
  assert.ok(warnings.some((w) => w.startsWith('$.humans.0.colour')));
  assert.ok(warnings.some((w) => w.startsWith('$.bots.0a.personalTheme')));
  assert.ok(warnings.some((w) => w.startsWith('$.bots.0a.gestureAndLandmarkConfig')));
  assert.ok(warnings.some((w) => w.startsWith('$.bots.0a.enableMediaPipe')));
});

test('theme values are checked against what the theme store accepts', () => {
  const { errors } = validatePrebake({
    humans: {
      0: {
        personalTheme: {
          primaryColor: 'red', secondaryColor: '#123', invert: 'yes',
          fontFamily: 'Comic Sans MS', fontSize: 9,
        },
      },
    },
  });
  assert.ok(errors.some((e) => e.includes('primaryColor')));
  assert.ok(!errors.some((e) => e.includes('secondaryColor')));
  assert.ok(errors.some((e) => e.includes('invert')));
  assert.ok(errors.some((e) => e.includes('fontFamily')));
  assert.ok(errors.some((e) => e.includes('fontSize')));
});

test('gestureAndLandmarkConfig is validated by the same rule the live call uses', () => {
  const bad = validatePrebake({ humans: { 0: { gestureAndLandmarkConfig: { gestureMappings: 'smile' } } } });
  assert.match(bad.errors[0], /gestureMappings must be an array/);
  const good = validatePrebake({
    humans: { 0: { gestureAndLandmarkConfig: { gestureMappings: [{ trigger: 'smile', action: 'play' }], cursorSpeed: 0.3 } } },
  });
  assert.deepEqual(good.errors, []);
});

test('file entries need a bare name, a fetchable src and the right bucket', () => {
  const { errors } = validatePrebake({
    humans: {
      0: {
        code: {
          files: {
            images: [{ name: 'a.png', src: 'https://x/a.png' }, { name: 'b.mp4', src: 'https://x/b.mp4' }],
            csv: [{ name: 'd.tsv', src: '/d.tsv' }],
            text: [{ name: 'dir/n.txt', src: '/n.txt' }],
            other: [{ name: 'x.exe', src: '/x.exe' }],
            json: [{ name: 'w.json', src: 'ftp://x/w.json' }],
          },
          samples: { 'bad bank': [], drums: [{ name: 'k.txt', src: '/k.txt' }] },
        },
      },
    },
  });
  for (const fragment of ['images[1]', 'csv[0]', 'text[0].name', 'other[0]', 'json[0].src', 'bad bank', 'drums[0]']) {
    assert.ok(errors.some((e) => e.includes(fragment)), fragment);
  }
  assert.ok(!errors.some((e) => e.includes('images[0]')));
});

test('chat "other" accepts any file, a participant\'s "other" only addressable ones', () => {
  const chat = validatePrebake({ meetingChat: { Ada: { files: { other: [{ name: 'notes.zip', src: '/n.zip' }] } } } });
  assert.deepEqual(chat.errors, []);
  const code = validatePrebake({ humans: { 0: { code: { files: { other: [{ name: 'notes.zip', src: '/n.zip' }] } } } } });
  assert.equal(code.errors.length, 1);
});

test('assembleProgram joins the parts Hydra-first under the editor directive', () => {
  const program = assembleProgram({
    strudel: '$: s("bd*4")',
    hydra: 'osc(10).out()',
    text: '$: word("<hi there>")',
    css: '$: css("<.a .b>")',
    reactions: '$: reaction("<su la>")',
  }, 'personal');
  assert.equal(readDirective(program).kind, 'personal');
  const split = splitHydraCode(program);
  assert.ok(split, 'the assembled program is still Hydra');
  // The other capability preambles are spliced in at evaluation time, after
  // the Hydra the prebake supplied.
  assert.match(split.preamble, /^await initHydra\(\)\nosc\(10\)\.out\(\)(\n|$)/);
  assert.ok(split.strudel.indexOf('s("bd*4")') < split.strudel.indexOf('word('));
  assert.ok(split.strudel.indexOf('word(') < split.strudel.indexOf('css('));
  assert.ok(split.strudel.indexOf('css(') < split.strudel.indexOf('reaction('));
});

test('assembleProgram keeps an explicit initHydra, tags bots, and is null with no source', () => {
  const program = assembleProgram({ hydra: 'await initHydra({ detectAudio: false })\nosc().out()' }, 'bot');
  assert.equal(readDirective(program).kind, 'bot');
  assert.equal((program.match(/initHydra/g) || []).length, 1);
  assert.equal(assembleProgram({ samples: { a: [] } }, 'personal'), null);
  assert.equal(assembleProgram({ strudel: '   ' }, 'personal'), null);
  assert.equal(assembleProgram(null, 'personal'), null);
});

test('themePatch maps prebake names onto the theme store', () => {
  assert.deepEqual(themePatch({
    primaryColor: '#ABC', secondaryColor: '', invert: true, darkMode: false,
    fontFamily: 'Georgia', fontSize: 1.5, disableCssChanges: true,
  }), {
    primary: '#aabbcc', secondary: '', invert: true, darkMode: false,
    font: 'Georgia, "Times New Roman", serif', fontScale: 1.5, disableCss: true,
  });
  assert.equal(themePatch({ fontFamily: 'Arial' }).font, 'Arial, Helvetica, sans-serif');
});

test('themePatch falls back to the default theme for anything left out', () => {
  const defaults = {
    primary: '', secondary: '', invert: false, darkMode: false,
    font: DEFAULT_FONT, fontScale: DEFAULT_FONT_SCALE, disableCss: false,
  };
  assert.deepEqual(themePatch(undefined), defaults);
  assert.deepEqual(themePatch({}), defaults);
  assert.deepEqual(themePatch({ darkMode: true }), { ...defaults, darkMode: true });
});

test('gestureConfigWithDefaults fills the gesture map and tuning, not the limbs', () => {
  const defaults = gestureConfigWithDefaults(undefined);
  assert.deepEqual(defaults.gestureMappings, DEFAULT_GESTURE_MAPPINGS);
  assert.notEqual(defaults.gestureMappings[0], DEFAULT_GESTURE_MAPPINGS[0], 'a copy, not the shared default');
  for (const [key, { default: fallback }] of Object.entries(CURSOR_TUNING)) assert.equal(defaults[key], fallback, key);
  for (const limb of ['virtualKeyboardEnabled', 'headCursorEnabled', 'gestureDetectionEnabled']) {
    assert.equal(limb in defaults, false, limb);
  }
  const given = gestureConfigWithDefaults({
    gestureMappings: [{ trigger: 'smile', action: 'stop' }], cursorGain: 2, headCursorEnabled: false,
  });
  assert.deepEqual(given.gestureMappings, [{ trigger: 'smile', action: 'stop' }]);
  assert.equal(given.cursorGain, 2);
  assert.equal(given.cursorSpeed, CURSOR_TUNING.cursorSpeed.default);
  assert.equal(given.headCursorEnabled, false);
});

test('code files route tabular buckets to data packs and the rest to file cycles', () => {
  assert.equal(codeFileStore('csv'), 'data');
  assert.equal(codeFileStore('tsv'), 'data');
  assert.equal(codeFileStore('json'), 'data');
  for (const b of ['images', 'video', 'text', 'other']) assert.equal(codeFileStore(b), 'files');
});

test('chat attachments render as their medium, or as a download link', () => {
  assert.equal(chatKindFor('images', 'a.png'), 'image');
  assert.equal(chatKindFor('video', 'a.mov'), 'video');
  assert.equal(chatKindFor('text', 'a.txt'), 'textFile');
  assert.equal(chatKindFor('csv', 'a.csv'), 'textFile');
  assert.equal(chatKindFor('other', 'a.pdf'), 'pdfFile');
  assert.equal(chatKindFor('other', 'a.wav'), 'soundFile');
  assert.equal(chatKindFor('other', 'a.zip'), 'textFile');
});

test('flattenFiles and flattenSamples list every entry with its bucket or bank', () => {
  assert.deepEqual(flattenFiles({ json: [{ name: 'w.json', src: '/w' }], images: [{ name: 'a.png', src: '/a' }] }), [
    { bucket: 'images', name: 'a.png', src: '/a' },
    { bucket: 'json', name: 'w.json', src: '/w' },
  ]);
  assert.deepEqual(flattenSamples({ kit: [{ name: 'k.wav', src: '/k' }] }), [{ bank: 'kit', name: 'k.wav', src: '/k' }]);
  assert.deepEqual(flattenFiles(undefined), []);
});

test('botsForOwner picks one human\'s cluster in suffix order', () => {
  const prebake = { bots: { '0c': { n: 3 }, '0a': { n: 1 }, '1a': { n: 9 }, '0za': { n: 27 } } };
  assert.deepEqual(botsForOwner(prebake, '0').map((b) => [b.token, b.ordinal]), [['0a', 0], ['0c', 2], ['0za', 26]]);
  assert.deepEqual(botsForOwner(prebake, 1).map((b) => b.token), ['1a']);
  assert.deepEqual(botsForOwner({}, '0'), []);
});

test('spawnCountFor fills every free suffix up to the highest one listed', () => {
  assert.equal(spawnCountFor([], [0]), 0);
  assert.equal(spawnCountFor([0, 1], []), 2);
  assert.equal(spawnCountFor([0, 2], []), 3);
  assert.equal(spawnCountFor([0, 2], [0]), 2);
  assert.equal(spawnCountFor([0, 1], [0, 1, 2]), 0);
});

test('chatEntryFor matches display names loosely; chatMessages normalises text', () => {
  const prebake = { meetingChat: { ' Ada Lovelace ': { text: ['hi', '  ', 'there '] }, Bo: { text: 'yo' } } };
  assert.deepEqual(chatMessages(chatEntryFor(prebake, 'ada lovelace')), ['hi', 'there']);
  assert.deepEqual(chatMessages(chatEntryFor(prebake, 'Bo')), ['yo']);
  assert.equal(chatEntryFor(prebake, 'Cy'), null);
  assert.equal(chatEntryFor(prebake, ''), null);
  assert.deepEqual(chatMessages(null), []);
});

test('applySettingsToExistingParticipants is an optional boolean', () => {
  assert.deepEqual(validatePrebake({ applySettingsToExistingParticipants: true }).errors, []);
  assert.deepEqual(validatePrebake({ applySettingsToExistingParticipants: false }).errors, []);
  assert.match(validatePrebake({ applySettingsToExistingParticipants: 'yes' }).errors[0], /applySettingsToExistingParticipants/);
});

test('humanEntryFor resets unlisted humans only when applySettingsToExistingParticipants is set', () => {
  const own = { displayName: 'Ada' };
  assert.equal(humanEntryFor({ humans: { 0: own } }, '0'), own);
  assert.equal(humanEntryFor({ humans: { 0: own } }, '1'), null);
  assert.equal(humanEntryFor({}, 0), null);
  assert.equal(humanEntryFor({ applySettingsToExistingParticipants: false }, '1'), null);
  assert.deepEqual(humanEntryFor({ humans: { 0: own }, applySettingsToExistingParticipants: true }, '1'), {});
  assert.equal(humanEntryFor({ humans: { 0: own }, applySettingsToExistingParticipants: true }, '0'), own);
});

test('customEmoji is a human-only list of uniquely named images', () => {
  const png = 'data:image/png;base64,iVBORw0KGgo=';
  assert.deepEqual(validatePrebake({ humans: { 0: { customEmoji: [{ name: 'party.png', src: png }] } } }).errors, []);
  const { errors } = validatePrebake({ humans: { 0: { customEmoji: [
    { name: 'song.wav', src: png },
    { name: 'Party.png', src: png },
    { name: 'party.gif', src: png },
  ] } } });
  assert.equal(errors.length, 2);
  assert.match(errors[0], /customEmoji\[0\]\.name: "song\.wav" is not an image/);
  assert.match(errors[1], /customEmoji\[2\]\.name: another emoji is already named :party:/);
  assert.match(validatePrebake({ humans: { 0: { customEmoji: {} } } }).errors[0], /expected an array/);
  const bot = validatePrebake({ bots: { '0a': { customEmoji: [] } } });
  assert.deepEqual(bot.errors, []);
  assert.ok(bot.warnings.some((w) => w.startsWith('$.bots.0a.customEmoji: bots have no custom emoji')));
});

test('backing(), breakout(), assign() and meeting() literals are checked at upload', () => {
  const ok = validatePrebake({ humans: { 0: { code: { strudel: [
    '$: backing("song.wav", true, false)',
    '$: breakout({"name":"<room main>", "participants": ["0", "1"]}).slow(4)',
    '$: assign({"name":"room", "participants": ["2"]})',
    '$: meeting({"name":"<jam2 main>", "participants": ["0a"]}).slow(8)',
  ].join('\n') } } } });
  assert.deepEqual(ok, { errors: [], warnings: [] });

  const { errors } = validatePrebake({ humans: { 0: { code: {
    strudel: '$: backing("notes.txt")\n$: breakout({"participants": ["0"]})',
    text: '$: meeting({"name": "two words"})',
  } } } });
  assert.equal(errors.length, 3);
  assert.match(errors[0], /^\$\.humans\.0\.code\.strudel: backing\("notes\.txt"\) is not an audio or video file/);
  assert.match(errors[1], /^\$\.humans\.0\.code\.strudel: breakout\(\): "name"/);
  assert.match(errors[2], /^\$\.humans\.0\.code\.text: meeting\(\): "two words" is not a meeting name/);
});

test('a bot\'s backing() is a warning: bots cannot play backing files', () => {
  const { errors, warnings } = validatePrebake({ bots: { '0a': { code: { strudel: '$: backing("song.wav")' } } } });
  assert.deepEqual(errors, []);
  assert.ok(warnings.some((w) => w.startsWith('$.bots.0a.code.strudel: bots cannot play backing()')));
});

test('alternatives: settings validated like the prebake, timeout and interval checked', () => {
  assert.deepEqual(validatePrebake({ alternatives: [
    { settings: { humans: { 0: { displayName: 'A' } } }, timeout: 0 },
    { settings: { metaprogram: '$ participants <0>\n' }, timeout: 30, interval: 60 },
  ] }), { errors: [], warnings: [] });

  const { errors, warnings } = validatePrebake({ alternatives: [
    { settings: { humans: { '0a': {} }, alternatives: [] }, timeout: -1, interval: MIN_ALTERNATIVE_INTERVAL_S - 1, extra: 1 },
    { timeout: 'soon' },
    'nope',
  ] });
  assert.deepEqual(errors, [
    '$.alternatives[0].settings.alternatives: alternatives cannot nest',
    '$.alternatives[0].settings.humans.0a: a human\'s token is a plain integer ("0", "1", …)',
    '$.alternatives[0].timeout: expected the seconds after upload it first applies (0 or more)',
    `$.alternatives[0].interval: expected the seconds between repeats (${MIN_ALTERNATIVE_INTERVAL_S} or more), or leave it out to apply once`,
    '$.alternatives[1].settings: expected an object of prebake settings',
    '$.alternatives[1].timeout: expected the seconds after upload it first applies (0 or more)',
    '$.alternatives[2]: expected { "settings", "timeout", "interval" }',
  ]);
  assert.deepEqual(warnings, ['$.alternatives[0].extra: unknown property, ignored']);
  assert.match(validatePrebake({ alternatives: {} }).errors[0], /^\$\.alternatives: expected an array/);
});

test('alternatives fire at timeout, then every interval, as setTimeout/setInterval would', () => {
  const a = { humans: { 0: { displayName: 'A' } } };
  const b = { humans: { 0: { displayName: 'B' } } };
  const once = { meetingChat: { A: { text: 'once' } } };
  const prebake = { alternatives: [
    { settings: a, timeout: 30, interval: 60 },
    { settings: b, timeout: 60, interval: 60 },
    { settings: once, timeout: 45 },
  ] };
  assert.equal(latestFiringAt(prebake, 29999), null);
  assert.equal(nextFiringAt(prebake, 0), 30000);
  assert.equal(latestFiringAt(prebake, 30000), 30000);
  assert.equal(nextFiringAt(prebake, 30000), 45000);
  assert.equal(nextFiringAt(prebake, 45000), 60000);
  assert.equal(latestFiringAt(prebake, 100000), 90000);
  assert.equal(nextFiringAt(prebake, 100000), 120000);
  assert.deepEqual(settingsFiringAt(prebake, 30000), [a]);
  assert.deepEqual(settingsFiringAt(prebake, 45000), [once]);
  assert.deepEqual(settingsFiringAt(prebake, 90000), [a]);
  assert.deepEqual(settingsFiringAt(prebake, 120000), [b]);
  assert.deepEqual(settingsFiringAt(prebake, 105000), []);
  // Same instant: both, in file order.
  const tied = { alternatives: [{ settings: a, timeout: 10 }, { settings: b, timeout: 10 }] };
  assert.deepEqual(settingsFiringAt(tied, 10000), [a, b]);
  assert.equal(nextFiringAt(tied, 10000), null);
  assert.equal(nextFiringAt({}, 0), null);
  assert.equal(latestFiringAt({}, 1e9), null);
});

test('an alternative\'s metaprogram is set by the uploader, else the lowest human present', () => {
  assert.equal(metaprogramApplierIndex(2, [0, 1, 2]), 2);
  assert.equal(metaprogramApplierIndex(2, [3, 1]), 1);
  assert.equal(metaprogramApplierIndex(null, [4]), 4);
  assert.equal(metaprogramApplierIndex(0, []), null);
});

test('code.language picks an editor language from the dropdown\'s ids; source is its buffer', () => {
  assert.deepEqual(validatePrebake({ humans: { 0: { code: { language: 'tidal', source: 'd1 $ sound "bd*2"' } } } }),
    { errors: [], warnings: [] });
  const bad = validatePrebake({ humans: { 0: { code: { language: 'cobol', source: 3 } } } });
  assert.match(bad.errors[0], /^\$\.humans\.0\.code\.language: expected one of "jpattern", "strudel"/);
  assert.equal(bad.errors[1], '$.humans.0.code.source: expected a string');
  // A source with no other language to go into is dropped.
  for (const code of [{ source: 'x' }, { language: 'jpattern', source: 'x' }]) {
    const { errors, warnings } = validatePrebake({ humans: { 0: { code } } });
    assert.deepEqual(errors, []);
    assert.match(warnings[0], /^\$\.humans\.0\.code\.source: only used with a "language" other than "jpattern"/);
  }
  const bot = validatePrebake({ bots: { '0a': { code: { language: 'sonicpi' } } } });
  assert.deepEqual(bot.errors, []);
  assert.deepEqual(bot.warnings, ['$.bots.0a.code.language: bots only run JPattern, ignored']);
});

test('a pure Strudel source is checked like the JPattern parts; a terminal language\'s is not', () => {
  const strudel = validatePrebake({ humans: { 0: { code: { language: 'strudel', source: '$: backing("notes.txt")' } } } });
  assert.match(strudel.errors[0], /^\$\.humans\.0\.code\.source: backing\("notes\.txt"\)/);
  assert.deepEqual(validatePrebake({ humans: { 0: { code: { language: 'sclang', source: 'backing("notes.txt")' } } } }).errors, []);
});

test('editorLanguageFor: JPattern by default and always on the assembled program', () => {
  assert.deepEqual(editorLanguageFor(undefined), { language: 'jpattern', source: null });
  assert.deepEqual(editorLanguageFor({ source: 'x' }), { language: 'jpattern', source: null });
  assert.deepEqual(editorLanguageFor({ language: 'punctual' }), { language: 'punctual', source: null });
  assert.deepEqual(editorLanguageFor({ language: 'tidal', source: 'd1 $ s "bd"' }), { language: 'tidal', source: 'd1 $ s "bd"' });
  assert.deepEqual(editorLanguageFor({ language: 'nope', source: 'x' }), { language: 'jpattern', source: null });
});

test('language and source are not program text: assembleProgram ignores them', () => {
  assert.equal(assembleProgram({ language: 'tidal', source: 'd1 $ s "bd"' }, 'personal'), null);
});

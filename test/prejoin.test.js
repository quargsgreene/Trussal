// prejoin.js is the DOM half: it renders the overlay, wires the form, persists
// the chosen name and clears itself. These tests drive it with a hand-rolled
// document/window (no jsdom) and assert the two behaviours the bootstrap relies
// on — the promise resolves with the submitted name once, and the screen leaves
// the DOM so the rest of the bundle stops treating the page as pre-meeting.

import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { renderPrejoin, getPrejoinDisplayName, hasRenderedPrejoin, removePrejoin } from '../src/prejoin.js';
import { DISPLAY_NAME_STORAGE_KEY, PREJOIN_NAME_INPUT_ID, PREJOIN_SCREEN_ID } from '../src/prejoin-core.js';

function fakeLocalStorage(initial = '') {
  const m = new Map();
  if (initial) m.set(DISPLAY_NAME_STORAGE_KEY, initial);
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    _map: m,
  };
}

// A document just rich enough for renderPrejoin: createElement with an
// innerHTML setter that registers the input it finds, an id->element map, and
// event listeners we can fire by hand.
function installDom({ stored = '' } = {}) {
  const byId = new Map();
  function makeEl(tag) {
    const el = {
      tagName: tag, id: '', className: '', style: {}, listeners: {}, children: [],
      value: '', textContent: '', _html: '', _form: null,
      appendChild(c) { this.children.push(c); if (c.id) byId.set(c.id, c); return c; },
      remove() { if (this.id) byId.delete(this.id); },
      addEventListener(name, cb) { (this.listeners[name] ||= []).push(cb); },
      focus() { this.focused = true; },
      querySelector(sel) {
        if (sel === 'form') return this._form;
        if (sel.startsWith('#')) return byId.get(sel.slice(1)) || null;
        return null;
      },
    };
    Object.defineProperty(el, 'innerHTML', {
      get() { return this._html; },
      set(v) {
        this._html = v;
        const idMatch = /id="([^"]+)"/.exec(v);
        if (idMatch) {
          const input = makeEl('input');
          input.id = idMatch[1];
          const valMatch = /value="([^"]*)"/.exec(v);
          input.value = valMatch ? valMatch[1] : '';
          byId.set(input.id, input);
        }
        this._form = makeEl('form');
      },
    });
    return el;
  }
  const body = makeEl('body');
  const head = makeEl('head');
  globalThis.document = { body, head, createElement: makeEl, getElementById: (id) => byId.get(id) || null };
  globalThis.window = { localStorage: fakeLocalStorage(stored) };
  return { byId };
}

function fireSubmit() {
  const screen = globalThis.document.getElementById(PREJOIN_SCREEN_ID);
  for (const cb of (screen._form.listeners.submit || [])) cb({ preventDefault() {} });
}

afterEach(() => { delete globalThis.document; delete globalThis.window; });

test('renderPrejoin resolves with the typed name, persists it, and clears itself', async () => {
  installDom();
  const promise = renderPrejoin({});
  assert.equal(hasRenderedPrejoin(), true);

  globalThis.document.getElementById(PREJOIN_NAME_INPUT_ID).value = '  Ada  ';
  fireSubmit();

  assert.equal(await promise, 'Ada');
  assert.equal(getPrejoinDisplayName(), 'Ada');
  assert.equal(hasRenderedPrejoin(), false, 'the overlay is gone once joined');
});

test('renderPrejoin prefills the field from the stored name', () => {
  installDom({ stored: 'Grace' });
  renderPrejoin({});
  assert.equal(globalThis.document.getElementById(PREJOIN_NAME_INPUT_ID).value, 'Grace');
});

test('renderPrejoin prefers an explicit initialName over storage', () => {
  installDom({ stored: 'stored' });
  renderPrejoin({ initialName: 'typed' });
  assert.equal(globalThis.document.getElementById(PREJOIN_NAME_INPUT_ID).value, 'typed');
});

test('renderPrejoin focuses the name field (landmark mode expects it)', () => {
  installDom();
  renderPrejoin({});
  assert.equal(globalThis.document.getElementById(PREJOIN_NAME_INPUT_ID).focused, true);
});

test('renderPrejoin resolves with the stored name and renders nothing when there is no DOM', async () => {
  globalThis.window = { localStorage: fakeLocalStorage('Ada') };
  // globalThis.document is deliberately undefined here.
  assert.equal(await renderPrejoin({}), 'Ada');
});

test('removePrejoin is safe when nothing was rendered', () => {
  installDom();
  assert.doesNotThrow(() => removePrejoin());
});

test('renderPrejoin resolves with the stored name if the DOM blows up', async () => {
  installDom({ stored: 'Ada' });
  globalThis.document.createElement = () => { throw new Error('no DOM for you'); };
  assert.equal(await renderPrejoin({}), 'Ada');
});

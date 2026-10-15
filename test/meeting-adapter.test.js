import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getConference,
  setConference,
  clearConference,
  hasInjectedConference,
} from '../src/meeting-adapter.js';

test('meeting-adapter: no conference by default in Node', () => {
  clearConference();
  assert.equal(getConference(), null);
  assert.equal(hasInjectedConference(), false);
});

test('meeting-adapter: setConference injects a handle and takes precedence', () => {
  const fake = { id: 'lib-jitsi-1' };
  setConference(fake);
  assert.equal(getConference(), fake);
  assert.equal(hasInjectedConference(), true);
  clearConference();
  assert.equal(getConference(), null);
});

test('meeting-adapter: setConference(null) clears the injected handle', () => {
  setConference({ id: 'x' });
  setConference(null);
  assert.equal(getConference(), null);
  assert.equal(hasInjectedConference(), false);
  clearConference();
});
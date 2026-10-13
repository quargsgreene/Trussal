import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  serializeMessage,
  deserializeMessage,
  CS_GET,
  CS_REPLY
} from '../src/audio-net/o2lite_driver.js';

test('validation errors', () => {
  assert.throws(() => serializeMessage({ address: 'no-slash', typespec: ',', args: [] }), TypeError);
  assert.throws(() => serializeMessage({ address: '/x', typespec: ',i', args: [] }), RangeError);
  assert.throws(() => serializeMessage({ address: '/x', typespec: ',q', args: [1] }), TypeError);
  assert.equal(typeof CS_REPLY, 'string');
});

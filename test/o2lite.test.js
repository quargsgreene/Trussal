import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  serializeMessage,
  deserializeMessage,
  CS_GET,
  CS_REPLY
} from '../src/audio-net/o2lite_driver.js';

test('round-trip: every supported typespec type', () => {
  const msg = {
    address: '/perf/1a/pattern',
    typespec: ',ifdtsbB',
    args: [42, 1.5, Math.PI, 123.456789, 'hello Ω world', new Uint8Array([1, 2, 3, 4, 5]), true],
    timestamp: 987.654321
  };
  const out = deserializeMessage(serializeMessage(msg));
  assert.equal(out.address, msg.address);
  assert.equal(out.typespec, msg.typespec);
  assert.equal(out.timestamp, msg.timestamp);
  assert.equal(out.args[0], 42);
  assert.ok(Math.abs(out.args[1] - 1.5) < 1e-7); // float32
  assert.equal(out.args[2], Math.PI);            // float64 exact
  assert.equal(out.args[3], 123.456789);
  assert.equal(out.args[4], 'hello Ω world');
  assert.deepEqual(Array.from(out.args[5]), [1, 2, 3, 4, 5]);
  assert.equal(out.args[6], true);
});

test('typespec comma is implied; empty args allowed', () => {
  const buf = serializeMessage({ address: '/hush', typespec: '', args: [] });
  const out = deserializeMessage(buf);
  assert.equal(out.address, '/hush');
  assert.equal(out.typespec, ',');
  assert.deepEqual(out.args, []);
});

test('4-byte alignment: odd-length strings and blobs still round-trip', () => {
  for (const s of ['a', 'ab', 'abc', 'abcd', 'abcde']) {
    for (const blobLen of [0, 1, 2, 3, 4, 7]) {
      const out = deserializeMessage(serializeMessage({
        address: `/x/${s}`,
        typespec: ',sbs',
        args: [s, new Uint8Array(blobLen).fill(9), s + s]
      }));
      assert.equal(out.args[0], s);
      assert.equal(out.args[1].length, blobLen);
      assert.equal(out.args[2], s + s);
      assert.equal(deserializeMessage(serializeMessage(out)).address, out.address);
    }
  }
});

test('deserialize accepts Node Buffers (ws delivers Buffers)', () => {
  const buf = serializeMessage({ address: CS_GET, typespec: ',it', args: [7, 1.25] });
  const nodeBuf = Buffer.from(buf);
  const out = deserializeMessage(nodeBuf);
  assert.equal(out.address, CS_GET);
  assert.deepEqual(out.args, [7, 1.25]);
});

test('validation errors', () => {
  assert.throws(() => serializeMessage({ address: 'no-slash', typespec: ',', args: [] }), TypeError);
  assert.throws(() => serializeMessage({ address: '/x', typespec: ',i', args: [] }), RangeError);
  assert.throws(() => serializeMessage({ address: '/x', typespec: ',q', args: [1] }), TypeError);
  assert.equal(typeof CS_REPLY, 'string');
});

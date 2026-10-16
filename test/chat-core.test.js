import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseChatMessage, chatByline, MAX_CHAT_MESSAGE_LENGTH } from '../src/chat-core.js';

test('normaliseChatMessage trims and caps', () => {
  assert.equal(normaliseChatMessage(' hi '), 'hi');
  assert.equal(normaliseChatMessage('  '), '');
  assert.equal(normaliseChatMessage(123), '');
  const long = 'a'.repeat(MAX_CHAT_MESSAGE_LENGTH + 5);
  assert.equal(normaliseChatMessage(long).length, MAX_CHAT_MESSAGE_LENGTH);
});

test('chatByline falls back safely', () => {
  assert.equal(chatByline('Alice'), 'Alice');
  assert.equal(chatByline('  Bob  '), 'Bob');
  assert.equal(chatByline('', 'fallback'), 'fallback');
  assert.equal(chatByline(null, 'x'), 'x');
  assert.equal(chatByline('', ''), 'participant');
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { turnError } from '../src/turn-error.ts';

test('nested provider model rejection gets a safe public diagnostic', () => {
  const message = JSON.stringify({ type: 'error', status: 400, error: {
    type: 'invalid_request_error', message: "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.",
  } });
  const error = turnError({ error: { message } });
  assert.equal(error.detail, message);
  assert.equal(error.summary, "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.");
});

test('arbitrary provider text stays private and missing error has a history fallback', () => {
  const error = turnError({ error: { message: 'Bearer secret-test-token' } });
  assert.equal(error.detail, 'Bearer secret-test-token');
  assert.ok(!error.summary.includes('secret-test-token'));
  assert.match(turnError({}).detail, /without an error description/);
});

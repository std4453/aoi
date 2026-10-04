import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runInNewContext } from 'node:vm';

// Execute the actual isolated-browser expression, with synthetic metadata only.
const source = fs.readFileSync(new URL('../../scripts/browser-login/capture.py', import.meta.url), 'utf8');
const expression = /LOGIN_STATE_EXPRESSION = """([\s\S]*?)"""/.exec(source)?.[1];
assert.ok(expression);
function loggedIn(content: string | null): unknown {
  return runInNewContext(expression!, {
    document: { querySelector: (selector: string) => {
      assert.equal(selector, 'meta#metadata');
      return content === null ? null : { content };
    } },
  }, { timeout: 100 });
}

test('FANBOX current home-page metadata confirms login without returning account data', () => {
  for (const userId of [123, '123']) {
    assert.equal(loggedIn(JSON.stringify({ context: { user: { userId, name: 'synthetic' } } })), true);
  }
  assert.equal(loggedIn(JSON.stringify({ user: { isLoggedIn: true } })), true);
});

test('anonymous, missing, malformed and invalid metadata cannot confirm login', () => {
  for (const content of [null, '', '{', '{}', JSON.stringify({ user: { isLoggedIn: false } }),
    ...[null, {}, { userId: '' }, { userId: 0 }, { userId: 'anonymous' }].map(user => JSON.stringify({ context: { user } })),
  ]) assert.equal(loggedIn(content), false);
});

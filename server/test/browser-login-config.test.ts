import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';

function accepts(internal: string, external: string, trusted = 'false') {
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', "await import('./src/config/index.ts')"], {
    cwd: new URL('../', import.meta.url), encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME,
      AOI_BROWSER_LOGIN_URL: internal, AOI_BROWSER_LOGIN_PUBLIC_URL: external,
      AOI_BROWSER_LOGIN_KEY_FILE: '/synthetic/key', AOI_BROWSER_LOGIN_TRUSTED_HTTP: trusted },
  });
  return result.status === 0;
}

test('private browser control HTTP requires explicit trust and never relaxes the public viewer', () => {
  assert.equal(accepts('http://127.0.0.1:43129', 'http://127.0.0.1:43130'), true);
  assert.equal(accepts('https://control.example.test', 'https://browser.example.test'), true);
  assert.equal(accepts('http://browser-service:43129', 'https://browser.example.test'), false);
  assert.equal(accepts('http://browser-service:43129', 'https://browser.example.test', 'true'), true);
  assert.equal(accepts('http://browser-service:43129', 'http://browser.example.test', 'true'), false);
  assert.equal(accepts('http://user:pass@browser-service:43129', 'https://browser.example.test', 'true'), false);
});

test('source and compiled config keep the repository data directory after moving into config/', () => {
  const expected = new URL('../../data', import.meta.url).pathname;
  for (const modulePath of ['./src/config/index.ts', './dist/server/src/config/index.js']) {
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e',
      `const { config } = await import(${JSON.stringify(modulePath)}); console.log(config.dataDir);`], {
      cwd: new URL('../', import.meta.url), encoding: 'utf8',
      env: { PATH: process.env.PATH, HOME: process.env.HOME },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), expected);
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error The standalone browser service intentionally has no npm dependencies.
import { launchSession } from '../../scripts/browser-login/session-runtime.mjs';

// Simulate a runner that holds sensitive temporary state until the parent closes
// its lease. Real Chromium/s6 lifecycle is covered by the opt-in container smoke.
const runner = `
const fs = require('node:fs');
const marker = process.argv[1];
let input = '';
process.stdin.on('data', data => {
  input += data;
  if (!input.includes('\\n')) return;
  fs.writeFileSync(marker, 'synthetic session');
  process.stdout.write('{"ready":true}\\n');
});
process.stdin.on('end', () => { fs.rmSync(marker, {force:true}); });
`;

test('browser session releases temporary state on cancellation and can be reused', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aoi-browser-runner-'));
  const marker = path.join(root, 'active');
  let ended = 0;
  try {
    for (let i = 0; i < 2; i++) {
      const session = launchSession({ provider: 'fanbox' }, (clean: boolean) => { assert.equal(clean, true); ended++; }, process.execPath, ['-e', runner, marker]);
      await session.ready;
      assert.equal(await fs.readFile(marker, 'utf8'), 'synthetic session');
      await session.close();
      await assert.rejects(fs.access(marker));
      await session.close();
    }
    assert.equal(ended, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('runner startup and cleanup failures reject without echoing subprocess output', async () => {
  const session = launchSession({}, () => {}, process.execPath, ['-e', "console.error('private diagnostic'); process.exit(1)"]);
  await assert.rejects(session.ready, /browser session ended/);
  await assert.rejects(session.close(), /browser cleanup failed/);
  const missing = launchSession({}, () => {}, '/aoi-missing-test-executable', []);
  await assert.rejects(missing.ready, /browser start failed/);
  await assert.rejects(missing.close(), /browser cleanup failed/);
});

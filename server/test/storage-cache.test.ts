import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('data size cache shares scans, serves stale values, and recovers from failures', { timeout: 10_000 }, async t => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-storage-cache-'));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = dataDir;
  t.after(() => {
    t.mock.restoreAll();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const { getTotalDataSize } = await import('../src/services/storage.js');
  const archiveDir = path.join(dataDir, 'archives');
  fs.mkdirSync(archiveDir);
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const readdir = fs.promises.readdir.bind(fs.promises);
  let scans = 0;
  let fail = true;
  let gate = Promise.resolve();
  t.mock.method(fs.promises, 'readdir', async (...args: Parameters<typeof readdir>) => {
    if (args[0] === archiveDir) {
      scans++;
      await gate;
      if (fail) throw Object.assign(new Error('access denied'), { code: 'EACCES' });
    }
    return readdir(...args);
  });
  const warnings = t.mock.method(console, 'warn', () => {});
  async function waitUntil(predicate: () => boolean | Promise<boolean>) {
    for (let attempt = 0; attempt < 1_000; attempt++) {
      if (await predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.fail('Cache refresh did not finish');
  }

  // A failed cold scan must reject and allow a later request to retry.
  await assert.rejects(getTotalDataSize(), /access denied/);
  fail = false;
  let release!: () => void;
  gate = new Promise<void>(resolve => { release = resolve; });
  const initial = Array.from({ length: 8 }, () => getTotalDataSize());
  await waitUntil(() => scans === 2);
  release();
  assert.deepEqual(await Promise.all(initial), Array(8).fill(0));
  assert.equal(scans, 2);

  // Zero is a valid cached value, and changes are hidden until expiry.
  fs.mkdirSync(path.join(archiveDir, 'pack'));
  fs.writeFileSync(path.join(archiveDir, 'pack', 'original.zip'), Buffer.alloc(123));
  now += 5 * 60 * 1_000 - 1;
  assert.equal(await getTotalDataSize(), 0);
  assert.equal(scans, 2);

  // Expired requests return without waiting for the blocked background scan.
  now++;
  gate = new Promise<void>(resolve => { release = resolve; });
  try {
    assert.deepEqual(await Promise.all(Array.from({ length: 8 }, () => getTotalDataSize())), Array(8).fill(0));
    await waitUntil(() => scans === 3);
  } finally {
    release();
  }
  await waitUntil(async () => await getTotalDataSize() === 123);
  assert.equal(scans, 3);

  // Failed refreshes preserve the last successful value and back off for 30s.
  fail = true;
  now += 5 * 60 * 1_000;
  assert.equal(await getTotalDataSize(), 123);
  await waitUntil(() => warnings.mock.callCount() === 1);
  now += 30 * 1_000 - 1;
  assert.equal(await getTotalDataSize(), 123);
  assert.equal(scans, 4);
  fail = false;
  fs.writeFileSync(path.join(archiveDir, 'pack', 'original.zip'), Buffer.alloc(456));
  now++;
  assert.equal(await getTotalDataSize(), 123);
  await waitUntil(async () => await getTotalDataSize() === 456);
  assert.equal(scans, 5);
});

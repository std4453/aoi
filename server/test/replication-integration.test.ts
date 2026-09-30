import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { startTestServer, stopTestServer, type TestServer } from './helpers/server-process.js';
import { startObjectStore } from './helpers/s3-store.js';

async function eventually(check: () => Promise<boolean>, message: string, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(message);
}
const status = async (server: TestServer) => await (await fetch(`${server.url}/api/system/replication`)).json() as {
  ready: boolean; generation: string; lastError: string | null; uploadedBlobs: number;
};

test('S3 primary/replica incrementally publish, retain old reads on failure, enforce read-only and restart offline', { timeout: 90_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-replication-'));
  const store = await startObjectStore();
  const env = {
    AOI_BUILD_REVISION: 'integration-test-build', AOI_REPLICATION_INTERVAL: '5',
    AOI_S3_BUCKET: 'test', AOI_S3_PREFIX: 'data', AOI_S3_ENDPOINT: store.endpoint,
    AOI_S3_ACCESS_KEY: 'test-access', AOI_S3_SECRET_KEY: 'test-secret',
  };
  const primaryDir = path.join(dir, 'primary');
  // Seed through an ordinary initialized database before enabling replication.
  const seed = await startTestServer(primaryDir);
  await stopTestServer(seed);
  const db = new Database(path.join(primaryDir, 'db', 'packdb.sqlite'));
  db.exec(`INSERT INTO packs (id,name,original_filename,original_size,original_format,status,compressed_size)
    VALUES ('pack1','Original','original.zip',7,'zip','generated',7);
    CREATE TABLE viewing_history (value TEXT);
    INSERT INTO viewing_history VALUES ('never-copy');`);
  db.close();
  const content = path.join(primaryDir, 'generated', 'pack1');
  fs.mkdirSync(content, { recursive: true });
  fs.writeFileSync(path.join(content, 'compressed.zip'), 'ZIPDATA');
  let primary: TestServer | undefined;
  let replica: TestServer | undefined;
  let wrong: TestServer | undefined;
  try {
    replica = await startTestServer(path.join(dir, 'replica'), true, { ...env, AOI_REPLICATION_ROLE: 'replica' });
    assert.equal((await fetch(`${replica.url}/api/packs`)).status, 503);
    primary = await startTestServer(primaryDir, true, { ...env, AOI_REPLICATION_ROLE: 'primary' });
    await eventually(async () => (await status(replica!)).ready, 'replica did not become ready');
    const initial = await status(replica);
    const health = await (await fetch(`${replica.url}/api/health`)).json() as { writable: boolean };
    assert.equal(health.writable, false);
    for (const [method, route] of [['POST','/api/presets'], ['PATCH','/api/packs/pack1'], ['DELETE','/api/packs/pack1'], ['POST','/api/upload/files'], ['PATCH','/api/upload/files/missing']]) {
      const response = await fetch(replica.url + route, { method, body: 'invalid-body' });
      assert.equal(response.status, 403, `${method} ${route}`);
      assert.equal((await response.json() as { code: string }).code, 'READ_ONLY_REPLICA');
    }
    const download = await fetch(`${replica.url}/api/packs/pack1/download`);
    assert.equal(await download.text(), 'ZIPDATA');
    assert.equal(download.headers.get('x-aoi-generation'), initial.generation);
    const partial = await fetch(`${replica.url}/api/packs/pack1/download`, { headers: { Range: 'bytes=0-2', 'If-Range': download.headers.get('etag')! } });
    assert.equal(partial.status, 206); assert.equal(await partial.text(), 'ZIP');
    const staleRange = await fetch(`${replica.url}/api/packs/pack1/download`, { headers: { Range: 'bytes=0-2', 'If-Range': '"old-version"' } });
    assert.equal(staleRange.status, 200);
    const blobsBefore = [...store.objects.keys()].filter(key => key.includes('/blobs/'));
    assert.equal(blobsBefore.length, 1);
    await fetch(`${primary.url}/api/packs/pack1`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }) });
    await eventually(async () => {
      const result = await (await fetch(`${replica!.url}/api/packs/pack1`)).json() as { name: string };
      return result.name === 'Renamed';
    }, 'metadata did not synchronize');
    assert.deepEqual([...store.objects.keys()].filter(key => key.includes('/blobs/')), blobsBefore);
    assert.equal((await status(primary)).uploadedBlobs, 0);
    const replicaDb = new Database(path.join(dir, 'replica', 'replication', 'generations', (await status(replica)).generation, 'catalog.sqlite'), { readonly: true });
    assert.equal(replicaDb.prepare("SELECT 1 FROM sqlite_master WHERE name='viewing_history'").get(), undefined);
    replicaDb.close();
    wrong = await startTestServer(path.join(dir, 'wrong'), true, { ...env, AOI_REPLICATION_ROLE: 'replica', AOI_BUILD_REVISION: 'different-build' });
    await eventually(async () => Boolean((await status(wrong!)).lastError?.includes('Build mismatch')), 'build mismatch not rejected');
    assert.equal((await fetch(`${wrong.url}/api/packs`)).status, 503);
    await stopTestServer(wrong); wrong = undefined;
    wrong = await startTestServer(path.join(dir, 'other-primary'), true, { ...env, AOI_REPLICATION_ROLE: 'primary' });
    await eventually(async () => Boolean((await status(wrong!)).lastError?.includes('another primary')), 'second publisher was not rejected');
    await stopTestServer(wrong); wrong = undefined;
    // Stop the publisher; an absent blob invalidates a new replica installation.
    await stopTestServer(primary); primary = undefined;
    const savedBlob = store.objects.get(blobsBefore[0])!;
    store.objects.delete(blobsBefore[0]);
    wrong = await startTestServer(path.join(dir, 'missing'), true, { ...env, AOI_REPLICATION_ROLE: 'replica' });
    await eventually(async () => Boolean((await status(wrong!)).lastError), 'missing blob not detected');
    assert.equal((await status(wrong)).ready, false);
    store.objects.set(blobsBefore[0], savedBlob);
    await eventually(async () => (await status(wrong!)).ready, 'incomplete installation did not recover');
    await stopTestServer(wrong); wrong = undefined;
    store.offline(true);
    await stopTestServer(replica);
    replica = await startTestServer(path.join(dir, 'replica'), true, { ...env, AOI_REPLICATION_ROLE: 'replica' });
    assert.equal(await (await fetch(`${replica.url}/api/packs/pack1/download`)).text(), 'ZIPDATA');
    store.offline(false);
    primary = await startTestServer(primaryDir, true, { ...env, AOI_REPLICATION_ROLE: 'primary' });
    assert.equal((await fetch(`${primary.url}/api/packs/pack1`, { method: 'DELETE' })).status, 200);
    await eventually(async () => (await fetch(`${replica!.url}/api/packs/pack1`)).status === 404, 'deletion did not synchronize');
    assert.ok(store.objects.has(blobsBefore[0]), 'historical blobs must be retained');
  } catch (error) {
    console.error('PRIMARY', primary?.output(), 'REPLICA', replica?.output());
    throw error;
  } finally {
    store.offline(false);
    for (const server of [wrong, replica, primary]) if (server) await stopTestServer(server);
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

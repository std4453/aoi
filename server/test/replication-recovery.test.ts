import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import { startTestServer, stopTestServer, type TestServer } from './helpers/server-process';
import { canonicalJson, contractValues, digest, makeManifest } from '~/replication/protocol';
import type { StoredPack } from '~/db/repositories';

async function eventually(check: () => Promise<boolean>, message: string, timeout = 20_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.fail(message);
}
const status = async (server: TestServer) => (await (await fetch(server.url + '/api/system/replication')).json()) as { ready: boolean; failedPacks: number; lastError: string | null };

test('conditional polls retry failed installs, resume after restart, reject incompatible sources and preserve committed content', { timeout: 150_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-resume-'));
  const pack: StoredPack = { id: 'pack1', name: 'Original', originalFilename: 'folder', originalSize: 0, originalFormat: 'folder', sourceType: 'folder',
    status: 'extracted', imageCount: 0, videoCount: 1, totalImagesSize: 0, totalVideosSize: 0, errorMessage: null, archivePassword: null, compressedSize: 0,
    tags: [], createdAt: '2026-10-01', updatedAt: '2026-10-01' };
  let bytes = Buffer.alloc(256 * 1024, 42);
  let relative = 'videos/test.mp4';
  const make = () => makeManifest(pack, [{ path: relative, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }]);
  let manifest = make();
  let dataset = randomUUID(); let protocol = '1.0.1'; let writable = true;
  let good = false; let interrupt = false; let ranges = 0; let conditional = 0; let logins = 0; let token = 'token1';
  const source = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://localhost');
    if (url.pathname === '/api/health') {
      response.end(JSON.stringify({ service: 'aoi', writable, replicationProtocol: '1.0.0', capabilities: { snapshots: true } })); return;
    }
    if (url.pathname === '/api/auth/login') {
      for await (const _chunk of request) { /* consume credential body */ }
      logins++; response.end(JSON.stringify({ token })); return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) { response.writeHead(401); response.end(); return; }
    const index = { ...contractValues(), protocol, datasetId: dataset, packs: [{ id: 'pack1', state: 'ready', revision: manifest.revision }] };
    if (url.pathname === '/api/packs/snapshot') {
      const etag = `"${digest(index)}"`; response.setHeader('ETag', etag);
      if (request.headers['if-none-match'] === etag) { conditional++; response.writeHead(304); response.end(); }
      else response.end(canonicalJson(index));
      return;
    }
    if (url.pathname === '/api/packs/pack1/snapshot') { response.end(canonicalJson(manifest)); return; }
    if (url.pathname.includes('/snapshot/files/')) {
      const offset = Number(/^bytes=(\d+)-$/.exec(request.headers.range ?? '')?.[1] ?? 0);
      if (offset) { ranges++; response.statusCode = 206; response.setHeader('Content-Range', `bytes ${offset}-${bytes.length - 1}/${bytes.length}`); }
      response.setHeader('Content-Length', bytes.length - offset);
      response.setHeader('ETag', `"${manifest.files[0].hash}"`);
      if (interrupt) {
        interrupt = false; response.write(bytes.subarray(offset, offset + 8192));
        setTimeout(() => response.destroy(), 40); return;
      }
      response.end(good ? bytes.subarray(offset) : Buffer.alloc(bytes.length - offset, 0)); return;
    }
    response.writeHead(404); response.end();
  });
  source.listen(0, '127.0.0.1'); await once(source, 'listening');
  const sourceUrl = `http://127.0.0.1:${(source.address() as { port: number }).port}`;
  const env = { AOI_REPLICA_SOURCE_URL: sourceUrl, AOI_REPLICATION_INTERVAL: '5' };
  let replica: TestServer | undefined;
  try {
    replica = await startTestServer(dir, true, env);
    await eventually(async () => Boolean((await status(replica!)).lastError?.includes('protocol mismatch')), 'patch mismatch not rejected');
    assert.equal((await status(replica)).ready, false);
    protocol = '1.0.0';
    await eventually(async () => (await status(replica!)).failedPacks === 1, 'checksum failure not recorded');
    assert.equal((await status(replica)).ready, false);
    good = true;
    await eventually(async () => (await status(replica!)).ready, '304 did not retry failed download');
    assert.ok(conditional > 0);
    assert.equal(Buffer.from(await (await fetch(replica.url + '/api/packs/pack1/videos/test.mp4')).arrayBuffer()).equals(bytes), true);
    // A database failure after files are durable must not change the public version.
    const db = new Database(path.join(dir, 'db/packdb.sqlite'));
    db.exec("CREATE TRIGGER reject_replica_update BEFORE UPDATE ON packs BEGIN SELECT RAISE(ABORT,'simulated commit failure'); END");
    pack.name = 'New version'; bytes = Buffer.alloc(bytes.length, 81); manifest = make();
    interrupt = true;
    await eventually(async () => fs.existsSync(path.join(dir, 'replica/staging/pack1', 'downloads', manifest.files[0].hash + '.part')) && fs.statSync(path.join(dir, 'replica/staging/pack1', 'downloads', manifest.files[0].hash + '.part')).size > 0, 'partial file was not persisted');
    await eventually(async () => (await status(replica!)).failedPacks > 0, 'interruption was not detected');
    assert.equal((await fetch(replica.url + '/api/packs/pack1/videos/test.mp4')).status, 200, 'downloads retain old access');
    // A metadata revision change must not discard a resumable file with the same hash.
    pack.updatedAt = '2026-10-02'; manifest = make();
    const stale = path.join(dir, 'replica/staging/pack1/downloads', 'b'.repeat(64) + '.part');
    fs.writeFileSync(stale, 'obsolete');
    await stopTestServer(replica); replica = await startTestServer(dir, true, env);
    await eventually(async () => ranges > 0, 'download did not resume after restart and revision change');
    assert.equal(fs.existsSync(stale), false, 'obsolete download was not removed');
    await eventually(async () => (await status(replica!)).failedPacks > 0, 'commit failure not detected');
    const old = await (await fetch(replica.url + '/api/packs/pack1')).json() as { name: string };
    assert.equal(old.name, 'Original');
    db.exec('DROP TRIGGER reject_replica_update'); db.close();
    await eventually(async () => (await (await fetch(replica!.url + '/api/packs/pack1')).json() as { name: string }).name === 'New version', 'failed commit did not recover');
    relative = 'videos/renamed/test.mp4'; manifest = make();
    await eventually(async () => (await fetch(replica!.url + '/api/packs/pack1/videos/renamed/test.mp4')).status === 200, 'rename did not reuse local content');
    assert.equal((await (await fetch(replica.url + '/api/system/replication')).json() as { downloadedFiles: number }).downloadedFiles, 0);
    assert.equal((await fetch(replica.url + '/api/packs/pack1/videos/test.mp4')).status, 404);
    token = 'token2';
    await eventually(async () => logins >= 3, 'expired token not refreshed');
    const originalDataset = dataset; dataset = randomUUID();
    await eventually(async () => Boolean((await status(replica!)).lastError?.includes('dataset changed')), 'dataset change not rejected');
    assert.equal((await fetch(replica.url + '/api/packs/pack1')).status, 200);
    dataset = originalDataset; writable = false;
    await eventually(async () => Boolean((await status(replica!)).lastError?.includes('writable snapshot')), 'read-only upstream accepted');
    assert.equal((await fetch(replica.url + '/api/packs/pack1')).status, 200);
  } finally {
    if (replica) await stopTestServer(replica);
    source.closeAllConnections(); await new Promise<void>(resolve => source.close(() => resolve()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

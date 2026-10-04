import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { startTestServer, stopTestServer, type TestServer } from './helpers/server-process';
import { type Manifest, type SnapshotIndex } from '~/replication/protocol';

async function eventually(check: () => Promise<boolean>, message: string, timeout = 25_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  assert.fail(message);
}
async function json(url: string, init?: RequestInit): Promise<any> {
  const response = await fetch(url, init); assert.equal(response.ok, true, `${url}: ${response.status}`); return response.json();
}
const status = (server: TestServer) => json(`${server.url}/api/system/replication`);

test('direct snapshots: defaults, auth, scoped incremental content, pending, deletion and offline recovery', { timeout: 120_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-direct-'));
  let primary: TestServer | undefined; let replica: TestServer | undefined; let wrong: TestServer | undefined;
  const primaryDir = path.join(dir, 'primary');
  try {
    primary = await startTestServer(primaryDir, true, { AOI_SNAPSHOT_ENABLED: 'false' });
    assert.equal((await fetch(`${primary.url}/api/packs/snapshot`)).status, 404);
    await stopTestServer(primary); primary = undefined;
    const db = new Database(path.join(primaryDir, 'db/packdb.sqlite'));
    assert.equal(db.prepare('SELECT count(*) FROM snapshot_state').pluck().get(), 0);
    db.exec(`INSERT INTO packs(id,name,original_filename,original_size,original_format,status,image_count,video_count,total_images_size,total_videos_size,archive_password)
      VALUES ('pack1','Original','a.zip',7,'zip','generated',1,1,7,9,'private-password');
      CREATE TABLE viewing_history(value TEXT); INSERT INTO viewing_history VALUES ('never-copy');
      INSERT INTO tags(id,name) VALUES ('tag1','Tag'); INSERT INTO pack_tags VALUES ('pack1','tag1');`);
    db.close();
    const extracted = path.join(primaryDir, 'extracted/pack1');
    for (const sub of ['images/nested', 'videos', 'thumbnails', '_staging']) fs.mkdirSync(path.join(extracted, sub), { recursive: true });
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#2277cc' } }).png().toBuffer();
    fs.writeFileSync(path.join(extracted, 'images/nested/a.png'), png);
    fs.writeFileSync(path.join(extracted, 'videos/a.mp4'), 'VIDEODATA');
    fs.writeFileSync(path.join(extracted, 'thumbnails/private.jpg'), 'not-synced');
    fs.writeFileSync(path.join(extracted, '_staging/private'), 'not-synced');
    primary = await startTestServer(primaryDir, true, { AUTH_KEY: 'source-key' });
    assert.equal((await fetch(`${primary.url}/api/packs/snapshot`)).status, 401);
    const token = (await json(`${primary.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'source-key' }) })).token;
    const headers = { Authorization: `Bearer ${token}` };
    let index!: SnapshotIndex;
    await eventually(async () => {
      index = await json(`${primary!.url}/api/packs/snapshot`, { headers });
      return index.packs[0]?.state === 'ready';
    }, 'primary did not publish');
    assert.equal(index.protocol, '1.0.0');
    const revision = index.packs[0].state === 'ready' ? index.packs[0].revision : '';
    const manifest: Manifest = await json(`${primary.url}/api/packs/pack1/snapshot?revision=${revision}`, { headers });
    assert.deepEqual(manifest.files.map(file => file.path), ['images/nested/a.png', 'videos/a.mp4']);
    assert.equal(JSON.stringify(manifest).includes('private-password'), false);
    assert.equal((await fetch(`${primary.url}/api/packs/pack1/snapshot?revision=old`, { headers })).status, 409);
    const indexResponse = await fetch(`${primary.url}/api/packs/snapshot`, { headers });
    assert.equal((await fetch(`${primary.url}/api/packs/snapshot`, { headers: { ...headers, 'If-None-Match': indexResponse.headers.get('etag')! } })).status, 304);
    const env = { AOI_REPLICA_SOURCE_URL: primary.url, AOI_REPLICA_SOURCE_KEY: 'source-key', AOI_REPLICATION_INTERVAL: '5' };
    wrong = await startTestServer(path.join(dir, 'wrong'), true, { ...env, AOI_REPLICA_SOURCE_KEY: 'wrong' });
    await eventually(async () => Boolean((await status(wrong!)).lastError), 'wrong key not rejected');
    assert.equal((await fetch(`${wrong.url}/api/packs`)).status, 503);
    await stopTestServer(wrong); wrong = undefined;
    replica = await startTestServer(path.join(dir, 'replica'), true, { ...env, AOI_SNAPSHOT_ENABLED: 'false' });
    await eventually(async () => (await status(replica!)).ready, 'replica not ready');
    const health = await json(`${replica.url}/api/health`);
    assert.equal(health.writable, false); assert.equal(health.capabilities.generatedArchiveDownload, false);
    const replicaPack = await json(`${replica.url}/api/packs/pack1`);
    assert.equal(replicaPack.name, 'Original'); assert.equal(replicaPack.status, 'extracted');
    assert.equal(replicaPack.totalImagesSize, png.length);
    assert.deepEqual(Buffer.from(await (await fetch(`${replica.url}/api/packs/pack1/images/nested/a.png`)).arrayBuffer()), png);
    assert.equal((await fetch(`${replica.url}/api/packs/pack1/download`)).status, 404);
    const video = await fetch(`${replica.url}/api/packs/pack1/videos/a.mp4`, { headers: { Range: 'bytes=0-2' } });
    assert.equal(video.status, 206); assert.equal(await video.text(), 'VID');
    const thumbs = await json(`${replica.url}/api/packs/pack1/thumbnails`); assert.equal(thumbs.length, 1);
    assert.equal((await fetch(replica.url + thumbs[0].thumbUrl)).status, 200);
    for (const [method, route] of [['POST','/api/presets'], ['PATCH','/api/packs/pack1'], ['DELETE','/api/packs/pack1'], ['POST','/api/upload/files'], ['POST','/api/upload-tasks'], ['PATCH','/api/upload-tasks/missing'], ['DELETE','/api/upload-tasks/missing'], ['POST','/api/upload-tasks/missing/continue']]) {
      assert.equal((await fetch(replica.url + route, { method, body: 'invalid' })).status, 403);
    }
    const replicaDb = new Database(path.join(dir, 'replica/db/packdb.sqlite'));
    assert.ok(replicaDb.prepare("SELECT 1 FROM jobs WHERE type='thumbnail' AND status='completed'").get());
    assert.ok(fs.existsSync(path.join(dir, 'replica/extracted/pack1/thumbnails/nested/a.jpg')));
    assert.ok(fs.existsSync(path.join(dir, 'replica/thumbnails/pack1/_cover.jpg')));
    assert.equal(fs.existsSync(path.join(dir, 'replica/replica/versions')), false);
    assert.equal(fs.existsSync(path.join(dir, 'replica/replica/blobs')), false);
    assert.equal(replicaDb.prepare("SELECT 1 FROM sqlite_master WHERE name='viewing_history'").get(), undefined);
    assert.equal(replicaDb.prepare('SELECT count(*) FROM presets').pluck().get(), 0);
    replicaDb.exec("CREATE TABLE viewing_history(value TEXT); INSERT INTO viewing_history VALUES ('local-history')");
    replicaDb.close();
    await json(`${primary.url}/api/packs/pack1`, { method: 'PATCH', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Renamed' }) });
    await eventually(async () => (await json(`${replica!.url}/api/packs/pack1`)).name === 'Renamed', 'rename did not propagate');
    assert.equal((await status(replica)).downloadedFiles, 0);
    // A job-state change is not a deletion. The next complete index says pending.
    const live = new Database(path.join(primaryDir, 'db/packdb.sqlite'));
    live.prepare("UPDATE packs SET status='uploading' WHERE id='pack1'").run(); live.close();
    await eventually(async () => (await status(replica!)).pendingPacks > 0, 'pending not observed');
    assert.equal((await fetch(`${replica.url}/api/packs/pack1`)).status, 200);
    await stopTestServer(primary); primary = undefined;
    await stopTestServer(replica);
    replica = await startTestServer(path.join(dir, 'replica'), true, env);
    assert.equal(await (await fetch(`${replica.url}/api/packs/pack1/videos/a.mp4`)).text(), 'VIDEODATA');
    const local = new Database(path.join(dir, 'replica/db/packdb.sqlite'));
    assert.equal(local.prepare('SELECT value FROM viewing_history').pluck().get(), 'local-history'); local.close();
    primary = await startTestServer(primaryDir, true, { AUTH_KEY: 'source-key' });
    // Changing the URL preserves dataset identity and reauthenticates after restart.
    await stopTestServer(replica);
    replica = await startTestServer(path.join(dir, 'replica'), true, { ...env, AOI_REPLICA_SOURCE_URL: primary.url });
    const newToken = (await json(`${primary.url}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'source-key' }) })).token;
    await json(`${primary.url}/api/packs/pack1`, { method: 'DELETE', headers: { Authorization: `Bearer ${newToken}` } });
    await eventually(async () => (await fetch(`${replica!.url}/api/packs/pack1`)).status === 404, 'deletion did not propagate');
    assert.equal((await status(replica)).ready, true);
  } catch (error) { console.error(primary?.output(), replica?.output(), wrong?.output()); throw error; }
  finally {
    for (const server of [wrong, replica, primary]) if (server) await stopTestServer(server);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

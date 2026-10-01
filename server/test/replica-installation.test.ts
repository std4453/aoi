import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { makeManifest, canonicalJson } from '../src/replication/protocol.js';
import { startTestServer, stopTestServer, type TestServer } from './helpers/server-process.js';

async function eventually(check: () => Promise<boolean>, message: string) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
  assert.fail(message);
}
const env = { AOI_REPLICA_SOURCE_URL: 'http://127.0.0.1:1', AOI_REPLICATION_INTERVAL: '5' };

test('offline recovery at every install boundary shares normal thumbnail jobs, paths and failure recovery', { timeout: 90_000 }, async t => {
  for (const phase of ['prepared', 'old-moved', 'new-moved', 'committed', 'thumbnail-running', 'commit-failed', 'thumbnail-failed']) {
    await t.test(phase, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-install-'));
      let server: TestServer | undefined;
      let db: Database.Database | undefined;
      try {
        server = await startTestServer(dir, true, env); await stopTestServer(server); server = undefined;
        const png = await sharp({ create: { width: 48, height: 32, channels: 3, background: '#4466bb' } }).png().toBuffer();
        const manifest = makeManifest({ id: 'pack', name: 'New', originalFilename: 'folder', originalSize: 0, originalFormat: 'folder', sourceType: 'folder',
          status: 'extracted', imageCount: 1, videoCount: 0, totalImagesSize: png.length, totalVideosSize: 0, archivePassword: null, errorMessage: null, compressedSize: 0,
          tags: [{ id: 'tag', name: 'Visible tag' }], createdAt: '2026-10-01', updatedAt: '2026-10-01' },
        [{ path: 'images/new.png', size: png.length, hash: createHash('sha256').update(png).digest('hex') }]);
        const stage = path.join(dir, 'replica/staging/pack', manifest.revision);
        const content = path.join(stage, 'content'); const previous = path.join(stage, 'previous');
        const current = path.join(dir, 'extracted/pack');
        fs.mkdirSync(path.join(content, 'images'), { recursive: true }); fs.writeFileSync(path.join(content, 'images/new.png'), png);
        fs.mkdirSync(path.join(current, 'images'), { recursive: true }); fs.writeFileSync(path.join(current, 'images/old.png'), 'old');
        fs.mkdirSync(path.join(dir, 'thumbnails/pack'), { recursive: true }); fs.writeFileSync(path.join(dir, 'thumbnails/pack/_cover.jpg'), 'old cover');
        db = new Database(path.join(dir, 'db/packdb.sqlite'));
        db.exec("INSERT INTO packs(id,name,original_filename,original_size,original_format,source_type,status,image_count) VALUES ('pack','New','folder',0,'folder','folder','extracting',1); CREATE TABLE viewing_history(value TEXT); INSERT INTO viewing_history VALUES ('private');");
        if (phase !== 'prepared') fs.renameSync(current, previous);
        if (!['prepared', 'old-moved'].includes(phase)) fs.renameSync(content, current);
        if (['committed', 'thumbnail-running', 'thumbnail-failed'].includes(phase)) {
          db.prepare('INSERT INTO replica_packs VALUES (?,?)').run('pack', canonicalJson(manifest));
          db.exec("UPDATE packs SET status='thumbnailing'; INSERT INTO jobs(id,pack_id,type,status) VALUES ('thumbnail','pack','thumbnail','pending');");
          if (phase === 'thumbnail-running') db.exec("UPDATE jobs SET status='running',progress=50");
        } else {
          db.prepare('INSERT INTO replica_installs VALUES (?,?)').run('pack', canonicalJson(manifest));
        }
        if (phase === 'commit-failed') db.exec("CREATE TRIGGER fail_install BEFORE UPDATE ON packs WHEN NEW.status='thumbnailing' BEGIN SELECT RAISE(ABORT,'disk commit failed'); END");
        if (phase === 'thumbnail-failed') db.exec("CREATE TRIGGER fail_thumbnail BEFORE UPDATE ON packs WHEN NEW.status='extracted' BEGIN SELECT RAISE(ABORT,'thumbnail completion failed'); END");
        server = await startTestServer(dir, true, env);
        const pack = async () => await (await fetch(server!.url + '/api/packs/pack')).json() as { status: string };
        if (phase === 'commit-failed' || phase === 'thumbnail-failed') {
          await eventually(async () => (await pack()).status === (phase === 'commit-failed' ? 'extracting' : 'failed'), 'failure not retained');
          for (const route of ['images/new.png', 'videos/new.mp4', 'thumbnails/new.jpg', 'cover', 'file-tree']) {
            assert.equal((await fetch(server.url + '/api/packs/pack/' + route)).status, 409, route);
          }
          assert.equal(db.prepare('SELECT count(*) FROM replica_installs').pluck().get(), phase === 'commit-failed' ? 1 : 0);
          await stopTestServer(server, 'SIGKILL'); server = undefined;
          db.exec(`DROP TRIGGER ${phase === 'commit-failed' ? 'fail_install' : 'fail_thumbnail'}`);
          server = await startTestServer(dir, true, env);
        }
        await eventually(async () => (await pack()).status === 'extracted', 'local recovery requires upstream');
        assert.equal(db.prepare('SELECT count(*) FROM replica_installs').pluck().get(), 0);
        assert.ok(db.prepare("SELECT 1 FROM jobs WHERE type='thumbnail' AND status='completed'").get());
        assert.equal(db.prepare('SELECT value FROM viewing_history').pluck().get(), 'private');
        assert.ok(JSON.parse(db.prepare('SELECT blurhashes FROM packs').pluck().get() as string)['new.jpg']);
        assert.deepEqual(Buffer.from(await (await fetch(server.url + '/api/packs/pack/images/new.png')).arrayBuffer()), png);
        assert.equal((await fetch(server.url + '/api/packs/pack/images/old.png')).status, 404);
        assert.equal((await fetch(server.url + '/api/packs/pack/thumbnails/new.jpg')).headers.get('content-type'), 'image/jpeg');
        const expectedCover = await sharp(png).resize(400, 300, { fit: 'cover' }).jpeg({ quality: 70, mozjpeg: true }).toBuffer();
        assert.deepEqual(Buffer.from(await (await fetch(server.url + '/api/packs/pack/cover')).arrayBuffer()), expectedCover);
        assert.ok(fs.existsSync(path.join(current, 'thumbnails/new.jpg')));
        assert.equal(fs.existsSync(path.join(dir, 'replica/versions')), false);
        assert.equal(fs.existsSync(path.join(dir, 'replica/blobs')), false);
        const filtered = await (await fetch(server.url + '/api/packs?search=Visible')).json() as { total: number };
        assert.equal(filtered.total, 1);
      } catch (error) { console.error(server?.output()); throw error; }
      finally { if (server) await stopTestServer(server); db?.close(); fs.rmSync(dir, { recursive: true, force: true }); }
    });
  }
});

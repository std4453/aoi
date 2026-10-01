import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { ZipArchive } from 'archiver';
import sharp from 'sharp';
import migration from '../src/db/migrations/007_add_archive_md5.js';
import { startTestServer, stopTestServer } from './helpers/server-process.js';

test('archive duplicate confirmation, historical hashes, cancellation and concurrent uploads', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-dedup-'));
  const zipPath = path.join(dataDir, 'fixture.zip');
  const output = fs.createWriteStream(zipPath);
  const zip = new ZipArchive();
  zip.pipe(output);
  zip.append(await sharp({ create: { width: 16, height: 16, channels: 3, background: '#446688' } }).png().toBuffer(), { name: 'image.png' });
  const closed = once(output, 'close');
  await zip.finalize();
  await closed;
  const bytes = fs.readFileSync(zipPath);
  const md5 = createHash('md5').update(bytes).digest('hex');
  let server = await startTestServer(dataDir);
  const db = new Database(path.join(dataDir, 'db', 'packdb.sqlite'));
  const upload = async (body = bytes) => {
    const created = await fetch(`${server.url}/api/upload/files`, {
      method: 'POST', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(body.length) },
    });
    assert.equal(created.status, 201);
    const url = new URL(created.headers.get('location')!, server.url).toString();
    const sent = await fetch(url, { method: 'PATCH', headers: {
      'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream',
    }, body: new Uint8Array(body) });
    assert.equal(sent.status, 204);
    return { id: url.split('/').pop()!, url };
  };
  const confirm = (id: string, extra: Record<string, unknown> = {}) => fetch(`${server.url}/api/packs/upload-complete`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uploadId: id, filename: 'renamed.zip', fileSize: bytes.length, packName: '新图包', ...extra }),
  });
  try {
    migration.up(db);
    migration.up(db);
    const first = await upload();
    const firstResponse = await confirm(first.id);
    assert.equal(firstResponse.status, 200);
    const firstPack = await firstResponse.json() as { id: string };
    assert.equal((db.prepare('SELECT archive_md5 FROM packs WHERE id = ?').get(firstPack.id) as { archive_md5: string }).archive_md5, md5);

    // A legacy failed pack must participate even though it has no thumbnails.
    db.prepare(`INSERT INTO packs (id, name, original_filename, original_size, original_format, source_type, status)
      VALUES (?, ?, 'old.zip', ?, 'zip', 'archive', 'failed')`).run('legacy', '旧图包', bytes.length);
    fs.mkdirSync(path.join(dataDir, 'archives', 'legacy'), { recursive: true });
    fs.writeFileSync(path.join(dataDir, 'archives', 'legacy', 'original.zip'), bytes);
    db.prepare(`INSERT INTO packs (id, name, original_filename, original_size, original_format, source_type, status)
      VALUES ('missing', 'missing', 'old.zip', ?, 'zip', 'archive', 'failed')`).run(bytes.length);
    db.prepare(`INSERT INTO packs (id, name, original_filename, original_size, original_format, source_type, status, archive_md5)
      VALUES ('folder', 'folder', 'folder', ?, '', 'folder', 'extracted', ?)`).run(bytes.length, md5);

    const repeated = await upload();
    const before = db.prepare('SELECT count(*) AS count FROM packs').get();
    const beforeJobs = db.prepare('SELECT count(*) AS count FROM jobs WHERE pack_id != ?').get(firstPack.id);
    const duplicateResponse = await confirm(repeated.id);
    assert.equal(duplicateResponse.status, 409);
    const duplicate = await duplicateResponse.json() as { code: string; matches: Array<{ id: string; name: string; status: string }> };
    assert.equal(duplicate.code, 'DUPLICATE_ARCHIVE');
    assert.deepEqual(duplicate.matches.map(pack => pack.id).sort(), [firstPack.id, 'legacy'].sort());
    assert.ok(duplicate.matches.some(pack => pack.name === '旧图包' && pack.status === 'failed'));
    assert.deepEqual(db.prepare('SELECT count(*) AS count FROM packs').get(), before);
    assert.deepEqual(db.prepare('SELECT count(*) AS count FROM jobs WHERE pack_id != ?').get(firstPack.id), beforeJobs);
    assert.ok(fs.existsSync(path.join(dataDir, 'uploads', repeated.id)));
    assert.equal((db.prepare("SELECT archive_md5 FROM packs WHERE id = 'legacy'").get() as { archive_md5: string }).archive_md5, md5);
    assert.equal((await fetch(`${server.url}/api/packs/legacy/thumbnails`)).status, 200);

    const cancelled = await fetch(repeated.url, { method: 'DELETE', headers: { 'Tus-Resumable': '1.0.0' } });
    assert.equal(cancelled.status, 204);
    assert.equal(fs.existsSync(path.join(dataDir, 'uploads', repeated.id)), false);
    assert.equal(fs.existsSync(path.join(dataDir, 'uploads', `${repeated.id}.json`)), false);

    const continued = await upload();
    assert.equal((await confirm(continued.id, { allowDuplicate: 'true' })).status, 400);
    const responses = await Promise.all([confirm(continued.id, { allowDuplicate: true }), confirm(continued.id, { allowDuplicate: true })]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 404]);
    const createdPack = await responses.find(response => response.status === 200)!.json() as { id: string; name: string };
    assert.equal(createdPack.name, '新图包');
    assert.notEqual(createdPack.id, firstPack.id);

    // Equal length does not imply equal contents. Concurrent new identical uploads
    // should produce one new pack and one duplicate warning.
    const changed = Buffer.from(bytes);
    changed[0] ^= 1;
    const pair = await Promise.all([upload(changed), upload(changed)]);
    const pairResponses = await Promise.all(pair.map(item => confirm(item.id)));
    assert.deepEqual(pairResponses.map(response => response.status).sort(), [200, 409]);

    // Verify the successful archive still extracts and exposes image previews.
    let thumbnails: Array<{ thumbUrl: string }> = [];
    for (let attempt = 0; attempt < 100; attempt++) {
      thumbnails = await (await fetch(`${server.url}/api/packs/${firstPack.id}/thumbnails`)).json() as typeof thumbnails;
      const pack = await (await fetch(`${server.url}/api/packs/${firstPack.id}`)).json() as { status: string };
      if (thumbnails.length && pack.status === 'extracted') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(thumbnails.length, 1);
    assert.equal((await fetch(`${server.url}${thumbnails[0].thumbUrl}`)).status, 200);
    await stopTestServer(server);
    server = await startTestServer(dataDir);
    const afterRestart = await upload();
    assert.equal((await confirm(afterRestart.id)).status, 409);
  } finally {
    db.close();
    await stopTestServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { ZipArchive } from 'archiver';
import sharp from 'sharp';
import {
  startTestServer,
  stopTestServer,
} from './helpers/server-process.js';

async function makeTestImage(): Promise<Buffer> {
  return sharp({
    create: {
      width: 32,
      height: 24,
      channels: 3,
      background: '#3867d6',
    },
  }).png().toBuffer();
}

async function writeImageZip(destination: string): Promise<void> {
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const image = await makeTestImage();
  const output = fs.createWriteStream(destination);
  const archive = new ZipArchive();
  archive.pipe(output);
  archive.append(image, { name: 'nested/recovery.png' });
  const closed = once(output, 'close');
  await archive.finalize();
  await closed;
}

async function waitForPackStatus(
  serverUrl: string,
  packId: string,
  expected: string,
  timeoutMs = 15_000
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await fetch(`${serverUrl}/api/packs/${packId}`);
    const pack = await response.json() as Record<string, unknown>;
    if (pack.status === expected) return pack;
    if (pack.status === 'failed') {
      throw new Error(`Pack recovery failed: ${String(pack.errorMessage)}`);
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out waiting for pack status ${expected}`);
}

test('recovers the upload-to-enqueue crash window and hardens API responses', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-api-hardening-'));
  const recoveryPackId = '11111111-1111-4111-8111-111111111111';
  const generatedPackId = '22222222-2222-4222-8222-222222222222';
  const folderPackId = '33333333-3333-4333-8333-333333333333';
  const folderFileId = '44444444-4444-4444-8444-444444444444';
  const folderUploadId = 'folder-recovery-upload';
  const idleJobId = '66666666-6666-4666-8666-666666666666';

  try {
    const initializer = await startTestServer(dataDir);
    assert.equal(await stopTestServer(initializer), 0);

    const database = new Database(path.join(dataDir, 'db', 'packdb.sqlite'));
    const insert = database.prepare(`
      INSERT INTO packs (
        id, name, original_filename, original_size, original_format,
        status, archive_password, source_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      recoveryPackId,
      'recover me',
      'recovery.zip',
      1,
      'zip',
      'uploading',
      null,
      'archive'
    );
    insert.run(
      generatedPackId,
      'public pack',
      'public.zip',
      10,
      'zip',
      'generated',
      'must-not-leak',
      'archive'
    );
    const folderImage = await makeTestImage();
    insert.run(
      folderPackId,
      'folder recovery',
      'folder recovery',
      folderImage.length,
      'folder',
      'uploading',
      null,
      'folder'
    );
    database.prepare(`
      INSERT INTO pack_files (
        id, pack_id, relative_path, file_size, upload_id, status
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      folderFileId,
      folderPackId,
      'nested/recovered.png',
      folderImage.length,
      folderUploadId,
      'uploading'
    );
    database.prepare(`
      INSERT INTO jobs (id, pack_id, type, status)
      VALUES (?, ?, ?, ?)
    `).run(idleJobId, generatedPackId, 'thumbnail', 'paused');
    database.close();

    const interruptedUpload = path.join(dataDir, 'uploads', folderUploadId);
    fs.mkdirSync(path.dirname(interruptedUpload), { recursive: true });
    fs.writeFileSync(interruptedUpload, folderImage);
    fs.writeFileSync(`${interruptedUpload}.info`, '{}');

    const recoveryArchive = path.join(
      dataDir,
      'archives',
      recoveryPackId,
      'original.zip'
    );
    await writeImageZip(recoveryArchive);
    const archiveSize = fs.statSync(recoveryArchive).size;
    const sizeDb = new Database(path.join(dataDir, 'db', 'packdb.sqlite'));
    sizeDb.prepare('UPDATE packs SET original_size = ? WHERE id = ?')
      .run(archiveSize, recoveryPackId);
    sizeDb.close();

    const generatedArchive = path.join(
      dataDir,
      'generated',
      generatedPackId,
      'compressed.zip'
    );
    fs.mkdirSync(path.dirname(generatedArchive), { recursive: true });
    fs.writeFileSync(generatedArchive, '0123456789');

    const server = await startTestServer(dataDir);

    const singleResponse = await fetch(`${server.url}/api/packs/${generatedPackId}`);
    assert.equal(singleResponse.status, 200);
    const single = await singleResponse.json() as Record<string, unknown>;
    assert.equal(Object.hasOwn(single, 'archivePassword'), false);

    const list = await (await fetch(`${server.url}/api/packs`)).json() as {
      items: Array<Record<string, unknown>>;
    };
    assert.equal(list.items.some(pack => Object.hasOwn(pack, 'archivePassword')), false);

    const invalidRange = await fetch(
      `${server.url}/api/packs/${generatedPackId}/download`,
      { headers: { range: 'bytes=999-1000' } }
    );
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers.get('content-range'), 'bytes */10');

    const suffixRange = await fetch(
      `${server.url}/api/packs/${generatedPackId}/download`,
      { headers: { range: 'bytes=-4' } }
    );
    assert.equal(suffixRange.status, 206);
    assert.equal(await suffixRange.text(), '6789');

    const eventStream = await fetch(`${server.url}/api/jobs/${idleJobId}/events`);
    assert.equal(eventStream.status, 200);
    const eventReader = eventStream.body!.getReader();
    const firstEvent = await eventReader.read();
    assert.equal(firstEvent.done, false);

    const invalidPage = await fetch(`${server.url}/api/packs?page=NaN`);
    assert.equal(invalidPage.status, 400);

    const missingPack = await fetch(`${server.url}/api/packs/not-present`);
    assert.equal(missingPack.status, 404);

    const firstTag = await fetch(`${server.url}/api/tags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'unique-tag' }),
    });
    assert.equal(firstTag.status, 200);
    const duplicateTag = await fetch(`${server.url}/api/tags`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'unique-tag' }),
    });
    assert.equal(duplicateTag.status, 409);

    const recovered = await waitForPackStatus(server.url, recoveryPackId, 'extracted');
    assert.equal(recovered.imageCount, 1);
    const recoveredFolder = await waitForPackStatus(server.url, folderPackId, 'extracted');
    assert.equal(recoveredFolder.imageCount, 1);
    assert.equal(fs.existsSync(interruptedUpload), false);
    assert.equal(fs.existsSync(`${interruptedUpload}.info`), false);
    assert.equal(await stopTestServer(server), 0);
    assert.equal((await eventReader.read()).done, true);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

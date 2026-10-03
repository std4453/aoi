import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import { ZipArchive } from 'archiver';
import sharp from 'sharp';
import Database from 'better-sqlite3';
import type { UploadTask } from '../../shared/types.js';
import { startTestServer, stopTestServer } from './helpers/server-process.js';
import migration from '../src/db/migrations/010_add_upload_tasks.js';

test('upload tasks persist, bind once, preserve completed packs, and recover folder uploads', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-upload-tasks-'));
  const image = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#228855' } }).png().toBuffer();
  const archivePath = path.join(directory, 'fixture.zip');
  const output = fs.createWriteStream(archivePath);
  const archive = new ZipArchive();
  archive.pipe(output);
  archive.append(image, { name: 'image.png' });
  const closed = once(output, 'close');
  await archive.finalize();
  await closed;
  const bytes = fs.readFileSync(archivePath);
  let server = await startTestServer(directory);
  const request = (url: string, method = 'GET', body?: unknown) => fetch(`${server.url}${url}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  const create = async (body: unknown): Promise<UploadTask> => {
    const response = await request('/api/upload-tasks', 'POST', body);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<UploadTask>;
  };
  const upload = async (body: Buffer): Promise<string> => {
    const created = await fetch(`${server.url}/api/upload/files`, { method: 'POST', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(body.length) } });
    const url = new URL(created.headers.get('location')!, server.url).toString();
    const response = await fetch(url, { method: 'PATCH', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: new Uint8Array(body) });
    assert.equal(response.status, 204);
    return url.split('/').pop()!;
  };
  const waitCompleted = async (id: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const task = await (await request(`/api/upload-tasks/${id}`)).json() as UploadTask;
      if (task.status === 'completed') return task;
      assert.notEqual(task.status, 'failed', task.error ?? 'failed');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out: ${server.output()}`);
  };
  try {
    const db = new Database(path.join(directory, 'db', 'packdb.sqlite'));
    migration.up(db);
    migration.up(db);
    db.close();
    const first = await create({ source: 'archive', name: 'first', filename: 'image.zip', fileSize: bytes.length, archivePassword: '' });
    const pending = await create({ source: 'archive', name: 'pending', filename: 'later.zip', fileSize: 3 });
    const tasks = await (await request('/api/upload-tasks')).json() as UploadTask[];
    assert.deepEqual(tasks.map(task => task.id), [pending.id, first.id]);
    assert.ok(!JSON.stringify(tasks).includes('archivePassword'));
    assert.equal((await request(`/api/upload-tasks/${first.id}`, 'PATCH', { status: 'completed' })).status, 400);
    assert.equal((await request(`/api/upload-tasks/${first.id}`, 'PATCH', { uploadId: '../escape' })).status, 400);
    const uploadId = await upload(bytes);
    await request(`/api/upload-tasks/${first.id}`, 'PATCH', { uploadId, transferredBytes: bytes.length, progress: 100 });
    const response = await request(`/api/upload-tasks/${first.id}/complete`, 'POST', {});
    assert.equal(response.status, 200, await response.clone().text());
    const bound = await response.json() as UploadTask;
    assert.ok(bound.packId);
    const repeated = await (await request(`/api/upload-tasks/${first.id}/complete`, 'POST', {})).json() as UploadTask;
    assert.equal(repeated.packId, bound.packId);
    await waitCompleted(first.id);
    const duplicate = await create({ source: 'archive', name: 'duplicate', filename: 'duplicate.zip', fileSize: bytes.length });
    const duplicateUpload = await upload(bytes);
    const duplicateTask = await (await request(`/api/upload-tasks/${duplicate.id}/complete`, 'POST', { uploadId: duplicateUpload })).json() as UploadTask;
    assert.equal(duplicateTask.status, 'duplicate');
    assert.equal(duplicateTask.matches[0]?.id, bound.packId);
    assert.equal(duplicateTask.transferredBytes, bytes.length);
    assert.equal((await request(`/api/packs/${bound.packId}`, 'PATCH', { name: 'renamed original' })).status, 200);
    const refreshedDuplicate = await (await request(`/api/upload-tasks/${duplicate.id}`)).json() as UploadTask;
    assert.equal(refreshedDuplicate.matches[0]?.name, 'renamed original');
    assert.equal(refreshedDuplicate.matches[0]?.status, 'extracted');
    const interrupted = await create({ source: 'archive', name: 'interrupted', filename: 'image.zip', fileSize: bytes.length });
    const interruptedUploadId = await upload(bytes);
    await request(`/api/upload-tasks/${interrupted.id}`, 'PATCH', { uploadId: interruptedUploadId });
    await stopTestServer(server);
    const interruptedDb = new Database(path.join(directory, 'db', 'packdb.sqlite'));
    interruptedDb.prepare(`INSERT INTO packs (id, name, original_filename, original_size, original_format, source_type, status)
      VALUES ('interrupted-archive', 'interrupted', 'image.zip', ?, 'zip', 'archive', 'uploading')`).run(bytes.length);
    const interruptedRow = interruptedDb.prepare('SELECT task FROM upload_tasks WHERE id = ?').get(interrupted.id) as { task: string };
    interruptedDb.prepare('UPDATE upload_tasks SET task = ? WHERE id = ?').run(
      JSON.stringify({ ...JSON.parse(interruptedRow.task), packId: 'interrupted-archive', status: 'processing' }), interrupted.id,
    );
    interruptedDb.close();
    server = await startTestServer(directory);
    await waitCompleted(interrupted.id);
    assert.ok(fs.existsSync(path.join(directory, 'archives', 'interrupted-archive', 'original.zip')));
    assert.ok(!fs.existsSync(path.join(directory, 'uploads', interruptedUploadId)));
    const restored = await (await request('/api/upload-tasks')).json() as UploadTask[];
    assert.equal(restored.find(task => task.id === pending.id)?.status, 'needs_file');
    assert.equal(restored.find(task => task.id === duplicate.id)?.status, 'duplicate');
    assert.equal((await request(`/api/upload-tasks/${duplicate.id}/continue`, 'POST', {})).status, 200);
    await waitCompleted(duplicate.id);
    assert.equal((await request(`/api/upload-tasks/${first.id}`, 'DELETE')).status, 200);
    assert.equal((await request(`/api/packs/${bound.packId}`)).status, 200);
    assert.equal((await request(`/api/upload-tasks/${first.id}`)).status, 404);

    const partial = await create({ source: 'folder', name: 'partial transfer', fileSize: image.length * 2 });
    const partialPack = await (await request('/api/packs/folder-create', 'POST', {
      taskId: partial.id, packName: partial.name,
      files: ['first.png', 'second.png'].map(relativePath => ({ relativePath, fileSize: image.length })),
    })).json() as { id: string; packFiles: Array<{ id: string }> };
    const firstFileUpload = await upload(image);
    assert.equal((await request(`/api/packs/${partialPack.id}/folder-file-complete`, 'POST', {
      packFileId: partialPack.packFiles[0]!.id, uploadId: firstFileUpload,
    })).status, 200);
    assert.equal((await request(`/api/upload-tasks/${partial.id}`, 'PATCH', { status: 'failed', error: 'network upload failed' })).status, 200);
    const failedTransfer = await (await request(`/api/upload-tasks/${partial.id}`)).json() as UploadTask;
    assert.equal(failedTransfer.status, 'needs_file', 'a refreshed browser must be able to reselect a failed folder transfer');
    assert.equal(failedTransfer.packId, partialPack.id);
    const partialStatus = await (await request(`/api/packs/${partialPack.id}/folder-upload-status`)).json() as { packFiles: Array<{ id: string; status: string }> };
    assert.equal(partialStatus.packFiles[0]?.status, 'uploaded', 'reselection must retain completed files');
    assert.equal(partialStatus.packFiles[1]?.status, 'pending');
    assert.equal((await request(`/api/upload-tasks/${partial.id}/retry`, 'POST', {})).status, 200);
    assert.equal((await request(`/api/upload-tasks/${partial.id}`, 'PATCH', { status: 'uploading' })).status, 200);
    const secondFileUpload = await upload(image);
    assert.equal((await request(`/api/packs/${partialPack.id}/folder-file-complete`, 'POST', {
      packFileId: partialPack.packFiles[1]!.id, uploadId: secondFileUpload,
    })).status, 200);

    const processingFailure = await create({ source: 'archive', name: 'bad archive', filename: 'bad.zip', fileSize: 3 });
    const invalidUpload = await upload(Buffer.from('bad'));
    await request(`/api/upload-tasks/${processingFailure.id}/complete`, 'POST', { uploadId: invalidUpload });
    for (let attempt = 0; attempt < 100; attempt++) {
      const task = await (await request(`/api/upload-tasks/${processingFailure.id}`)).json() as UploadTask;
      if (task.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal((await (await request(`/api/upload-tasks/${processingFailure.id}`)).json() as UploadTask).status, 'failed', 'processing failures must keep the server retry action');

    const folder = await create({ source: 'folder', name: 'folder', fileSize: image.length });
    const folderResponse = await request('/api/packs/folder-create', 'POST', { taskId: folder.id, packName: 'folder', files: [{ relativePath: 'image.png', fileSize: image.length }] });
    const createdFolder = await folderResponse.json() as { id: string; packFiles: Array<{ id: string }> };
    const repeatedFolder = await (await request('/api/packs/folder-create', 'POST', { taskId: folder.id, packName: 'folder', files: [{ relativePath: 'image.png', fileSize: image.length }] })).json() as { id: string };
    assert.equal(repeatedFolder.id, createdFolder.id);
    await stopTestServer(server);
    server = await startTestServer(directory);
    const restoredFolder = await (await request(`/api/upload-tasks/${folder.id}`)).json() as UploadTask;
    assert.equal(restoredFolder.status, 'needs_file');
    const status = await (await request(`/api/packs/${createdFolder.id}/folder-upload-status`)).json() as { packFiles: Array<{ id: string }> };
    assert.equal(status.packFiles[0]?.id, createdFolder.packFiles[0]?.id);
    assert.equal((await request(`/api/upload-tasks/${folder.id}`, 'PATCH', { status: 'uploading' })).status, 200);
    const imageUpload = await upload(image);
    assert.equal((await request(`/api/packs/${createdFolder.id}/folder-file-complete`, 'POST', { packFileId: createdFolder.packFiles[0]!.id, uploadId: imageUpload })).status, 200);
    for (let attempt = 0; attempt < 100; attempt++) {
      const task = await (await request(`/api/upload-tasks/${folder.id}`)).json() as UploadTask;
      if (task.status === 'duplicate') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    await stopTestServer(server);
    const legacyDb = new Database(path.join(directory, 'db', 'packdb.sqlite'));
    legacyDb.prepare('DELETE FROM upload_tasks WHERE id = ?').run(folder.id);
    legacyDb.close();
    server = await startTestServer(directory);
    const recoveredLegacy = (await (await request('/api/upload-tasks')).json() as UploadTask[]).find(task => task.packId === createdFolder.id)!;
    assert.ok(recoveredLegacy, 'legacy folder confirmation is backfilled into a durable task');
    assert.equal(recoveredLegacy.status, 'duplicate');
    assert.equal((await request(`/api/upload-tasks/${recoveredLegacy.id}/continue`, 'POST', {})).status, 200);
    await waitCompleted(recoveredLegacy.id);
    assert.equal((await request(`/api/upload-tasks/${pending.id}`, 'DELETE')).status, 200);
    assert.equal((await request('/api/upload-tasks', 'POST', { source: 'mega', name: 'unsafe', url: 'https://example.com/file/foo#key' })).status, 400);
  } finally {
    await stopTestServer(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

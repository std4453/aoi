import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-pixiv-tasks-'));
process.env.DATA_DIR = dataDir;
const { initDb, closeDb, getDb } = await import('../src/db/connection.js');
const { getPack, getLatestJob, createPack, createJob, updateJobStatus, updatePackStatus } = await import('../src/db/repositories.js');
const { jobQueue } = await import('../src/services/job-queue.js');
const { recoverUploadTasks, listUploadTasks, getSyncedUploadTask } = await import('../src/services/upload-tasks.js');
const { registerUploadTaskRoutes } = await import('../src/routes/upload-tasks.js');
const { registerPixivRoutes } = await import('../src/routes/pixiv.js');
await initDb();
// Exercise persistence and route transitions without contacting Pixiv.
const originalStart = jobQueue.start;
jobQueue.start = () => {};
const app = Fastify();
await app.register(registerUploadTaskRoutes);
await app.register(registerPixivRoutes);
test.after(async () => {
  await app.close();
  jobQueue.start = originalStart;
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('Pixiv tasks bind atomically, survive recovery, retry downloads and acknowledge without deleting packs', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/upload-tasks', payload: {
    source: 'pixiv', name: 'Pixiv 123', autoName: true, url: 'https://www.pixiv.net/artworks/123',
  } });
  assert.equal(created.statusCode, 200, created.body);
  const task = created.json();
  assert.equal(task.source, 'pixiv');
  assert.equal(task.status, 'downloading');
  assert.equal(getPack(task.packId)?.originalFormat, 'pixiv');
  const firstJob = getLatestJob(task.packId, 'pixiv')!;
  assert.deepEqual(JSON.parse(firstJob.options!), { autoName: true, autoTags: true });
  assert.equal((await app.inject({ method: 'PATCH', url: `/api/upload-tasks/${task.id}`, payload: { status: 'completed' } })).statusCode, 400);
  closeDb();
  await initDb();
  recoverUploadTasks();
  assert.equal(getSyncedUploadTask(task.id)?.status, 'downloading');
  assert.equal(listUploadTasks().filter(item => item.packId === task.packId).length, 1);
  updateJobStatus(firstJob.id, 'failed', undefined, 'network interrupted');
  updatePackStatus(task.packId, 'failed', 'network interrupted');
  assert.equal(getSyncedUploadTask(task.id)?.status, 'failed');
  const retried = await app.inject({ method: 'POST', url: `/api/upload-tasks/${task.id}/retry`, payload: {} });
  assert.equal(retried.statusCode, 200, retried.body);
  assert.equal(retried.json().status, 'downloading');
  const nextJob = getLatestJob(task.packId, 'pixiv')!;
  assert.notEqual(nextJob.id, firstJob.id);
  assert.equal(nextJob.options, firstJob.options);
  updateJobStatus(nextJob.id, 'completed');
  getDb().prepare('UPDATE packs SET name = ?, original_size = ? WHERE id = ?').run('Artwork title', 456, task.packId);
  updatePackStatus(task.packId, 'extracted');
  assert.equal(getSyncedUploadTask(task.id)?.name, 'Artwork title');
  assert.equal(getSyncedUploadTask(task.id)?.totalBytes, 456);
  assert.equal(getSyncedUploadTask(task.id)?.transferredBytes, 456);
  assert.equal(getSyncedUploadTask(task.id)?.status, 'completed');
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/upload-tasks/${task.id}` })).statusCode, 200);
  assert.ok(getPack(task.packId));
  recoverUploadTasks();
  assert.equal(listUploadTasks().some(item => item.packId === task.packId), false);
});

test('legacy Pixiv import creates one unified task and cancellation removes its queued download', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/packs/pixiv-import', payload: {
    url: 'https://www.pixiv.net/artworks/456', packName: 'Custom title', tagIds: [],
  } });
  assert.equal(created.statusCode, 202, created.body);
  const pack = created.json();
  const task = listUploadTasks().find(item => item.packId === pack.id)!;
  assert.ok(task);
  assert.equal(task.source, 'pixiv');
  assert.deepEqual(JSON.parse(getLatestJob(pack.id, 'pixiv')!.options!), { autoName: false, autoTags: false });
  assert.equal((await app.inject({ method: 'DELETE', url: `/api/upload-tasks/${task.id}` })).statusCode, 200);
  assert.equal(getPack(pack.id), undefined);
  assert.equal(getSyncedUploadTask(task.id), undefined);
});

test('recovery backfills existing failed Pixiv jobs without turning them into local file uploads', () => {
  const pack = createPack({ name: 'Old import', originalFilename: 'https://www.pixiv.net/artworks/789',
    originalSize: 0, originalFormat: 'pixiv', sourceType: 'folder' });
  const job = createJob(pack.id, 'pixiv');
  updateJobStatus(job.id, 'failed', undefined, 'connection failed');
  updatePackStatus(pack.id, 'failed', 'connection failed');
  recoverUploadTasks();
  const task = listUploadTasks().find(item => item.packId === pack.id)!;
  assert.equal(task.source, 'pixiv');
  assert.equal(task.status, 'failed');
  recoverUploadTasks();
  assert.equal(listUploadTasks().filter(item => item.packId === pack.id).length, 1);
});

test('rejects invalid Pixiv task inputs without leaving a partial task or pack', async () => {
  const count = listUploadTasks().length;
  for (const payload of [
    { source: 'pixiv', name: 'Bad', url: 'https://localhost/artworks/123' },
    { source: 'pixiv', name: 'Bad', url: 'https://www.pixiv.net/artworks/123', autoName: 'true' },
    { source: 'pixiv', name: 'Bad', url: 'https://www.pixiv.net/artworks/123', tagIds: ['missing'] },
  ]) assert.equal((await app.inject({ method: 'POST', url: '/api/upload-tasks', payload })).statusCode, 400);
  assert.equal(listUploadTasks().length, count);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';
import type { UploadTask } from '../../shared/types.js';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-task-progress-'));
process.env.DATA_DIR = dataDir;
const { initDb, closeDb } = await import('../src/db/connection.js');
const { createPack, createJob, updateJobStatus, updateJobProgress, updatePackStatus } = await import('../src/db/repositories.js');
const { createUploadTask, updateUploadTask, getUploadTask } = await import('../src/services/upload-tasks.js');
const { registerUploadTaskRoutes } = await import('../src/routes/upload-tasks.js');
await initDb();
const app = Fastify();
await app.register(registerUploadTaskRoutes);
test.after(async () => {
  await app.close();
  closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('task API reports current queued/running processing stages, counts and restored progress for all sources', async () => {
  for (const source of ['archive', 'folder', 'mega', 'pixiv'] as const) {
    const task = createUploadTask({ source, name: source, fileSize: 4096 });
    const pack = createPack({ name: source, originalFilename: 'fixture.zip', originalSize: 4096,
      originalFormat: source === 'pixiv' ? 'pixiv' : 'zip', sourceType: source === 'folder' || source === 'pixiv' ? 'folder' : 'archive' });
    updateUploadTask(task.id, { packId: pack.id });
    const read = async () => {
      const response = await app.inject({ method: 'GET', url: `/api/upload-tasks/${task.id}` });
      assert.equal(response.statusCode, 200, response.body);
      return response.json<UploadTask>();
    };
    for (const [stage, type, total] of [
      ['extracting', 'extract', 0], ['verifying', 'verify', 4096], ['thumbnailing', 'thumbnail', 4],
    ] as const) {
      updatePackStatus(pack.id, stage);
      const job = createJob(pack.id, type);
      let current = await read();
      assert.equal(current.status, 'processing');
      assert.equal(current.transferredBytes, 4096);
      assert.deepEqual(current.processing, { stage, queued: true, completed: 0, total: 0 });
      updateJobStatus(job.id, 'running');
      current = await read();
      assert.deepEqual(current.processing, { stage, queued: false, completed: 0, total: 0 });
      if (total) {
        updateJobProgress(job.id, 50, { completed: total / 2, total, phase: stage });
        closeDb();
        await initDb();
        current = await read();
        assert.equal(current.progress, 50);
        assert.deepEqual(current.processing, { stage, queued: false, completed: total / 2, total });
        const listed = (await app.inject({ method: 'GET', url: '/api/upload-tasks' })).json<UploadTask[]>();
        assert.deepEqual(listed.find(item => item.id === task.id)?.processing, current.processing);
      }
      assert.equal(getUploadTask(task.id)?.processing, undefined, 'live stage details are derived, not persisted in the task');
      updateJobStatus(job.id, 'completed', 100);
    }
    updatePackStatus(pack.id, 'failed', 'thumbnail failed');
    assert.equal((await read()).processing, undefined);
    updatePackStatus(pack.id, 'extracted');
    const completed = await read();
    assert.equal(completed.status, 'completed');
    assert.equal(completed.progress, 100);
    assert.equal(completed.processing, undefined);
  }
});

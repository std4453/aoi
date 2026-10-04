import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockAgent, setGlobalDispatcher } from 'undici';
import Fastify from 'fastify';
import { TaskError, taskErrorCategories } from '../../shared/task-errors.js';
import type { TaskErrorCode, UploadTask } from '../../shared/types.js';
import { taskNeedsLogin, taskErrorMessage } from '../../client/src/features/uploads/task-display.ts';
import { archiveErrorCode, taskErrorCode } from '../src/services/task-errors.js';
import migration from '../src/db/migrations/011_add_task_error_codes.js';

const data = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-task-errors-'));
process.env.DATA_DIR = data;
for (const key of ['AOI_PROXY_URL', 'PIXIV_PROXY_URL', 'PIXIV_COOKIE', 'PIXIV_REFRESH_TOKEN', 'FANBOX_COOKIES_FILE', 'FANBOX_SESSION_ID', 'AOI_FLARESOLVERR_URL', 'AOI_FLARESOLVERR_PROXY_URL']) delete process.env[key];
const { initDb, closeDb, getDb } = await import('../src/db/connection.js');
const { createUploadTask, getUploadTask } = await import('../src/db/upload-task-repository.js');
const { getLatestJob, createPack, createJob, updateJobStatus, updatePackStatus } = await import('../src/db/repositories.js');
const { jobQueue } = await import('../src/services/job-queue.js');
const { registerUploadTaskRoutes } = await import('../src/routes/upload-tasks.js');
await initDb();
const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
const app = Fastify(); await app.register(registerUploadTaskRoutes);
const start = jobQueue.start.bind(jobQueue);
jobQueue.start = () => {};

test.after(async () => {
  await jobQueue.shutdown(3000);
  jobQueue.start = start;
  await app.close(); agent.assertNoPendingInterceptors(); await agent.close(); closeDb();
  fs.rmSync(data, { recursive: true, force: true });
});

async function readFailed(id: string): Promise<UploadTask> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await app.inject({ method: 'GET', url: `/api/upload-tasks/${id}` });
    const task = response.json<UploadTask>();
    if (task.status === 'failed') return task;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Synthetic task did not finish');
}

test('real source errors survive jobs, task APIs, restart, and retry without downloading media', async () => {
  const cases: Array<{ source: 'fanbox' | 'pixiv'; status: number; json: boolean; code: TaskErrorCode }> = [
    { source: 'fanbox', status: 403, json: true, code: 'ACCESS_DENIED' },
    { source: 'fanbox', status: 403, json: false, code: 'SOURCE_BLOCKED' },
    { source: 'fanbox', status: 429, json: true, code: 'RATE_LIMITED' },
    { source: 'pixiv', status: 403, json: true, code: 'ACCESS_DENIED' },
  ];
  for (const scenario of cases) {
    const url = scenario.source === 'fanbox' ? 'https://sample.fanbox.cc/posts/123' : 'https://www.pixiv.net/artworks/123';
    agent.get(scenario.source === 'fanbox' ? 'https://api.fanbox.cc' : 'https://www.pixiv.net')
      .intercept({ path: scenario.source === 'fanbox' ? '/post.info?postId=123' : '/ajax/illust/123' })
      .reply(scenario.status, scenario.json ? { error: true } : 'blocked', { headers: { 'content-type': scenario.json ? 'application/json' : 'text/html' } });
    const created = await app.inject({ method: 'POST', url: '/api/upload-tasks', payload: { source: scenario.source, name: 'Synthetic', url } });
    assert.equal(created.statusCode, 200);
    const initial = created.json<UploadTask>();
    assert.equal(initial.isRemote, true);
    start();
    const task = await readFailed(initial.id);
    assert.equal(task.errorCode, scenario.code);
    assert.equal(task.errorCategory, taskErrorCategories[scenario.code]);
    assert.equal(taskNeedsLogin(task), scenario.code === 'ACCESS_DENIED');
    assert.equal(getLatestJob(task.packId!, scenario.source)?.errorCode, scenario.code);
    // Queue completion precedes closing the test database.
    await new Promise(resolve => setTimeout(resolve, 120));
    closeDb(); await initDb();
    assert.equal(getUploadTask(task.id)?.errorCode, scenario.code);
    assert.equal(getUploadTask(task.id)?.isRemote, true);
    const retried = await app.inject({ method: 'POST', url: `/api/upload-tasks/${task.id}/retry`, payload: {} });
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(retried.json().errorCode, null);
    assert.equal(retried.json().errorCategory, null);
    // Do not execute the queued retry against the network.
    updateJobStatus(getLatestJob(task.packId!, scenario.source)!.id, 'cancelled');
  }
});

test('processing failures use explicit job stages and codes, including password recovery', async () => {
  const created = await app.inject({ method: 'POST', url: '/api/upload-tasks', payload: {
    source: 'pixiv', name: 'Synthetic', url: 'https://www.pixiv.net/artworks/456',
  } });
  const task = created.json<UploadTask>();
  updateJobStatus(getLatestJob(task.packId!, 'pixiv')!.id, 'completed');
  for (const [type, code] of [['extract', 'PASSWORD_INCORRECT'], ['verify', 'VERIFICATION_FAILED'], ['thumbnail', 'PREVIEW_FAILED']] as const) {
    const job = createJob(task.packId!, type);
    updateJobStatus(job.id, 'failed', 0, 'private/RefreshToken.php', code);
    updatePackStatus(task.packId!, 'failed', 'private/RefreshToken.php');
    const response = await app.inject({ method: 'GET', url: `/api/upload-tasks/${task.id}` });
    const failed = response.json<UploadTask>();
    assert.equal(failed.errorCode, code);
    assert.equal(failed.status, type === 'extract' ? 'password' : 'failed');
    assert.equal(taskNeedsLogin(failed), false);
    assert.doesNotMatch(taskErrorMessage(failed), /private|RefreshToken/);
  }
});

test('migration is idempotent and older JSON rows gain a trustworthy derived remote flag', () => {
  migration.up(getDb()); migration.up(getDb());
  for (const source of ['archive', 'folder', 'mega', 'pixiv', 'fanbox'] as const) {
    const created = createUploadTask({ source, name: 'Synthetic' });
    const { isRemote: _remote, errorCode: _code, errorCategory: _category, ...legacy } = created;
    getDb().prepare('UPDATE upload_tasks SET task = ? WHERE id = ?').run(JSON.stringify(legacy), created.id);
    assert.equal(getUploadTask(created.id)?.isRemote, !['archive', 'folder'].includes(source));
    assert.equal(getUploadTask(created.id)?.errorCode, null);
  }
});

test('pre-migration extraction failures still request an archive password', async () => {
  const pack = createPack({ name: 'Synthetic', originalFilename: 'encrypted.zip', originalSize: 1, originalFormat: 'zip' });
  const job = createJob(pack.id, 'extract');
  updateJobStatus(job.id, 'failed', 0, 'ERROR: Wrong password');
  updatePackStatus(pack.id, 'failed', 'ERROR: Wrong password');
  const created = createUploadTask({ source: 'archive', name: 'Synthetic' });
  getDb().prepare('UPDATE upload_tasks SET task = ? WHERE id = ?')
    .run(JSON.stringify({ ...created, packId: pack.id, status: 'password', passwordKind: 'archive' }), created.id);
  const response = await app.inject({ method: 'GET', url: `/api/upload-tasks/${created.id}` });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().status, 'password');
  assert.equal(response.json().errorCode, 'PASSWORD_INCORRECT');
  assert.equal(response.json().errorCategory, 'password');
});

test('typed source errors and OS codes win over arbitrary diagnostic wording', () => {
  assert.equal(taskErrorCode(new TaskError('ACCESS_DENIED', 'anything'), 'DOWNLOAD_FAILED'), 'ACCESS_DENIED');
  assert.equal(taskErrorCode(Object.assign(new Error('anything'), { code: 'ENOSPC' }), 'UPLOAD_FAILED'), 'STORAGE_FULL');
  assert.equal(archiveErrorCode(new Error('7z 解压失败: ERROR: Unsupported Method : app/RefreshToken.php')), 'ARCHIVE_UNSUPPORTED');
  assert.equal(archiveErrorCode(new Error('ERROR: Wrong password')), 'PASSWORD_INCORRECT');
  assert.equal(archiveErrorCode(new Error('无法检查压缩包内容: Path = wrong password.png\nEncrypted = -')), 'EXTRACTION_FAILED');
});

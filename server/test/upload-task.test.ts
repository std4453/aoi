import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify from 'fastify';
import { MockAgent } from 'undici';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-upload-task-'));
process.env.DATA_DIR = dataDir;
process.env.PIXIV_REFRESH_TOKEN = '';
const { initDb, closeDb, getDb } = await import('../src/db/connection.js');
const { createPack, createJob, getPack, getJob, updatePackStatus, updateJobStatus, getLatestJob, createTag, listTags } = await import('../src/db/repositories.js');
const { registerPackRoutes } = await import('../src/routes/packs.js');
const { jobQueue } = await import('../src/services/job-queue.js');
const { PixivClient, getPixivClient } = await import('../src/services/pixiv-importer.js');
const { getExtractedImagesDir } = await import('../src/services/storage.js');
await initDb();
test.after(async () => { await jobQueue.shutdown(5000); closeDb(); fs.rmSync(dataDir, { recursive: true, force: true }); });
const makePack = (sourceType: 'folder' | 'archive' = 'folder') => createPack({ name: 'Test', originalFilename: sourceType === 'folder' ? 'https://www.pixiv.net/artworks/123' : 'test.zip', originalSize: 0, originalFormat: sourceType === 'folder' ? 'pixiv' : 'zip', sourceType });

test('task status exposes extraction errors, allows deletion and preserves tags', async t => {
  t.mock.method(jobQueue, 'start', () => {});
  const app = Fastify(); await app.register(registerPackRoutes);
  try {
    const pack = makePack('archive');
    createTag('survives cancellation');
    const job = createJob(pack.id, 'extract');
    updateJobStatus(job.id, 'failed', 0, 'Wrong password'); updatePackStatus(pack.id, 'failed', 'Wrong password');
    const status = (await app.inject(`/api/packs/${pack.id}/upload-task`)).json();
    assert.equal(status.pack.errorMessage, 'Wrong password'); assert.equal(status.retryable, false);
    assert.equal((await app.inject({ method: 'POST', url: `/api/packs/${pack.id}/upload-task/retry` })).statusCode, 409);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/packs/${pack.id}/upload-task` })).statusCode, 200);
    assert.equal(getPack(pack.id), undefined); assert.equal(listTags().length, 1);
    assert.equal((await app.inject({ method: 'DELETE', url: `/api/packs/${pack.id}/upload-task` })).statusCode, 200);
  } finally { await app.close(); }
});

test('retry preserves Pixiv defaults and rejects duplicate active retries; pending cancellation removes files', async t => {
  t.mock.method(jobQueue, 'start', () => {});
  const app = Fastify(); await app.register(registerPackRoutes);
  try {
    const pack = makePack(); const job = createJob(pack.id, 'pixiv');
    getDb().prepare('UPDATE jobs SET options = ? WHERE id = ?').run('{"autoName":false,"autoTags":false}', job.id);
    const status = (await app.inject(`/api/packs/${pack.id}/upload-task`)).json();
    assert.equal(status.progress.status, 'pending');
    assert.equal(status.pack.archivePassword, undefined);
    assert.equal((await app.inject({ method: 'POST', url: `/api/packs/${pack.id}/upload-task/retry` })).statusCode, 409);
    updateJobStatus(job.id, 'failed'); updatePackStatus(pack.id, 'failed', 'login failed');
    assert.equal((await app.inject(`/api/packs/${pack.id}/upload-task`)).json().retryable, true);
    assert.equal((await app.inject({ method: 'POST', url: `/api/packs/${pack.id}/upload-task/retry` })).statusCode, 200);
    assert.equal(getPack(pack.id)?.status, 'uploading');
    assert.equal(getLatestJob(pack.id, 'pixiv')?.options, '{"autoName":false,"autoTags":false}');
    assert.equal((await app.inject({ method: 'POST', url: `/api/packs/${pack.id}/upload-task/retry` })).statusCode, 409);
    const dir = getExtractedImagesDir(pack.id); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'test.part'), 'partial');
    await app.inject({ method: 'DELETE', url: `/api/packs/${pack.id}/upload-task` });
    assert.equal(fs.existsSync(dir), false); assert.equal(getPack(pack.id), undefined);
  } finally { await app.close(); }
});

test('cancelling a running download aborts it before deleting its files and cannot queue verification', async t => {
  const app = Fastify(); await app.register(registerPackRoutes);
  const pack = makePack(); const job = createJob(pack.id, 'pixiv');
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  t.mock.method(getPixivClient(), 'artwork', async () => ({ metadata: { title: 'Title', userName: 'Author', illustType: 0, pageCount: 1 }, pages: [{ urls: { original: 'https://i.pximg.net/test.jpg' } }], ugoira: undefined }));
  t.mock.method(getPixivClient(), 'download', async (_url, destination, _limit, _zip, signal) => {
    fs.writeFileSync(destination + '.part', 'partial'); began();
    await new Promise<void>((_resolve, reject) => {
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return 1;
  });
  try {
    jobQueue.start(); await started;
    const deleted = await app.inject({ method: 'DELETE', url: `/api/packs/${pack.id}/upload-task` });
    assert.equal(deleted.statusCode, 200); assert.equal(getPack(pack.id), undefined);
    assert.equal(getJob(job.id), undefined); assert.equal(fs.existsSync(getExtractedImagesDir(pack.id)), false);
    assert.equal(getDb().prepare('SELECT count(*) AS n FROM jobs WHERE pack_id = ?').get(pack.id)?.n, 0);
  } finally { await app.close(); }
});

test('anonymous access failures explain the missing token and resolution without calling all failures authentication errors', async () => {
  const agent = new MockAgent(); agent.disableNetConnect();
  try {
    const client = new PixivClient(agent);
    for (const response of [403, 200]) {
      agent.get('https://www.pixiv.net').intercept({ path: '/ajax/illust/123' }).reply(response, { error: true, body: null });
      await assert.rejects(client.describe('123'), error => {
        assert.match(String(error), /未配置 refresh-token/); assert.match(String(error), /gallery-dl oauth:pixiv/); assert.match(String(error), /保存后重试/); return true;
      });
    }
    agent.get('https://www.pixiv.net').intercept({ path: '/ajax/illust/123' }).reply(429, 'rate limit');
    await assert.rejects(client.describe('123'), /请求过于频繁/);
  } finally { await agent.close(); }
});

test('cancellation reaches an in-flight metadata request before any files are downloaded', async () => {
  const agent = new MockAgent(); agent.disableNetConnect();
  const controller = new AbortController();
  try {
    agent.get('https://www.pixiv.net').intercept({ path: '/ajax/illust/123' })
      .reply(200, { error: false, body: { title: 'Title', userName: 'Author', illustType: 0, pageCount: 1 } }).delay(500);
    const request = new PixivClient(agent).artwork('123', controller.signal);
    controller.abort();
    await assert.rejects(request);
    agent.assertNoPendingInterceptors(); // Aborted metadata must not request the pages endpoint.
  } finally { await agent.close(); }
});

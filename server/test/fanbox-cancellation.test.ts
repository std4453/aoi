import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-fanbox-cancel-'));
process.env.DATA_DIR = dataDir;
process.env.AOI_PROXY_URL = '';
process.env.FANBOX_SESSION_ID = '';
process.env.FANBOX_COOKIES_FILE = '';
const { initDb, closeDb, getDb } = await import('../src/db/connection.js');
const { getPack, listTags } = await import('../src/db/repositories.js');
const { getFanboxClient } = await import('../src/services/fanbox-client.js');
const { jobQueue } = await import('../src/services/job-queue.js');
const { registerUploadTaskRoutes } = await import('../src/routes/upload-tasks.js');
const { registerFanboxRoutes } = await import('../src/routes/fanbox.js');
const { getExtractedImagesDir } = await import('../src/services/storage.js');
await initDb();
test.after(() => { closeDb(); fs.rmSync(dataDir, { recursive: true, force: true }); });
const post = { title: 'Fixture title', author: 'Fixture author', skippedCount: 2,
  media: [{ url: 'https://downloads.fanbox.cc/fixture.png', category: 'image' as const, extension: '.png' }] };

test('metadata only returns the import summary and author tag', async t => {
  t.mock.method(getFanboxClient(), 'post', async () => post);
  const app = Fastify(); await app.register(registerFanboxRoutes);
  try {
    const response = await app.inject({ method: 'POST', url: '/api/packs/fanbox-metadata', payload: { url: 'https://sample.fanbox.cc/posts/123' } });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers['cache-control'], 'no-store');
    const metadata = response.json();
    assert.deepEqual(Object.keys(metadata).sort(), ['author', 'imageCount', 'skippedCount', 'tags', 'title', 'videoCount']);
    assert.equal(metadata.title, post.title); assert.equal(metadata.imageCount, 1); assert.equal(metadata.videoCount, 0);
    assert.deepEqual(listTags().map(tag => tag.name), [post.author]);
    assert.equal(response.body.includes('downloads.fanbox.cc'), false);
  } finally { await app.close(); }
});

test('cancelling a running FANBOX download aborts before deleting files and cannot enqueue verification', async t => {
  const app = Fastify(); await app.register(registerUploadTaskRoutes);
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  t.mock.method(getFanboxClient(), 'post', async () => post);
  t.mock.method(getFanboxClient(), 'download', async (_media, destination, _limit, signal) => {
    fs.writeFileSync(`${destination}.part`, 'partial'); began();
    await new Promise<void>((_resolve, reject) => {
      if (signal?.aborted) reject(signal.reason);
      else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    return 1;
  });
  try {
    const response = await app.inject({ method: 'POST', url: '/api/upload-tasks', payload: { source: 'fanbox', name: 'Cancel fixture', url: 'https://sample.fanbox.cc/posts/123' } });
    assert.equal(response.statusCode, 200);
    const task = response.json();
    await started;
    const deleted = await app.inject({ method: 'DELETE', url: `/api/upload-tasks/${task.id}` });
    assert.equal(deleted.statusCode, 200);
    assert.equal(getPack(task.packId), undefined);
    assert.equal(fs.existsSync(getExtractedImagesDir(task.packId)), false);
    assert.equal((getDb().prepare('SELECT count(*) AS n FROM jobs WHERE pack_id = ?').get(task.packId) as { n: number }).n, 0);
    assert.equal(await jobQueue.shutdown(1000), true);
  } finally { await app.close(); }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { MockAgent } from 'undici';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-pixiv-'));
process.env.DATA_DIR = dataDir;
const { initDb, closeDb, getDb } = await import('../src/db/connection.js');
const { createPack, getPack, createJob, recoverInterruptedJobs, claimNextPendingJob, updateJobStatus } = await import('../src/db/repositories.js');
const { PixivClient, parsePixivUrl, validatePixivImageUrl, importPixivPack } = await import('../src/services/pixiv-importer.js');
const { getExtractedImagesDir } = await import('../src/services/storage.js');
const { verifyPack } = await import('../src/services/content-verification.js');
await initDb();
test.after(() => { closeDb(); fs.rmSync(dataDir, { recursive: true, force: true }); });

test('only accepts Pixiv artwork URLs and original image hosts', () => {
  assert.deepEqual(parsePixivUrl(' https://www.pixiv.net/en/artworks/123?source=share#x '), { id: '123', url: 'https://www.pixiv.net/artworks/123' });
  for (const url of ['http://www.pixiv.net/artworks/1', 'https://pixiv.net.evil/artworks/1', 'https://localhost/artworks/1', 'https://user@pixiv.net/artworks/1', 'https://pixiv.net:8889/artworks/1', 'https://pixiv.net/users/1', 'https://pixiv.net/artworks/0']) {
    assert.throws(() => parsePixivUrl(url));
  }
  for (const url of ['http://i.pximg.net/a.jpg', 'https://i.pximg.net.evil/a.jpg', 'https://127.0.0.1/a.jpg', 'https://i.pximg.net/a.svg', 'https://user@i.pximg.net/a.jpg']) {
    assert.throws(() => validatePixivImageUrl(url));
  }
});

function mockArtwork(agent: MockAgent, count = 2, type = 0) {
  agent.get('https://www.pixiv.net').intercept({ path: '/ajax/illust/123' }).reply(200, {
    error: false, body: { title: 'A work', userName: 'Artist', pageCount: count, illustType: type },
  });
  if (type !== 2) agent.get('https://www.pixiv.net').intercept({ path: '/ajax/illust/123/pages' }).reply(200, {
    error: false, body: Array.from({ length: count }, (_, index) => ({ urls: { original: `https://i.pximg.net/123_p${index}.png` } })),
  });
}

test('downloads all original pages, persists stats, resumes a partial import and verifies content', async () => {
  const agent = new MockAgent(); agent.disableNetConnect();
  const client = new PixivClient(agent);
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#336699' } }).png().toBuffer();
  const pack = createPack({ name: 'Pixiv 123', originalFilename: 'https://www.pixiv.net/artworks/123', originalSize: 0, originalFormat: 'pixiv', sourceType: 'folder' });
  try {
    mockArtwork(agent);
    agent.get('https://i.pximg.net').intercept({ path: '/123_p0.png' }).reply(200, image, { headers: { 'content-type': 'image/png' } });
    agent.get('https://i.pximg.net').intercept({ path: '/123_p1.png' }).reply(503, 'unavailable');
    await assert.rejects(importPixivPack(pack.id, () => {}, client), /503/);
    assert.equal(getPack(pack.id)?.imageCount, 0);
    assert.deepEqual(fs.readdirSync(getExtractedImagesDir(pack.id)), ['123_p000.png']);

    mockArtwork(agent);
    for (let index = 0; index < 2; index++) agent.get('https://i.pximg.net').intercept({ path: `/123_p${index}.png` }).reply(200, image, { headers: { 'content-type': 'image/png' } });
    const progress: number[] = [];
    await importPixivPack(pack.id, completed => progress.push(completed), client);
    assert.deepEqual(progress, [0, 1, 2]);
    const imported = getPack(pack.id)!;
    assert.equal(imported.name, 'A work');
    assert.deepEqual(imported.tags.map(tag => tag.name), ['Artist']);
    assert.equal(imported.imageCount, 2);
    assert.equal(imported.originalSize, image.length * 2);
    assert.equal(imported.status, 'verifying');
    await verifyPack(pack.id, new AbortController().signal, () => {});
    assert.equal(getPack(pack.id)?.status, 'thumbnailing');
    agent.assertNoPendingInterceptors();
  } finally { await agent.close(); }
});

test('rejects redirects, login failures and unsafe page URLs', async () => {
  const agent = new MockAgent(); agent.disableNetConnect();
  const client = new PixivClient(agent, 'session=test');
  try {
    agent.get('https://www.pixiv.net').intercept({ path: '/ajax/illust/123' }).reply(302, '', { headers: { location: 'http://127.0.0.1/' } });
    await assert.rejects(client.artwork('123'), /302/);
    agent.get('https://www.pixiv.net').intercept({ path: '/ajax/illust/123' }).reply(403, 'denied');
    await assert.rejects(client.artwork('123'), /未配置 refresh-token/);
    agent.get('https://www.pixiv.net').intercept({ path: '/ajax/illust/123' }).reply(200, { error: false, body: { title: 'x', userName: 'y', pageCount: 1, illustType: 0 } });
    agent.get('https://www.pixiv.net').intercept({ path: '/ajax/illust/123/pages' }).reply(200, { error: false, body: [{ urls: { original: 'https://127.0.0.1/a.jpg' } }] });
    await assert.rejects(client.artwork('123'), /原图地址/);
  } finally { await agent.close(); }
});

test('rejects oversized and invalid images, removes partial files and never sends cookies to CDN', async () => {
  const agent = new MockAgent(); agent.disableNetConnect();
  const client = new PixivClient(agent, 'session=secret');
  const destination = path.join(dataDir, 'invalid.png');
  try {
    agent.get('https://i.pximg.net').intercept({ path: '/a.png', headers: headers => !headers.cookie && headers.referer === 'https://www.pixiv.net/' }).reply(200, Buffer.alloc(20), { headers: { 'content-type': 'image/png' } });
    await assert.rejects(client.download('https://i.pximg.net/a.png', destination, 10), /大小限制/);
    assert.equal(fs.existsSync(destination + '.part'), false);
    agent.get('https://i.pximg.net').intercept({ path: '/a.png' }).reply(200, 'not an image', { headers: { 'content-type': 'image/png' } });
    await assert.rejects(client.download('https://i.pximg.net/a.png', destination, 1000));
    assert.equal(fs.existsSync(destination), false);
    assert.equal(fs.existsSync(destination + '.part'), false);
  } finally { await agent.close(); }
});

test('interrupted Pixiv jobs are durable and requeued without duplicating a job', () => {
  getDb().prepare("UPDATE jobs SET status = 'completed'").run();
  const pack = createPack({ name: 'custom', originalFilename: 'https://www.pixiv.net/artworks/123', originalSize: 0, originalFormat: 'pixiv', sourceType: 'folder' });
  const job = createJob(pack.id, 'pixiv');
  assert.equal(claimNextPendingJob()?.id, job.id);
  closeDb();
  // The real startup runs recoverInterruptedJobs before considering pending packs.
  return initDb().then(() => {
    assert.equal(recoverInterruptedJobs(), 1);
    assert.equal(claimNextPendingJob()?.id, job.id);
    updateJobStatus(job.id, 'completed');
    assert.equal(getPack(pack.id)?.originalFilename, 'https://www.pixiv.net/artworks/123');
  });
});

test('import routes validate input, atomically create tagged jobs, expose status and restrict retry', async t => {
  const { default: Fastify } = await import('fastify');
  const { registerPixivRoutes } = await import('../src/routes/pixiv.js');
  const { jobQueue } = await import('../src/services/job-queue.js');
  const { createTag, listPacks, updatePackStatus, getLatestJob } = await import('../src/db/repositories.js');
  t.mock.method(jobQueue, 'start', () => {});
  const app = Fastify();
  await app.register(registerPixivRoutes);
  try {
    const before = listPacks().length;
    for (const payload of [{ url: 'http://127.0.0.1/' }, { url: 'https://www.pixiv.net/artworks/123', tagIds: ['missing'] }, { url: 123 }]) {
      const result = await app.inject({ method: 'POST', url: '/api/packs/pixiv-import', payload });
      assert.equal(result.statusCode, 400);
    }
    assert.equal(listPacks().length, before);
    const tag = createTag('favorite');
    const result = await app.inject({ method: 'POST', url: '/api/packs/pixiv-import', payload: {
      url: 'https://www.pixiv.net/en/artworks/123?share=1', packName: 'My favorite', tagIds: [tag.id],
    } });
    assert.equal(result.statusCode, 202);
    const pack = result.json();
    assert.equal(pack.name, 'My favorite');
    assert.equal(pack.tags[0].id, tag.id);
    assert.equal(pack.originalFilename, 'https://www.pixiv.net/artworks/123');
    const status = await app.inject(`/api/packs/${pack.id}/pixiv-import`);
    assert.equal(status.json().progress.status, 'pending');
    assert.equal(status.json().pack.archivePassword, undefined);
    assert.equal((await app.inject({ method: 'POST', url: `/api/packs/${pack.id}/pixiv-retry` })).statusCode, 409);
    updateJobStatus(getLatestJob(pack.id, 'pixiv')!.id, 'failed', 0, 'network');
    updatePackStatus(pack.id, 'failed', 'network');
    assert.equal((await app.inject({ method: 'POST', url: `/api/packs/${pack.id}/pixiv-retry` })).statusCode, 200);
    assert.equal(getPack(pack.id)?.status, 'uploading');
    assert.equal((await app.inject({ method: 'POST', url: `/api/packs/${pack.id}/pixiv-retry` })).statusCode, 409);
  } finally { await app.close(); }
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';
import { MockAgent } from 'undici';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-fanbox-'));
process.env.DATA_DIR = dataDir;
process.env.FANBOX_SESSION_ID = '';
process.env.FANBOX_COOKIES_FILE = '';
const { initDb, closeDb, getDb } = await import('../src/db/connection.js');
const { createPack, getPack, createJob } = await import('../src/db/repositories.js');
const { FanboxClient, parseFanboxUrl, validateFanboxMediaUrl, extractFanboxPost } = await import('../src/services/fanbox-client.js');
const { importFanboxPack } = await import('../src/services/fanbox-importer.js');
const { getExtractedImagesDir, getExtractedVideosDir } = await import('../src/services/storage.js');
const { verifyPack } = await import('../src/services/content-verification.js');
await initDb();
test.after(() => { closeDb(); fs.rmSync(dataDir, { recursive: true, force: true }); });
const api = 'https://api.fanbox.cc';
const cdn = 'https://downloads.fanbox.cc';
const imageUrl = `${cdn}/images/post/sample.png`;
const videoUrl = `${cdn}/files/post/clip.mp4`;
const headers = { 'content-type': 'application/json' };
const post = (body: unknown, type = 'article') => ({ id: '123', title: 'Sample post', creatorId: 'sample', user: { name: 'Sample author' }, type, body });
const article = () => post({ blocks: [
  { type: 'p', text: 'Private prose is ignored', links: [{ url: 'https://elsewhere.test/video.mp4' }] },
  { type: 'file', fileId: 'video' }, { type: 'image', imageId: 'picture' },
  { type: 'file', fileId: 'archive' }, { type: 'file', fileId: 'text' }, { type: 'embed', embedId: 'external' },
], imageMap: { picture: { originalUrl: imageUrl }, unreferenced: { originalUrl: `${cdn}/cover.png` } },
fileMap: { video: { name: '../../unsafe', extension: 'zip', url: videoUrl }, archive: { url: `${cdn}/archive.zip` }, text: { url: `${cdn}/notes.txt` } },
embedMap: { external: { serviceProvider: 'youtube', contentId: 'sample' } } });
function agentClient() {
  const agent = new MockAgent(); agent.disableNetConnect();
  return { agent, client: new FanboxClient(agent, () => ({ sessionId: 'test-session', source: 'settings' }), () => {}) };
}
function mockPost(agent: MockAgent, raw = article()) {
  agent.get(api).intercept({ path: '/post.info?postId=123' }).reply(200, { body: raw }, { headers });
}

test('accepts both FANBOX post formats and rejects unsafe origins and media types', () => {
  for (const input of ['https://sample.fanbox.cc/posts/123?x=y', 'https://www.fanbox.cc/@sample/posts/123#top', 'https://fanbox.cc/@sample/posts/123/']) {
    assert.deepEqual(parseFanboxUrl(input), { id: '123', url: 'https://www.fanbox.cc/@sample/posts/123' });
  }
  for (const input of ['http://sample.fanbox.cc/posts/123', 'https://api.fanbox.cc/posts/123', 'https://sample.fanbox.cc.evil/posts/123', 'https://sample.fanbox.cc:8080/posts/123', 'https://user@sample.fanbox.cc/posts/123', 'https://sample.fanbox.cc/posts/0', 'https://sample.fanbox.cc/', 'https://localhost/posts/123']) assert.throws(() => parseFanboxUrl(input));
  for (const input of ['http://downloads.fanbox.cc/a.jpg', 'https://downloads.fanbox.cc.evil/a.jpg', 'https://127.0.0.1/a.jpg', 'https://downloads.fanbox.cc/a.zip', 'https://downloads.fanbox.cc/a.svg', 'https://downloads.fanbox.cc/a.ugoira', 'https://user@downloads.fanbox.cc/a.png']) assert.throws(() => validateFanboxMediaUrl(input));
});

test('filters supported media in article order without prose, archives, cover or external embeds', () => {
  const parsed = extractFanboxPost(article(), '123');
  assert.deepEqual(parsed.media.map(item => item.url), [videoUrl, imageUrl]);
  assert.equal(parsed.skippedCount, 3);
  assert.equal(JSON.stringify(parsed).includes('Private prose'), false);
  assert.equal(parsed.media[0].extension, '.mp4', 'the URL determines type, not an untrusted attachment name');
  assert.deepEqual(extractFanboxPost(post({ images: [{ originalUrl: imageUrl }, { originalUrl: imageUrl }] }, 'image'), '123').media.map(item => item.url), [imageUrl]);
  assert.equal(extractFanboxPost(post({ files: [{ url: videoUrl }] }, 'file'), '123').media[0].category, 'video');
  assert.equal(extractFanboxPost(post({ text: 'only prose' }, 'text'), '123').media.length, 0);
  assert.equal(extractFanboxPost(post({ video: { serviceProvider: 'youtube', videoId: 'sample' } }, 'video'), '123').media.length, 0);
  assert.equal(extractFanboxPost(post({ html: `<a href="${imageUrl}">image</a><a href="${cdn}/a.zip">zip</a>` }, 'image'), '123').media.length, 1);
  assert.throws(() => extractFanboxPost(post(null), '123'), /不可访问/);
  assert.throws(() => extractFanboxPost({ ...article(), isRestricted: true }, '123'), /不可访问/);
  assert.throws(() => extractFanboxPost(post({ blocks: [{ type: 'image', imageId: 'missing' }] }), '123'), /不完整/);
  assert.throws(() => extractFanboxPost(post({ images: [{ originalUrl: 'https://localhost/a.png' }] }, 'image'), '123'), /不支持/);
});

test('recovers a partial download, prunes stale files and verifies the final image/video pack', async () => {
  const { agent, client } = agentClient();
  const image = await sharp({ create: { width: 4, height: 4, channels: 3, background: '#336699' } }).png().toBuffer();
  const video = Buffer.from('synthetic-video-fixture');
  const pack = createPack({ name: 'Initial', originalFilename: 'https://sample.fanbox.cc/posts/123', originalSize: 0, originalFormat: 'fanbox', sourceType: 'folder' });
  try {
    mockPost(agent);
    agent.get(cdn).intercept({ path: '/files/post/clip.mp4' }).reply(200, video, { headers: { 'content-type': 'video/mp4' } });
    agent.get(cdn).intercept({ path: '/images/post/sample.png' }).reply(503, 'private error data');
    await assert.rejects(importFanboxPack(pack.id, () => {}, client), /503/);
    assert.equal(getPack(pack.id)?.videoCount, 0);
    assert.deepEqual(fs.readdirSync(getExtractedVideosDir(pack.id)), ['123_001.mp4']);
    fs.writeFileSync(path.join(getExtractedImagesDir(pack.id), 'stale.jpg'), 'old');
    mockPost(agent);
    agent.get(cdn).intercept({ path: '/files/post/clip.mp4' }).reply(200, video, { headers: { 'content-type': 'application/octet-stream' } });
    agent.get(cdn).intercept({ path: '/images/post/sample.png' }).reply(200, image, { headers: { 'content-type': 'image/png' } });
    const progress: number[] = [];
    await importFanboxPack(pack.id, completed => progress.push(completed), client);
    assert.deepEqual(progress, [0, 1, 2]);
    assert.deepEqual(fs.readdirSync(getExtractedImagesDir(pack.id)), ['123_002.png']);
    const imported = getPack(pack.id)!;
    assert.equal(imported.name, 'Sample post');
    assert.deepEqual(imported.tags.map(tag => tag.name), ['Sample author']);
    assert.equal(imported.imageCount, 1); assert.equal(imported.videoCount, 1);
    assert.equal(imported.totalImagesSize, image.length); assert.equal(imported.totalVideosSize, video.length);
    assert.equal(imported.originalSize, image.length + video.length);
    assert.equal(imported.status, 'verifying');
    await verifyPack(pack.id, new AbortController().signal, () => {});
    assert.equal(getPack(pack.id)?.status, 'thumbnailing');
    agent.assertNoPendingInterceptors();
  } finally { await agent.close(); }
});

test('preserves explicitly selected title/tags and fails empty imports without publishing a pack', async () => {
  const { agent, client } = agentClient();
  const pack = createPack({ name: 'Manual', originalFilename: 'https://sample.fanbox.cc/posts/123', originalSize: 0, originalFormat: 'fanbox', sourceType: 'folder' });
  const job = createJob(pack.id, 'fanbox');
  getDb().prepare('UPDATE jobs SET options = ? WHERE id = ?').run(JSON.stringify({ autoName: false, autoTags: false }), job.id);
  try {
    mockPost(agent, post({ files: [{ url: videoUrl }] }, 'file'));
    agent.get(cdn).intercept({ path: '/files/post/clip.mp4' }).reply(200, 'synthetic video', { headers: { 'content-type': 'video/mp4' } });
    await importFanboxPack(pack.id, () => {}, client);
    assert.equal(getPack(pack.id)?.name, 'Manual');
    assert.deepEqual(getPack(pack.id)?.tags, []);
    mockPost(agent, post({ text: 'ignore' }, 'text'));
    await assert.rejects(importFanboxPack(pack.id, () => {}, client), /没有可导入/);
  } finally { await agent.close(); }
});

test('rejects redirects, oversized streams, invalid media and cancellation without publishing partial files', async () => {
  const { agent, client } = agentClient();
  const destination = path.join(dataDir, 'download.png');
  const media = { url: imageUrl, extension: '.png', category: 'image' as const };
  try {
    agent.get(api).intercept({ path: '/post.info?postId=123' }).reply(302, '', { headers: { location: 'https://localhost/' } });
    await assert.rejects(client.post('123'), /302/);
    agent.get(api).intercept({ path: '/post.info?postId=123' }).reply(403, { error: 'must not expose this' }, { headers });
    await assert.rejects(client.post('123'), /不可访问/);
    agent.get(api).intercept({ path: '/post.info?postId=123' }).reply(200, '<html>login</html>', { headers: { 'content-type': 'text/html' } });
    await assert.rejects(client.post('123'), /拦截了服务器请求/);
    for (const mime of ['text/html', 'application/zip']) {
      agent.get(cdn).intercept({ path: '/images/post/sample.png' }).reply(200, 'unexpected', { headers: { 'content-type': mime } });
      await assert.rejects(client.download(media, destination, 1000), /类型/);
    }
    agent.get(cdn).intercept({ path: '/images/post/sample.png' }).reply(200, Buffer.alloc(20), { headers: { 'content-type': 'image/png' } });
    await assert.rejects(client.download(media, destination, 10), /大小限制/);
    agent.get(cdn).intercept({ path: '/images/post/sample.png' }).reply(200, 'invalid image', { headers: { 'content-type': 'image/png' } });
    await assert.rejects(client.download(media, destination, 1000), /无效的图片/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(client.download(media, destination, 1000, controller.signal), { name: 'AbortError' });
    assert.equal(fs.existsSync(destination), false); assert.equal(fs.existsSync(`${destination}.part`), false);
    agent.assertNoPendingInterceptors();
  } finally { await agent.close(); }
});

test('authentication failure stops an import at metadata before requesting any resource', async t => {
  const { agent, client } = agentClient();
  const pack = createPack({ name: 'Login required', originalFilename: 'https://sample.fanbox.cc/posts/123', originalSize: 0, originalFormat: 'fanbox', sourceType: 'folder' });
  const download = t.mock.method(client, 'download', async () => { throw new Error('must not download'); });
  try {
    agent.get(api).intercept({ path: '/post.info?postId=123' }).reply(401, 'synthetic authentication failure');
    await assert.rejects(importFanboxPack(pack.id, () => {}, client), /^Error: FANBOX 帖子不可访问$/);
    assert.equal(download.mock.callCount(), 0);
    assert.equal(getPack(pack.id)?.originalSize, 0);
    agent.assertNoPendingInterceptors();
  } finally { await agent.close(); }
});

test('HTML access blocks are distinct from API authentication failures and stop before downloads', async t => {
  const { agent, client } = agentClient();
  const pack = createPack({ name: 'Blocked request', originalFilename: 'https://sample.fanbox.cc/posts/123', originalSize: 0, originalFormat: 'fanbox', sourceType: 'folder' });
  const download = t.mock.method(client, 'download', async () => { throw new Error('must not download'); });
  try {
    agent.get(api).intercept({ path: '/post.info?postId=123' }).reply(403, '<html>private upstream diagnostic</html>', { headers: { 'content-type': 'text/html' } });
    await assert.rejects(importFanboxPack(pack.id, () => {}, client), { message: 'FANBOX 拦截了服务器请求，请稍后重试' });
    assert.equal(download.mock.callCount(), 0);
    assert.equal(getPack(pack.id)?.originalSize, 0);
    agent.assertNoPendingInterceptors();
  } finally { await agent.close(); }
});

test('credentials are re-read and limited to FANBOX hosts; only API responses rotate them', async () => {
  const agent = new MockAgent(); agent.disableNetConnect();
  let sessionId = 'first-session';
  const rotations: string[][] = [];
  const client = new FanboxClient(agent, () => ({ sessionId, source: 'settings' }), (_previous, cookies) => { rotations.push(cookies); });
  try {
    agent.get(api).intercept({ path: '/post.info?postId=123', headers: { cookie: 'FANBOXSESSID=first-session' } }).reply(200, { body: article() }, { headers: { ...headers, 'set-cookie': 'FANBOXSESSID=rotated; Path=/' } });
    await client.post('123'); sessionId = 'second-session';
    agent.get(cdn).intercept({ path: '/files/post/clip.mp4', headers: { cookie: 'FANBOXSESSID=second-session' } }).reply(200, 'video', { headers: { 'content-type': 'video/mp4', 'set-cookie': 'FANBOXSESSID=untrusted' } });
    await client.download({ url: videoUrl, category: 'video', extension: '.mp4' }, path.join(dataDir, 'video.mp4'), 100);
    agent.get('https://fanbox.pixiv.net').intercept({ path: '/legacy.mp4', headers: values => !values.cookie }).reply(200, 'video', { headers: { 'content-type': 'video/mp4' } });
    await client.download({ url: 'https://fanbox.pixiv.net/legacy.mp4', category: 'video', extension: '.mp4' }, path.join(dataDir, 'legacy.mp4'), 100);
    assert.equal(rotations.length, 1); agent.assertNoPendingInterceptors();
  } finally { await agent.close(); }
});

test('supports the current body.post envelope and block-based posts without legacy user/type fields', async () => {
  const { agent, client } = agentClient();
  try {
    const current = { ...article(), type: undefined, user: undefined };
    agent.get(api).intercept({ path: '/post.info?postId=123' }).reply(200, { body: { post: current } }, { headers });
    const parsed = await client.post('123');
    assert.equal(parsed.author, 'sample');
    assert.deepEqual(parsed.media.map(item => item.url), [videoUrl, imageUrl]);
    agent.get(api).intercept({ path: '/post.info?postId=123' }).reply(200, { body: { post: null } }, { headers });
    await assert.rejects(client.post('123'), /不可访问/);
    agent.assertNoPendingInterceptors();
  } finally { await agent.close(); }
});

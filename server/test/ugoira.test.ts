import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { ZipArchive } from 'archiver';
import sharp from 'sharp';
import { MockAgent } from 'undici';
import Fastify from 'fastify';
import type { UgoiraManifest } from '~/types';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-ugoira-'));
process.env.DATA_DIR = dataDir;
process.env.PIXIV_REFRESH_TOKEN = '';
process.env.AUTH_KEY = 'ugoira-test-key';
const { registerAuth } = await import('~/services/auth');
const { createUgoira, readUgoiraManifest, readUgoiraFrame, ugoiraFramesSchema } = await import('~/services/ugoira');
const { PixivClient, importPixivPack } = await import('~/services/pixiv-importer');
const { initDb, closeDb } = await import('~/db/connection');
const { createPack, getPack } = await import('~/db/repositories');
const { getExtractedImagesDir } = await import('~/services/storage');
const { thumbnailGenerator } = await import('~/services/thumbnail-generator');
const { imageCompressor } = await import('~/services/image-compressor');
const { archiveGenerator } = await import('~/services/archive-generator');
const { registerPackRoutes } = await import('~/routes/packs');
const { computeContentFingerprint } = await import('~/services/content-verification');
const { DEFAULT_COMPRESSION_OPTIONS } = await import('~/types');
await initDb();
test.after(() => { closeDb(); fs.rmSync(dataDir, { recursive: true, force: true }); });
const frames: UgoiraManifest['frames'] = [{ file: '000000.png', delay: 125 }, { file: '000001.png', delay: 250 }];

async function zip(filename: string, files: Array<[string, Buffer]>) {
  const archive = new ZipArchive(); const output = fs.createWriteStream(filename);
  const closed = once(output, 'close'); archive.pipe(output);
  for (const [name, buffer] of files) archive.append(buffer, { name });
  await archive.finalize(); await closed;
}

test('ugoira imports as one timed media file; previews, frame API, selection compression and download preserve animation', async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#6688aa' } }).png().toBuffer();
  const source = path.join(dataDir, 'source.zip'); await zip(source, frames.map(frame => [frame.file, png]));
  const pack = createPack({ name: 'Pixiv 123', sourceType: 'folder', originalFormat: 'pixiv', originalSize: 0, originalFilename: 'https://www.pixiv.net/artworks/123' });
  const agent = new MockAgent(); agent.disableNetConnect();
  try {
    agent.get('https://www.pixiv.net').intercept({ path: '/ajax/illust/123' }).reply(200, { error: false, body: { title: 'Animation', userName: 'Animator', illustType: 2, pageCount: 1 } });
    agent.get('https://www.pixiv.net').intercept({ path: '/ajax/illust/123/ugoira_meta' }).reply(200, { error: false, body: { originalSrc: 'https://i.pximg.net/img-zip-ugoira/test.zip', frames } });
    agent.get('https://i.pximg.net').intercept({ path: '/img-zip-ugoira/test.zip' }).reply(200, fs.readFileSync(source), { headers: { 'content-type': 'application/zip' } });
    await importPixivPack(pack.id, () => {}, new PixivClient(agent));
    const file = path.join(getExtractedImagesDir(pack.id), '123.ugoira');
    assert.equal(getPack(pack.id)?.imageCount, 1);
    assert.equal(getPack(pack.id)?.name, 'Animation');
    assert.deepEqual((await readUgoiraManifest(file)).frames, frames);
    assert.deepEqual(await readUgoiraFrame(file, 1), png);
    assert.ok(Object.keys(await thumbnailGenerator.generateAll(pack.id)).length);
    const app = Fastify(); registerAuth(app); await app.register(registerPackRoutes);
    try {
      const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { key: 'ugoira-test-key' } });
      const token = login.json().token;
      const thumbnails = (await app.inject({ url: `/api/packs/${pack.id}/thumbnails`, headers: { authorization: `Bearer ${token}` } })).json();
      assert.equal(thumbnails.length, 1); assert.equal(thumbnails[0].mediaType, 'ugoira');
      const resource = `${thumbnails[0].ugoiraUrl}?access_token=${token}`;
      assert.equal((await app.inject(thumbnails[0].ugoiraUrl)).statusCode, 401);
      assert.deepEqual((await app.inject(resource)).json().frames, frames);
      const response = await app.inject(`${resource}&frame=1`);
      assert.equal(response.statusCode, 200); assert.deepEqual(response.rawPayload, png);
      assert.equal((await app.inject(`${resource}&frame=9`)).statusCode, 404);
      assert.equal((await app.inject(`${thumbnails[0].imageUrl}?access_token=${token}`)).statusCode, 200);
      assert.deepEqual((await app.inject(`${resource}&download=1`)).rawPayload, fs.readFileSync(file));
    } finally { await app.close(); }
    await imageCompressor.compressPack(pack.id, DEFAULT_COMPRESSION_OPTIONS, undefined, { images: ['123.ugoira'], videos: [] });
    const compressedCopy = path.join(dataDir, 'generated', pack.id, 'temp', '123.ugoira');
    assert.deepEqual(fs.readFileSync(compressedCopy), fs.readFileSync(file));
    assert.ok(fs.existsSync(await archiveGenerator.generate(pack.id, DEFAULT_COMPRESSION_OPTIONS)));
    const before = (await computeContentFingerprint(pack.id)).fingerprint;
    await createUgoira(source, file, frames.map(frame => ({ ...frame, delay: 300 })));
    assert.notEqual((await computeContentFingerprint(pack.id)).fingerprint, before);
  } finally { await agent.close(); }
});

test('ugoira rejects unsafe names, missing frames, invalid images and excessive decompression; no partial publish', async () => {
  assert.equal(ugoiraFramesSchema.safeParse([{ file: '../x.png', delay: 100 }]).success, false);
  assert.equal(ugoiraFramesSchema.safeParse([{ file: 'x.png', delay: 0 }]).success, false);
  assert.equal(ugoiraFramesSchema.safeParse([frames[0], frames[0]]).success, false);
  const source = path.join(dataDir, 'bad.zip'); const destination = path.join(dataDir, 'bad.ugoira');
  await zip(source, [['000000.png', Buffer.from('invalid image')]]);
  await assert.rejects(createUgoira(source, destination, frames));
  assert.equal(fs.existsSync(destination), false); assert.equal(fs.existsSync(destination + '.part'), false);
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#6688aa' } }).png().toBuffer();
  await zip(source, [['000000.png', png]]);
  await assert.rejects(createUgoira(source, destination, frames), /帧缺失/);
  assert.equal(fs.existsSync(destination), false);
  await zip(source, [['000000.png', Buffer.alloc(33 * 1024 * 1024)]]);
  await assert.rejects(createUgoira(source, destination, frames), /大小限制/);
  assert.equal(fs.existsSync(destination), false);
});

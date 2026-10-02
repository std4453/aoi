import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MockAgent } from 'undici';
import Fastify from 'fastify';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-pixiv-auth-'));
process.env.DATA_DIR = dataDir;
process.env.PIXIV_REFRESH_TOKEN = '';
const { PixivClient, getPixivClient } = await import('../src/services/pixiv-importer.js');
const { readPixivSettings } = await import('../src/services/pixiv-auth.js');
const { registerPixivRoutes } = await import('../src/routes/pixiv.js');
const { initDb, closeDb } = await import('../src/db/connection.js');
const { listTags, getPack, updateJobStatus, getLatestJob } = await import('../src/db/repositories.js');
const { jobQueue } = await import('../src/services/job-queue.js');
await initDb();
test.after(() => { closeDb(); fs.rmSync(dataDir, { recursive: true, force: true }); });

const work = { illust: { title: 'Title', user: { name: 'Author' }, type: 'illust', page_count: 1,
  tags: [{ name: 'favorite' }], meta_single_page: { original_image_url: 'https://i.pximg.net/image.png' }, meta_pages: [] } };

test('refresh tokens authenticate the app API, coalesce refreshes and renew on 401 without leaking to CDN', async () => {
  const agent = new MockAgent(); agent.disableNetConnect();
  const client = new PixivClient(agent, 'cookie=private', 'refresh-private');
  try {
    agent.get('https://oauth.secure.pixiv.net').intercept({ path: '/auth/token', method: 'POST', body: body => String(body).includes('refresh_token=refresh-private') })
      .reply(200, { response: { access_token: 'access-one', expires_in: 3600 } });
    agent.get('https://app-api.pixiv.net').intercept({ path: '/v1/illust/detail?illust_id=123', headers: headers => headers.authorization === 'Bearer access-one' && !headers.cookie })
      .reply(200, work).times(2);
    const descriptions = await Promise.all([client.describe('123'), client.describe('123')]);
    assert.equal(descriptions[0].metadata.userName, 'Author');
    assert.deepEqual(descriptions[1].tagNames, ['favorite']);
    agent.get('https://app-api.pixiv.net').intercept({ path: '/v1/illust/detail?illust_id=123' }).reply(401, 'expired');
    agent.get('https://oauth.secure.pixiv.net').intercept({ path: '/auth/token', method: 'POST' }).reply(200, { response: { access_token: 'access-two', expires_in: 3600 } });
    agent.get('https://app-api.pixiv.net').intercept({ path: '/v1/illust/detail?illust_id=123', headers: headers => headers.authorization === 'Bearer access-two' }).reply(200, work);
    assert.equal((await client.artwork('123')).pages.length, 1);
    agent.get('https://app-api.pixiv.net').intercept({ path: '/v1/illust/detail?illust_id=123' }).reply(200, {
      illust: { ...work.illust, type: 'ugoira', meta_single_page: {}, meta_pages: [] },
    });
    agent.get('https://app-api.pixiv.net').intercept({ path: '/v1/ugoira/metadata?illust_id=123' }).reply(200, {
      ugoira_metadata: { zip_urls: { medium: 'https://i.pximg.net/img-zip-ugoira/123_ugoira600x600.zip' }, frames: [{ file: '000000.jpg', delay: 125 }] },
    });
    assert.equal((await client.artwork('123')).ugoira?.zipUrl, 'https://i.pximg.net/img-zip-ugoira/123_ugoira1920x1080.zip');
    agent.get('https://i.pximg.net').intercept({ path: '/image.png', headers: headers => !headers.authorization && !headers.cookie }).reply(403, 'denied');
    await assert.rejects(client.download('https://i.pximg.net/image.png', path.join(dataDir, 'never.png'), 1000), /拒绝访问/);
    agent.assertNoPendingInterceptors();
  } finally { await agent.close(); }
});

test('token errors never echo upstream credentials and never downgrade to anonymous', async () => {
  const agent = new MockAgent(); agent.disableNetConnect();
  try {
    agent.get('https://oauth.secure.pixiv.net').intercept({ path: '/auth/token', method: 'POST' }).reply(400, { error: 'refresh-private' });
    await assert.rejects(new PixivClient(agent, '', 'refresh-private').describe('123'), error => {
      assert.match(String(error), /登录失败/); assert.doesNotMatch(String(error), /refresh-private/); return true;
    });
  } finally { await agent.close(); }
});

test('settings persist privately, never return the token, and metadata creates reusable author and work tags', async t => {
  t.mock.method(jobQueue, 'start', () => {});
  const app = Fastify(); await app.register(registerPixivRoutes);
  try {
    assert.deepEqual((await app.inject('/api/settings/pixiv')).json(), { configured: false, source: 'none' });
    const saved = await app.inject({ method: 'PUT', url: '/api/settings/pixiv', payload: { refreshToken: 'test-secret' } });
    assert.equal(saved.json().configured, true);
    assert.ok(!saved.body.includes('test-secret'));
    assert.equal(readPixivSettings().refreshToken, 'test-secret');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dataDir, 'pixiv-settings.json')).mode & 0o777, 0o600);
    const invalid = await app.inject({ method: 'PUT', url: '/api/settings/pixiv', payload: { refreshToken: 'invalid secret' } });
    assert.equal(invalid.statusCode, 400); assert.ok(!invalid.body.includes('invalid secret'));
    await app.inject({ method: 'PUT', url: '/api/settings/pixiv', payload: { refreshToken: '' } });
    assert.equal(readPixivSettings().refreshToken, '');
    t.mock.method(getPixivClient(), 'describe', async () => ({ metadata: { title: 'Title', userName: 'Author', illustType: 0, pageCount: 1 }, tagNames: ['favorite', 'favorite'], pages: undefined }));
    const metadata = await app.inject({ method: 'POST', url: '/api/packs/pixiv-metadata', payload: { url: 'https://www.pixiv.net/artworks/123' } });
    assert.equal(metadata.statusCode, 200);
    assert.deepEqual(metadata.json().tags.map((tag: { name: string }) => tag.name), ['Author', 'favorite']);
    await app.inject({ method: 'POST', url: '/api/packs/pixiv-metadata', payload: { url: 'https://www.pixiv.net/artworks/123' } });
    assert.equal(listTags().length, 2); // Tags survive closing the form without an import.
    const immediate = (await app.inject({ method: 'POST', url: '/api/packs/pixiv-import', payload: { url: 'https://www.pixiv.net/artworks/123' } })).json();
    assert.deepEqual(JSON.parse(getLatestJob(immediate.id, 'pixiv')!.options!), { autoName: true, autoTags: true });
    updateJobStatus(getLatestJob(immediate.id, 'pixiv')!.id, 'completed');
    const edited = (await app.inject({ method: 'POST', url: '/api/packs/pixiv-import', payload: { url: 'https://www.pixiv.net/artworks/123', packName: 'Edited', tagIds: [] } })).json();
    assert.deepEqual(JSON.parse(getLatestJob(edited.id, 'pixiv')!.options!), { autoName: false, autoTags: false });
    assert.equal(getPack(edited.id)?.name, 'Edited');
  } finally { await app.close(); }
});

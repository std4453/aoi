import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import { startTestServer, stopTestServer } from './helpers/server-process';

const require = createRequire(import.meta.url);
test('startup resumes a running FANBOX job through verification and previews using only mocked network', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-fanbox-startup-'));
  const preload = path.join(directory, 'network.mjs');
  const png = await sharp({ create: { width: 3, height: 3, channels: 3, background: '#456789' } }).png().toBuffer();
  fs.writeFileSync(preload, `import { MockAgent, setGlobalDispatcher } from ${JSON.stringify(pathToFileURL(require.resolve('undici')).href)};
const agent = new MockAgent(); agent.disableNetConnect(); setGlobalDispatcher(agent);
agent.get('https://api.fanbox.cc').intercept({path:'/post.info?postId=123'}).reply(200, {body:{
  id:'123', title:'Recovered post', creatorId:'sample', user:{name:'Fixture author'}, type:'image',
  body:{images:[{originalUrl:'https://downloads.fanbox.cc/image.png'}]}
}}, {headers:{'content-type':'application/json'}});
agent.get('https://downloads.fanbox.cc').intercept({path:'/image.png'}).reply(200, Buffer.from('${png.toString('base64')}','base64'), {headers:{'content-type':'image/png'}});
`);
  const environment = { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`, FANBOX_SESSION_ID: '', FANBOX_COOKIES_FILE: '', AOI_PROXY_URL: '', AOI_SNAPSHOT_ENABLED: 'false' };
  let server = await startTestServer(directory, true, environment);
  try {
    await stopTestServer(server);
    const db = new Database(path.join(directory, 'db', 'packdb.sqlite'));
    try {
      db.prepare(`INSERT INTO packs (id, name, original_filename, original_size, original_format, source_type)
        VALUES ('fanbox-recovery', 'Old title', 'https://sample.fanbox.cc/posts/123', 0, 'fanbox', 'folder')`).run();
      db.prepare(`INSERT INTO jobs (id, pack_id, type, status, options) VALUES
        ('fanbox-running', 'fanbox-recovery', 'fanbox', 'running', '{"autoName":true,"autoTags":true}')`).run();
    } finally { db.close(); }
    server = await startTestServer(directory, true, environment);
    let task: { source?: string; status?: string; name?: string; packId?: string } | undefined;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      task = ((await (await fetch(`${server.url}/api/upload-tasks`)).json()) as typeof task[]).find(item => item?.packId === 'fanbox-recovery');
      if (task?.status === 'completed' || task?.status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(task?.source, 'fanbox');
    assert.equal(task?.status, 'completed', server.output());
    assert.equal(task?.name, 'Recovered post');
    const dbAfter = new Database(path.join(directory, 'db', 'packdb.sqlite'), { readonly: true });
    try {
      const jobs = dbAfter.prepare('SELECT type, status FROM jobs WHERE pack_id = ? ORDER BY rowid').all('fanbox-recovery');
      assert.deepEqual(jobs, [{ type: 'fanbox', status: 'completed' }, { type: 'verify', status: 'completed' }, { type: 'thumbnail', status: 'completed' }]);
      assert.equal((dbAfter.prepare('SELECT count(*) AS n FROM upload_tasks').get() as { n: number }).n, 1);
    } finally { dbAfter.close(); }
  } finally { await stopTestServer(server); fs.rmSync(directory, { recursive: true, force: true }); }
});

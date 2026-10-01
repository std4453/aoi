// Run against an isolated primary/replica pair (never production).
// Requires npm --prefix server ci. Optional AOI_PLAYWRIGHT_MODULE enables UI checks.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
const require = createRequire(new URL('../server/package.json', import.meta.url));
const sharp = require('sharp');
const { ZipArchive } = require('archiver');
const primary = process.env.AOI_TEST_PRIMARY || 'http://127.0.0.1:19301';
const replica = process.env.AOI_TEST_REPLICA || 'http://127.0.0.1:19302';
const frontend = process.env.AOI_TEST_FRONTEND || 'http://127.0.0.1:19303';
async function json(url, init) {
  const response = await fetch(url, init);
  assert.ok(response.ok, `${url}: ${response.status} ${await response.clone().text()}`);
  return response.json();
}
async function wait(check, label) {
  const until = Date.now() + 90_000;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out: ${label}`);
}
const send = (method, body) => ({ method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const png = await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 80, g: 140, b: Math.floor(Math.random() * 255) } } }).png().toBuffer();
const output = new PassThrough();
const chunks = [];
output.on('data', chunk => chunks.push(chunk));
const zip = new ZipArchive();
zip.pipe(output);
zip.append(png, { name: 'test-image.png' });
const finished = once(output, 'end');
await zip.finalize(); await finished;
const archive = Buffer.concat(chunks);
const upload = await fetch(`${primary}/api/upload/files`, { method: 'POST', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(archive.length) } });
assert.equal(upload.status, 201);
const uploadUrl = new URL(upload.headers.get('location'), primary);
assert.equal((await fetch(uploadUrl, { method: 'PATCH', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: archive })).status, 204);
const pack = await json(`${primary}/api/packs/upload-complete`, send('POST', {
  uploadId: uploadUrl.pathname.split('/').pop(), filename: 'replication-test.zip', fileSize: archive.length, packName: '主备同步测试图包', allowDuplicate: true,
}));
await wait(async () => (await json(`${primary}/api/packs/${pack.id}`)).status === 'extracted', 'extract and verify');
const thumbnails = await json(`${primary}/api/packs/${pack.id}/thumbnails`);
assert.equal(thumbnails.length, 1);
assert.equal((await fetch(primary + thumbnails[0].imageUrl)).status, 200);
await json(`${primary}/api/packs/${pack.id}/process`, send('POST', { options: { format: 'jpeg', quality: 80, keepVideos: true, scaleImages: true, maxDimension: 1920 } }));
await wait(async () => (await json(`${primary}/api/packs/${pack.id}`)).status === 'generated', 'generate');
await wait(async () => {
  const response = await fetch(`${replica}/api/packs/${pack.id}`);
  return response.ok && (await response.json()).status === 'generated';
}, 'replicate generated pack');
const primaryBytes = Buffer.from(await (await fetch(`${primary}/api/packs/${pack.id}/download`)).arrayBuffer());
const replicaBytes = Buffer.from(await (await fetch(`${replica}/api/packs/${pack.id}/download`)).arrayBuffer());
assert.deepEqual(primaryBytes, replicaBytes);
assert.equal(primaryBytes.subarray(0, 2).toString(), 'PK');
assert.equal((await fetch(replica + thumbnails[0].thumbUrl)).status, 200);
assert.equal((await fetch(replica + thumbnails[0].imageUrl)).status, 200);
assert.equal((await fetch(`${replica}/api/packs/${pack.id}`, send('PATCH', { name: 'must-fail' }))).status, 403);
assert.equal((await fetch(`${replica}/api/upload/files`, { method: 'POST' })).status, 403);
await json(`${primary}/api/packs/${pack.id}`, send('PATCH', { name: '已同步 · 只读副本' }));
await wait(async () => (await json(`${replica}/api/packs/${pack.id}`)).name === '已同步 · 只读副本', 'metadata increment');
assert.equal((await json(`${primary}/api/system/replication`)).uploadedBlobs, 0);

if (process.env.AOI_PLAYWRIGHT_MODULE) {
  const { chromium } = await import(process.env.AOI_PLAYWRIGHT_MODULE);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1100, height: 1100 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    // Both same-origin and standalone frontends derive capabilities from the backend.
    for (const origin of [replica, frontend]) {
      await page.goto(origin);
      await page.evaluate(({ address, primaryAddress, separate }) => {
        const record = { id: separate ? 'test-replica' : 'same-origin', alias: '只读备服务器', address, key: '' };
        localStorage.setItem('aoi.servers.v1', JSON.stringify(separate ? [{ id: 'test-primary', alias: '主服务器', address: primaryAddress, key: '', writable: false }, record] : [record]));
        localStorage.setItem('aoi.activeServer', record.id);
        sessionStorage.clear();
      }, { address: replica, primaryAddress: primary, separate: origin === frontend });
      await page.goto(`${origin}/packs/${pack.id}`);
      assert.equal(await page.getByText('只读备服务器 · 可浏览和下载，内容随同步更新').count(), 0);
      await page.getByRole('heading', { name: '已同步 · 只读副本' }).waitFor();
      assert.equal(await page.getByRole('button', { name: /生成压缩包|重新生成/ }).first().isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: /下载/ }).first().isEnabled(), true);
      assert.equal(await page.locator('nav a[href="/upload"]').getAttribute('aria-disabled'), 'true');
      if (process.env.AOI_SCREENSHOT_DIR) {
        fs.mkdirSync(process.env.AOI_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.AOI_SCREENSHOT_DIR, origin === replica ? 'replica-detail.png' : 'standalone-replica-detail.png'), fullPage: true });
      }
      await page.goto(`${origin}/settings`);
      await page.getByRole('button', { name: /服务器.*（只读）/ }).waitFor();
      if (process.env.AOI_SCREENSHOT_DIR) {
        await page.screenshot({ path: path.join(process.env.AOI_SCREENSHOT_DIR, origin === replica ? 'replica-settings.png' : 'standalone-replica-settings.png'), fullPage: true });
      }
      if (origin === frontend) {
        await page.getByRole('button', { name: /服务器.*（只读）/ }).click();
        await page.getByRole('heading', { name: '切换服务器' }).waitFor();
        const serverButton = page.getByRole('button', { name: /只读备服务器.*（只读）/ });
        await serverButton.waitFor();
        assert.equal(await serverButton.locator('.font-medium').textContent(), '只读备服务器');
        assert.equal(await serverButton.locator('.text-xs').textContent(), `${replica}（只读）`);
        await page.getByRole('button', { name: `主服务器 ${primary}`, exact: true }).waitFor();
        if (process.env.AOI_SCREENSHOT_DIR) {
          await page.screenshot({ path: path.join(process.env.AOI_SCREENSHOT_DIR, 'server-list.png'), fullPage: true });
        }
        await serverButton.click();
      }
      await page.goto(`${origin}/settings/presets`);
      await page.getByRole('button', { name: /新建|新增|添加/ }).first().waitFor();
      assert.equal(await page.getByRole('button', { name: /新建|新增|添加/ }).first().isDisabled(), true);
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}
const health = await json(`${primary}/api/health`);
assert.equal((await json(`${replica}/api/health`)).build, health.build);
console.log(JSON.stringify({ result: 'passed', packId: pack.id, bytes: replicaBytes.length, build: health.build, checks: ['upload', 'extract', 'preview', 'generate', 'download', 'metadata-only zero new blobs', 'replica write rejection', ...(process.env.AOI_PLAYWRIGHT_MODULE ? ['same-origin UI', 'standalone UI'] : [])] }, null, 2));

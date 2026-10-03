import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { UploadTask, Pack } from '../../shared/types.js';
import { corpus, fixtureBytes, sha256, verifyRarCorpus } from '../../scripts/check-rar.mjs';
import { startTestServer, stopTestServer } from './helpers/server-process.js';
import { taskErrorMessage } from '../../client/src/features/uploads/task-display.ts';

test('installed 7z decodes the pinned RAR4/RAR5 corpus byte for byte', () => {
  verifyRarCorpus();
});

test('RAR upload, preview, generation, password retry and cancellation baseline', { timeout: 90_000 }, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-rar-api-'));
  let server = await startTestServer(directory);
  const request = (url: string, method = 'GET', body?: unknown) => fetch(`${server.url}${url}`, {
    method, ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  });
  async function json<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await request(url, method, body);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<T>;
  }
  async function upload(name: string, bytes: Buffer): Promise<UploadTask> {
    const task = await json<UploadTask>('/api/upload-tasks', 'POST', { source: 'archive', name, filename: `${name}.rar`, fileSize: bytes.length });
    const created = await fetch(`${server.url}/api/upload/files`, { method: 'POST', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(bytes.length) } });
    assert.equal(created.status, 201);
    const url = new URL(created.headers.get('location')!, server.url);
    const patched = await fetch(url, { method: 'PATCH', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream' }, body: new Uint8Array(bytes) });
    assert.equal(patched.status, 204);
    return json<UploadTask>(`/api/upload-tasks/${task.id}/complete`, 'POST', { uploadId: url.pathname.split('/').pop() });
  }
  async function settled(id: string): Promise<UploadTask> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const task = await json<UploadTask>(`/api/upload-tasks/${id}`);
      if (['completed', 'password', 'failed', 'duplicate'].includes(task.status)) return task;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`RAR task did not settle: ${server.output()}`);
  }
  const fixture = (name: string) => corpus.cases.find((item: { name: string }) => item.name === name)!;
  try {
    for (const name of ['rar5-compressed', 'rar5-solid']) {
      await t.test(`${name}: upload, original bytes, preview and completion`, async () => {
        const sample = fixture(name);
        const task = await settled((await upload(name, fixtureBytes(sample))).id);
        assert.equal(task.status, 'completed', task.error ?? 'completion');
        const pack = await json<Pack>(`/api/packs/${task.packId}`);
        assert.equal(pack.imageCount, 3);
        const thumbs = await json<Array<{ imageUrl: string; thumbUrl: string }>>(`/api/packs/${task.packId}/thumbnails`);
        assert.equal(thumbs.length, 3);
        for (const thumb of thumbs) {
          const image = await fetch(`${server.url}${thumb.imageUrl}`);
          assert.equal(image.status, 200);
          assert.ok(Object.values(sample.files).includes(sha256(Buffer.from(await image.arrayBuffer()))));
          const preview = await fetch(`${server.url}${thumb.thumbUrl}`);
          assert.equal(preview.status, 200);
          assert.match(preview.headers.get('content-type')!, /image\/jpeg/);
        }
        if (name === 'rar5-compressed') {
          await json(`/api/packs/${task.packId}/process`, 'POST', {});
          const deadline = Date.now() + 15_000;
          let generated = await json<Pack>(`/api/packs/${task.packId}`);
          while (generated.status !== 'generated' && Date.now() < deadline) {
            assert.notEqual(generated.status, 'failed', generated.errorMessage ?? 'generation');
            await new Promise(resolve => setTimeout(resolve, 25));
            generated = await json<Pack>(`/api/packs/${task.packId}`);
          }
          assert.equal(generated.status, 'generated');
          const download = await fetch(`${server.url}/api/packs/${task.packId}/download`);
          assert.equal(download.status, 200);
          assert.equal(Buffer.from(await download.arrayBuffer()).subarray(0, 2).toString(), 'PK');
          const repeated = await upload('duplicate-rar', fixtureBytes(sample));
          assert.equal(repeated.status, 'duplicate');
          await json(`/api/upload-tasks/${repeated.id}`, 'DELETE');
        }
        await json(`/api/upload-tasks/${task.id}`, 'DELETE');
        assert.equal((await request(`/api/packs/${task.packId}`)).status, 200, 'acknowledgement preserves the pack');
      });
    }

    for (const name of ['rar5-password', 'rar5-header-password']) {
      await t.test(`${name}: no password, wrong password, restart and successful retry`, async () => {
        const sample = fixture(name);
        let task = await settled((await upload(name, fixtureBytes(sample))).id);
        assert.equal(task.status, 'password', task.error ?? 'password required');
        assert.equal(task.passwordKind, 'archive');
        assert.match(taskErrorMessage(task), /需要密码/);
        await json(`/api/upload-tasks/${task.id}/retry`, 'POST', { archivePassword: 'incorrect-fixture-password' });
        task = await settled(task.id);
        assert.equal(task.status, 'password');
        assert.match(taskErrorMessage(task), /密码不正确/);
        await stopTestServer(server);
        server = await startTestServer(directory);
        assert.equal((await json<UploadTask>(`/api/upload-tasks/${task.id}`)).status, 'password');
        await json(`/api/upload-tasks/${task.id}/retry`, 'POST', { archivePassword: sample.password });
        task = await settled(task.id);
        assert.equal(task.status, 'completed', task.error ?? 'retry completion');
        assert.equal((await json<Pack>(`/api/packs/${task.packId}`)).imageCount, 3);
        await json(`/api/upload-tasks/${task.id}`, 'DELETE');
      });
    }
    await t.test('damaged RAR fails without requesting credentials, then cancels cleanly', async () => {
      const bytes = fixtureBytes(fixture('rar5-compressed'));
      const task = await settled((await upload('damaged-rar', bytes.subarray(0, Math.floor(bytes.length / 2)))).id);
      assert.equal(task.status, 'failed', task.error ?? 'damaged archive');
      assert.doesNotMatch(taskErrorMessage(task), /需要密码|密码不正确|登录/);
      await json(`/api/upload-tasks/${task.id}`, 'DELETE');
      assert.equal((await request(`/api/packs/${task.packId}`)).status, 404);
      assert.equal(fs.existsSync(path.join(directory, 'extracted', task.packId!)), false);
      assert.equal(fs.existsSync(path.join(directory, 'archives', task.packId!)), false);
    });
    await t.test('canceling a password prompt removes its task and temporary data', async () => {
      const task = await settled((await upload('cancel-password', fixtureBytes(fixture('rar5-password')))).id);
      // Previously imported identical archives may first require duplicate confirmation.
      if (task.status === 'duplicate') await json(`/api/upload-tasks/${task.id}/continue`, 'POST', {});
      const waiting = await settled(task.id);
      assert.equal(waiting.status, 'password');
      await json(`/api/upload-tasks/${task.id}`, 'DELETE');
      assert.equal((await request(`/api/upload-tasks/${task.id}`)).status, 404);
      assert.equal((await request(`/api/packs/${waiting.packId}`)).status, 404);
    });
  } finally {
    await stopTestServer(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

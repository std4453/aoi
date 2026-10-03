import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import type { UploadTask } from '../../shared/types.js';
import { startTestServer, stopTestServer } from './helpers/server-process.js';

test('startup keeps failed MEGA journals retryable through ordinary pack recovery', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-mega-handoff-startup-'));
  let server = await startTestServer(directory);
  try {
    await stopTestServer(server);
    const db = new Database(path.join(directory, 'db', 'packdb.sqlite'));
    try {
      for (const sourceType of ['archive', 'folder']) {
        const id = `mega-${sourceType}`;
        db.prepare(`INSERT INTO packs (id, name, original_filename, original_size, original_format, source_type)
          VALUES (?, ?, 'fixture.zip', 3, ?, ?)`).run(id, id, sourceType === 'archive' ? 'zip' : 'folder', sourceType);
        const task: UploadTask = { id, source: 'mega', name: id, filename: 'fixture.zip', totalBytes: 3,
          transferredBytes: 3, progress: 0, status: 'failed', packId: id, uploadId: null, matches: [],
          error: 'handoff failed', createdAt: '', updatedAt: '',
        };
        db.prepare('INSERT INTO upload_tasks (id, task) VALUES (?, ?)').run(id, JSON.stringify(task));
        const root = path.join(directory, 'uploads', `mega-${id}`);
        fs.mkdirSync(root, { recursive: true });
        // No network is involved: fail again while reconstructing the saved
        // download, then repair it and exercise the real retry route.
        fs.writeFileSync(path.join(root, 'download.json'), '{invalid journal');
      }
    } finally {
      db.close();
    }
    server = await startTestServer(directory);
    for (const sourceType of ['archive', 'folder']) {
      const id = `mega-${sourceType}`;
      const task = await (await fetch(`${server.url}/api/upload-tasks/${id}`)).json() as UploadTask;
      assert.equal(task.status, 'failed', 'startup must preserve a failed MEGA handoff');
      assert.notEqual(task.error, '上传记录存在，但原始压缩包缺失');
      const db = new Database(path.join(directory, 'db', 'packdb.sqlite'), { readonly: true });
      try {
        assert.equal((db.prepare('SELECT status FROM packs WHERE id = ?').get(id) as { status: string }).status, 'uploading');
        assert.equal((db.prepare('SELECT count(*) AS count FROM jobs WHERE pack_id = ?').get(id) as { count: number }).count, 0);
      } finally {
        db.close();
      }
    }
    const id = 'mega-folder';
    const root = path.join(directory, 'uploads', `mega-${id}`);
    fs.mkdirSync(path.join(root, 'contents'), { recursive: true });
    fs.writeFileSync(path.join(root, 'download.json'), JSON.stringify({ kind: 'folder', name: 'Photos', totalBytes: 0, files: [] }));
    const response = await fetch(`${server.url}/api/upload-tasks/${id}/retry`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(fs.existsSync(root), false, 'the retry must finish and remove the repaired download journal');
    assert.equal((await response.json() as UploadTask).packId, id);
  } finally {
    await stopTestServer(server);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

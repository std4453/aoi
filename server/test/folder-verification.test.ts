import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import test from 'node:test';
import Database from 'better-sqlite3';
import { ZipArchive } from 'archiver';
import sharp from 'sharp';
import { startTestServer, stopTestServer } from './helpers/server-process';
import type { Pack, PackFile, FolderUploadStatus } from '~/types';

const png = () => sharp({ create: { width: 24, height: 24, channels: 3, background: '#3867d6' } }).png().toBuffer();

test('folder uploads verify against both sources and persist confirmation across restarts', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-folder-verification-'));
  let server = await startTestServer(dataDir);
  const database = new Database(path.join(dataDir, 'db', 'packdb.sqlite'));
  const image = await png();
  const request = (url: string, body?: unknown, method = 'POST') => fetch(server.url + url, {
    method, headers: method === 'DELETE' ? {} : { 'Content-Type': 'application/json' }, body: method === 'DELETE' ? undefined : JSON.stringify(body ?? {}),
  });
  const upload = async (bytes: Buffer) => {
    const response = await fetch(server.url + '/api/upload/files', {
      method: 'POST', headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(bytes.length) },
    });
    assert.equal(response.status, 201);
    const location = new URL(response.headers.get('location')!, server.url).toString();
    const sent = await fetch(location, { method: 'PATCH', headers: {
      'Tus-Resumable': '1.0.0', 'Upload-Offset': '0', 'Content-Type': 'application/offset+octet-stream',
    }, body: new Uint8Array(bytes) });
    assert.equal(sent.status, 204);
    return location.split('/').pop()!;
  };
  const waitFor = async (id: string, status: Pack['status']) => {
    for (let i = 0; i < 150; i++) {
      const pack = await (await fetch(`${server.url}/api/packs/${id}`)).json() as Pack;
      if (pack.status === status) return pack;
      if (pack.status === 'failed') throw new Error(pack.errorMessage || 'Failed');
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    throw new Error(`Timed out waiting for ${id}: ${status}\n${server.output()}`);
  };
  const createFolder = async (name: string) => {
    const files = [
      { relativePath: `${name}/sub/renamed.png`, fileSize: image.length },
      { relativePath: `${name}/readme.txt`, fileSize: 7 },
    ];
    const created = await request('/api/packs/folder-create', { packName: name, files });
    assert.equal(created.status, 200);
    const pack = await created.json() as { id: string; packFiles: PackFile[] };
    const uploads = await Promise.all([upload(image), upload(Buffer.from('ignored'))]);
    const confirmations = pack.packFiles.map((file, index) => ({ packFileId: file.id, uploadId: uploads[index] }));
    const completed = await Promise.all(confirmations.map(body => request(`/api/packs/${pack.id}/folder-file-complete`, body)));
    assert.ok(completed.every(response => response.status === 200));
    // Repeated last-file callbacks cannot move files twice or create extra tasks.
    assert.equal((await request(`/api/packs/${pack.id}/folder-file-complete`, confirmations[0])).status, 200);
    return pack.id;
  };
  try {
    const first = await createFolder('first');
    await waitFor(first, 'extracted');
    const verificationRow = (id: string) => database.prepare('SELECT * FROM pack_verifications WHERE pack_id = ?').get(id) as { matches: string; checked_at: string; approved: number; status: string };
    assert.equal(verificationRow(first).status, 'completed');
    assert.equal(verificationRow(first).matches, '[]');

    // A differently named archive containing the same image records a duplicate,
    // without waiting for content confirmation. Non-media files are ignored.
    const zipPath = path.join(dataDir, 'fixture.zip');
    const output = fs.createWriteStream(zipPath);
    const archive = new ZipArchive();
    archive.pipe(output);
    archive.append(image, { name: 'different.png' });
    archive.append('different readme', { name: 'notes.txt' });
    const closed = once(output, 'close');
    await archive.finalize(); await closed;
    const archiveBytes = fs.readFileSync(zipPath);
    const archiveResponse = await request('/api/packs/upload-complete', {
      uploadId: await upload(archiveBytes), filename: 'pack.zip', fileSize: archiveBytes.length, packName: 'archive',
    });
    assert.equal(archiveResponse.status, 200);
    const archived = await archiveResponse.json() as Pack;
    await waitFor(archived.id, 'extracted');
    assert.equal(JSON.parse(verificationRow(archived.id).matches)[0].id, first);
    assert.equal(verificationRow(first).matches, '[]');

    const duplicate = await createFolder('duplicate');
    await waitFor(duplicate, 'awaiting_confirmation');
    const snapshot = verificationRow(duplicate);
    assert.equal(JSON.parse(snapshot.matches).length, 2);
    const publicPack = await (await fetch(`${server.url}/api/packs/${duplicate}`)).json();
    assert.equal('matches' in publicPack, false);
    assert.equal('fingerprint' in publicPack, false);
    assert.equal((database.prepare("SELECT count(*) AS n FROM jobs WHERE pack_id = ? AND type = 'thumbnail'").get(duplicate) as { n: number }).n, 0);
    await stopTestServer(server);
    // Simulate interruption after publishing the result but before completing its job.
    database.prepare("UPDATE jobs SET status = 'running' WHERE pack_id = ? AND type = 'verify'").run(duplicate);
    server = await startTestServer(dataDir);
    await waitFor(duplicate, 'awaiting_confirmation');
    assert.equal(verificationRow(duplicate).matches, snapshot.matches);
    assert.equal(verificationRow(duplicate).checked_at, snapshot.checked_at);
    const resumed = await (await fetch(`${server.url}/api/packs/${duplicate}/folder-upload-status`)).json() as FolderUploadStatus;
    assert.equal(resumed.matches.length, 2);
    const continueResponses = await Promise.all([request(`/api/packs/${duplicate}/folder-continue`), request(`/api/packs/${duplicate}/folder-continue`)]);
    assert.ok(continueResponses.every(response => response.status === 200));
    await waitFor(duplicate, 'extracted');
    assert.equal(verificationRow(duplicate).matches, snapshot.matches);
    assert.equal((database.prepare("SELECT count(*) AS n FROM jobs WHERE pack_id = ? AND type = 'thumbnail'").get(duplicate) as { n: number }).n, 1);

    const cancel = await createFolder('cancel');
    await waitFor(cancel, 'awaiting_confirmation');
    assert.equal((await request(`/api/packs/${cancel}/cancel-upload`, undefined, 'DELETE')).status, 200);
    assert.equal((await request(`/api/packs/${cancel}/cancel-upload`, undefined, 'DELETE')).status, 200);
    assert.equal((await fetch(`${server.url}/api/packs/${cancel}`)).status, 404);
    assert.equal(fs.existsSync(path.join(dataDir, 'extracted', cancel)), false);
    for (const table of ['pack_files', 'pack_verifications', 'jobs', 'pack_tags']) {
      assert.equal((database.prepare(`SELECT count(*) AS n FROM ${table} WHERE pack_id = ?`).get(cancel) as { n: number }).n, 0);
    }

    const vanished = await createFolder('vanished');
    await waitFor(vanished, 'awaiting_confirmation');
    const vanishedSnapshot = verificationRow(vanished).matches;
    for (const id of [first, archived.id, duplicate]) {
      assert.equal((await request(`/api/packs/${id}`, undefined, 'DELETE')).status, 200);
    }
    const status = await (await fetch(`${server.url}/api/packs/${vanished}/folder-upload-status`)).json() as FolderUploadStatus;
    assert.equal(status.matches.length, 0);
    await waitFor(vanished, 'extracted');
    assert.equal(verificationRow(vanished).matches, vanishedSnapshot);
  } finally {
    database.close();
    await stopTestServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('upgrade and interrupted verification recover using extracted files without original archives', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-verification-upgrade-'));
  let server = await startTestServer(dataDir);
  await stopTestServer(server);
  const database = new Database(path.join(dataDir, 'db', 'packdb.sqlite'));
  try {
    const image = await png();
    database.prepare("DELETE FROM migrations WHERE name = '008_add_content_verification'").run();
    database.exec('DROP TABLE pack_verifications');
    database.prepare(`INSERT INTO packs (id, name, original_filename, original_size, original_format, status, source_type,
      image_count, total_images_size) VALUES ('historical', 'old', 'old.zip', ?, 'zip', 'generated', 'archive', 1, ?)`).run(image.length, image.length);
    const images = path.join(dataDir, 'extracted', 'historical', 'images');
    fs.mkdirSync(images, { recursive: true });
    fs.writeFileSync(path.join(images, 'old.png'), image);
    server = await startTestServer(dataDir);
    for (let i = 0; i < 100; i++) {
      const row = database.prepare("SELECT status FROM pack_verifications WHERE pack_id = 'historical'").get() as { status: string };
      if (row.status === 'completed') break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const before = database.prepare("SELECT * FROM pack_verifications WHERE pack_id = 'historical'").get() as { status: string; fingerprint: string; matches: string; checked_at: string };
    assert.equal(before.status, 'completed');
    assert.equal((await (await fetch(`${server.url}/api/packs/historical`)).json()).status, 'generated');
    assert.equal((await fetch(`${server.url}/api/packs/historical/images/old.png`)).status, 200);
    await stopTestServer(server);
    database.prepare("UPDATE packs SET status = 'verifying' WHERE id = 'historical'").run();
    database.prepare("UPDATE jobs SET status = 'running' WHERE pack_id = 'historical' AND type = 'verify'").run();
    server = await startTestServer(dataDir);
    for (let i = 0; i < 100; i++) {
      if ((await (await fetch(`${server.url}/api/packs/historical`)).json()).status === 'generated') break;
      await new Promise(resolve => setTimeout(resolve, 30));
    }
    const after = database.prepare("SELECT * FROM pack_verifications WHERE pack_id = 'historical'").get() as typeof before;
    assert.equal(after.fingerprint, before.fingerprint);
    assert.equal(after.checked_at, before.checked_at);
    assert.equal(after.matches, before.matches);
    assert.equal((await (await fetch(`${server.url}/api/packs/historical`)).json()).status, 'generated');
  } finally {
    database.close();
    await stopTestServer(server);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

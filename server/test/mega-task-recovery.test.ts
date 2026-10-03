import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('MEGA duplicate confirmation and archive/folder materialization recover from a durable download journal', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-mega-recovery-'));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  const { initDb, closeDb, getDb } = await import('../src/db/connection.js');
  const packs = await import('../src/db/repositories.js');
  const tasks = await import('../src/services/upload-tasks.js');
  const { startMegaImport, continueMegaImport, recoverMegaImports, shutdownMegaImports } = await import('../src/services/mega-import.js');
  const { jobQueue } = await import('../src/services/job-queue.js');
  const { getArchivePath, getFolderStagingDir } = await import('../src/services/storage.js');
  const previousEnqueue = jobQueue.enqueueUnique;
  const previousStart = jobQueue.start;
  // Test durable handoff in isolation; the ordinary queue/extractor has separate integration coverage.
  jobQueue.enqueueUnique = async (packId, type) => packs.createJob(packId, type);
  jobQueue.start = () => {};
  const contents = Buffer.from('downloaded fixture');
  const md5 = createHash('md5').update(contents).digest('hex');
  const createTask = (name: string) => tasks.createUploadTask({ source: 'mega', name,
    url: 'https://mega.nz/file/GRBSjBCI#W-PD47BgVmkIB9x_c5DFPilhYrtwk21hdwyppp-1pO8' });
  const journal = (id: string, kind: 'archive' | 'folder') => {
    const root = path.join(directory, 'uploads', `mega-${id}`);
    const file = kind === 'archive' ? 'fixture.zip' : 'nested/photo.jpg';
    fs.mkdirSync(path.dirname(path.join(root, 'contents', file)), { recursive: true });
    fs.writeFileSync(path.join(root, 'contents', file), contents);
    fs.writeFileSync(path.join(root, 'download.json'), JSON.stringify({ kind,
      name: kind === 'archive' ? file : 'Photos', totalBytes: contents.length,
      files: [{ relativePath: file, fileSize: contents.length }],
    }));
    return root;
  };
  try {
    await initDb();
    const original = packs.createPack({ name: 'original', originalFilename: 'fixture.zip', originalFormat: 'zip',
      originalSize: contents.length, archiveMd5: md5 });
    const duplicate = createTask('duplicate');
    const duplicateRoot = journal(duplicate.id, 'archive');
    await startMegaImport(duplicate.id, { ...tasks.getUploadTaskMetadata(duplicate.id), name: duplicate.name });
    assert.equal(tasks.getUploadTask(duplicate.id)?.status, 'duplicate');
    assert.deepEqual(tasks.getUploadTask(duplicate.id)?.matches.map(match => match.id), [original.id]);
    assert.equal(tasks.getUploadTask(duplicate.id)?.packId, null);
    assert.ok(fs.existsSync(duplicateRoot));

    // A restart must preserve both the unresolved confirmation and its downloaded file.
    closeDb();
    await initDb();
    assert.equal(tasks.getUploadTask(duplicate.id)?.status, 'duplicate');
    await continueMegaImport(duplicate.id);
    const confirmed = tasks.getUploadTask(duplicate.id)!;
    assert.equal(confirmed.status, 'processing');
    assert.ok(confirmed.packId);
    assert.equal(packs.getPack(confirmed.packId!)?.name, 'duplicate', 'a custom title must survive metadata and duplicate confirmation');
    assert.deepEqual(fs.readFileSync(getArchivePath(confirmed.packId!, 'original.zip')), contents);
    assert.equal(fs.existsSync(duplicateRoot), false);

    const automatic = tasks.createUploadTask({ source: 'mega', name: 'MEGA 分享', autoName: true });
    journal(automatic.id, 'archive');
    await startMegaImport(automatic.id, { ...tasks.getUploadTaskMetadata(automatic.id), name: automatic.name });
    assert.equal(tasks.getUploadTask(automatic.id)?.name, 'fixture', 'resolved metadata must name the card before duplicate confirmation');
    await continueMegaImport(automatic.id);
    assert.equal(packs.getPack(tasks.getUploadTask(automatic.id)!.packId!)?.name, 'fixture');

    for (const kind of ['archive', 'folder'] as const) {
      const task = createTask(`interrupted ${kind}`);
      const root = journal(task.id, kind);
      const pack = packs.createPack({ name: task.name, originalFilename: kind === 'archive' ? 'fixture.zip' : 'Photos',
        originalFormat: kind === 'archive' ? 'zip' : 'folder', originalSize: contents.length, sourceType: kind,
        ...(kind === 'archive' ? { archiveMd5: md5 } : {}),
      });
      if (kind === 'folder') packs.createPackFiles(pack.id, [{ relativePath: 'nested/photo.jpg', fileSize: contents.length }]);
      tasks.updateUploadTask(task.id, { status: 'processing', packId: pack.id });
      closeDb();
      await initDb();
      await recoverMegaImports();
      assert.equal(fs.existsSync(root), false);
      assert.equal(tasks.getUploadTask(task.id)?.packId, pack.id, 'recovery must retain the same pack');
      if (kind === 'archive') {
        assert.deepEqual(fs.readFileSync(getArchivePath(pack.id, 'original.zip')), contents);
        assert.equal(packs.getLatestJob(pack.id, 'extract')?.status, 'pending');
      } else {
        assert.equal(packs.getPack(pack.id)?.status, 'verifying');
        assert.equal(packs.getPack(pack.id)?.imageCount, 1);
        assert.equal(fs.existsSync(getFolderStagingDir(pack.id)), false);
        assert.equal(packs.getLatestJob(pack.id, 'verify')?.status, 'pending');
      }
      const count = (getDb().prepare('SELECT count(*) AS count FROM jobs WHERE pack_id = ?').get(pack.id) as { count: number }).count;
      await recoverMegaImports();
      assert.equal((getDb().prepare('SELECT count(*) AS count FROM jobs WHERE pack_id = ?').get(pack.id) as { count: number }).count, count);
    }
  } finally {
    await shutdownMegaImports();
    closeDb();
    jobQueue.enqueueUnique = previousEnqueue;
    jobQueue.start = previousStart;
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

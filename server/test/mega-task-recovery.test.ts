import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Fastify from 'fastify';

test('MEGA duplicate confirmation and archive/folder materialization recover from a durable download journal', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-mega-recovery-'));
  const previousDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = directory;
  const { initDb, closeDb, getDb } = await import('~/db/connection');
  const packs = await import('~/db/repositories');
  const tasks = await import('~/services/upload-tasks');
  const { startMegaImport, continueMegaImport, recoverMegaImports, shutdownMegaImports } = await import('~/services/mega-import');
  const { jobQueue } = await import('~/services/job-queue');
  const { getArchivePath, getFolderStagingDir } = await import('~/services/storage');
  const { registerUploadTaskRoutes } = await import('~/routes/upload-tasks');
  const app = Fastify();
  await app.register(registerUploadTaskRoutes);
  const previousEnqueue = jobQueue.enqueueUnique;
  const previousStart = jobQueue.start;
  // Test durable handoff in isolation; the ordinary queue/extractor has separate integration coverage.
  jobQueue.enqueueUnique = async (packId, type) => packs.createJob(packId, type);
  jobQueue.start = () => {};
  const contents = Buffer.from('downloaded fixture');
  const md5 = createHash('md5').update(contents).digest('hex');
  // Journals provide all content; omitting a URL also prevents accidental network access.
  const createTask = (name: string) => tasks.createUploadTask({ source: 'mega', name });
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
      const task = createTask(`failed handoff ${kind}`);
      const root = journal(task.id, kind);
      const rename = fs.renameSync;
      fs.renameSync = (source, destination) => {
        if (String(source).startsWith(path.join(root, 'contents'))) throw new Error('EACCES: fixture handoff failure');
        rename(source, destination);
      };
      try {
        await startMegaImport(task.id, tasks.getUploadTaskMetadata(task.id), true);
        const failed = tasks.getSyncedUploadTask(task.id)!;
        assert.ok(failed.packId, 'failure must happen after pack publication');
        assert.equal(failed.status, 'failed', 'polling must not erase a materialization error');
        assert.match(failed.error!, /EACCES/);
        assert.equal(packs.hasAnyActiveJob(failed.packId!), false);
        const retry = await app.inject({ method: 'POST', url: `/api/upload-tasks/${task.id}/retry`, payload: {} });
        assert.equal(retry.statusCode, 200, retry.body);
        assert.equal(tasks.getSyncedUploadTask(task.id)?.status, 'failed');
        assert.equal(tasks.getUploadTask(task.id)?.packId, failed.packId);
      } finally {
        fs.renameSync = rename;
      }
      const packId = tasks.getUploadTask(task.id)!.packId!;
      if (kind === 'archive') {
        const retry = await app.inject({ method: 'POST', url: `/api/upload-tasks/${task.id}/retry`, payload: {} });
        assert.equal(retry.statusCode, 200, retry.body);
        // Observe the route's background worker instead of starting another import
        // after it has already consumed the journal.
        for (let attempt = 0; attempt < 100 && fs.existsSync(root); attempt++) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      } else {
        closeDb();
        await initDb();
        await recoverMegaImports();
      }
      assert.equal(tasks.getSyncedUploadTask(task.id)?.status, 'processing');
      assert.equal(tasks.getUploadTask(task.id)?.packId, packId);
      assert.equal(fs.existsSync(root), false);
      assert.ok(packs.getLatestJob(packId, kind === 'archive' ? 'extract' : 'verify'));
      assert.equal((getDb().prepare('SELECT count(*) AS count FROM jobs WHERE pack_id = ?').get(packId) as { count: number }).count, 1);
    }

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
    await app.close();
    closeDb();
    jobQueue.enqueueUnique = previousEnqueue;
    jobQueue.start = previousStart;
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

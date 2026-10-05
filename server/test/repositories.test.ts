import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-repositories-'));
process.env.DATA_DIR = dataDir;

const connection = await import('~/db/connection');
const repositories = await import('~/db/repositories');
const { folderProcessor } = await import('~/services/folder-processor');
const {
  ensureDir,
  getExtractedImagesDir,
  getFolderStagingDir,
} = await import('~/services/storage');

test.after(() => {
  connection.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('enables foreign keys and updates presets with the correct parameters', async () => {
  await connection.initDb();
  const foreignKeys = connection.getDb().pragma('foreign_keys', { simple: true });
  assert.equal(foreignKeys, 1);

  const preset = repositories.createPreset('before', {
    format: 'jpeg',
    quality: 80,
    keepVideos: true,
    scaleImages: true,
    maxDimension: 1920,
  });
  const updated = repositories.updatePreset(preset.id, 'after', {
    format: 'jpeg',
    quality: 72,
    keepVideos: false,
    scaleImages: true,
    maxDimension: 1600,
  });

  assert.equal(updated?.name, 'after');
  assert.equal(updated?.options.quality, 72);
});

test('deleting a pack removes all relational rows atomically', () => {
  const pack = repositories.createPack({
    name: 'pack',
    originalFilename: 'pack.zip',
    originalSize: 1,
    originalFormat: 'zip',
  });
  const tag = repositories.createTag('tag');
  repositories.setPackTags(pack.id, [tag.id]);
  repositories.createJob(pack.id, 'thumbnail');
  repositories.createPackFiles(pack.id, [{ relativePath: 'folder/image.jpg', fileSize: 1 }]);

  repositories.deletePack(pack.id);

  const db = connection.getDb();
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM pack_tags').get() as { count: number }).count, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM jobs').get() as { count: number }).count, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM pack_files').get() as { count: number }).count, 0);
});

test('creates at most one active job of a given type per pack', () => {
  const pack = repositories.createPack({
    name: 'unique job pack',
    originalFilename: 'pack.zip',
    originalSize: 1,
    originalFormat: 'zip',
  });

  const first = repositories.createJobIfIdle(pack.id, 'compress');
  const second = repositories.createJobIfIdle(pack.id, 'compress');

  assert.ok(first);
  assert.equal(second, undefined);
});

test('active job exclusions respect job status and pack boundaries', () => {
  const pack = repositories.createPack({ name: 'active jobs', originalFilename: 'pack.zip', originalSize: 1, originalFormat: 'zip' });
  const other = repositories.createPack({ name: 'other jobs', originalFilename: 'other.zip', originalSize: 1, originalFormat: 'zip' });
  repositories.createJob(pack.id, 'verify');
  repositories.createJob(other.id, 'compress');
  assert.equal(repositories.hasActiveJobOtherThan(pack.id, 'verify'), false);

  const compression = repositories.createJob(pack.id, 'compress');
  for (const status of ['pending', 'running', 'completed', 'failed', 'cancelled'] as const) {
    repositories.updateJobStatus(compression.id, status);
    const active = status === 'pending' || status === 'running';
    assert.equal(repositories.hasActiveJobOtherThan(pack.id, 'verify'), active, status);
    assert.equal(repositories.hasActiveJob(pack.id, 'compress'), active, status);
  }
});

test('pending cancellation supports type filtering and a second pass without changing running or finished jobs', () => {
  const pack = repositories.createPack({ name: 'cancel jobs', originalFilename: 'pack.zip', originalSize: 1, originalFormat: 'zip' });
  const other = repositories.createPack({ name: 'untouched jobs', originalFilename: 'other.zip', originalSize: 1, originalFormat: 'zip' });
  const verification = repositories.createJob(pack.id, 'verify');
  const thumbnail = repositories.createJob(pack.id, 'thumbnail');
  const otherJob = repositories.createJob(other.id, 'verify');
  const untouched = ['running', 'completed', 'failed', 'cancelled'].map(status => {
    const job = repositories.createJob(pack.id, 'verify');
    repositories.updateJobStatus(job.id, status as 'running' | 'completed' | 'failed' | 'cancelled', 42);
    return repositories.getJob(job.id)!;
  });

  assert.equal(repositories.cancelPendingJobs(pack.id, 'verify'), 1);
  assert.equal(repositories.getJob(verification.id)?.status, 'cancelled');
  assert.equal(repositories.getJob(thumbnail.id)?.status, 'pending');
  assert.equal(repositories.cancelPendingJobs(pack.id), 1);
  assert.equal(repositories.getJob(thumbnail.id)?.status, 'cancelled');
  assert.equal(repositories.cancelPendingJobs(pack.id), 0);

  const followUp = repositories.createJob(pack.id, 'verify');
  assert.equal(repositories.cancelPendingJobs(pack.id), 1);
  assert.equal(repositories.getJob(followUp.id)?.status, 'cancelled');
  assert.equal(repositories.getJob(otherJob.id)?.status, 'pending');
  for (const job of untouched) assert.deepEqual(repositories.getJob(job.id), job);
});

test('folder processing resumes after files were partially moved', async () => {
  const pack = repositories.createPack({
    name: 'folder recovery',
    originalFilename: 'folder recovery',
    originalSize: 7,
    originalFormat: 'folder',
    sourceType: 'folder',
  });
  const stagingDir = getFolderStagingDir(pack.id);
  const imagesDir = getExtractedImagesDir(pack.id);
  ensureDir(path.join(stagingDir, 'wrapper'));
  ensureDir(imagesDir);

  // Simulate a crash after one rename but before folder processing completed.
  fs.writeFileSync(path.join(imagesDir, 'first.jpg'), 'one');
  fs.writeFileSync(path.join(stagingDir, 'wrapper', 'second.jpg'), 'two!');

  const result = folderProcessor.processUploadedFolder(pack.id);
  assert.equal(result.imageCount, 2);
  assert.equal(result.totalImagesSize, 7);
  assert.equal(result.structureType, 'flat');
  assert.equal(fs.existsSync(stagingDir), false);
});

test('upload job lookup excludes compression and breaks timestamp ties by insertion order', () => {
  const pack = repositories.createPack({ name: 'upload jobs', originalFilename: 'pack.zip', originalSize: 1, originalFormat: 'zip' });
  assert.equal(repositories.getLatestUploadJob(pack.id), undefined);
  const first = repositories.createJob(pack.id, 'extract');
  const latest = repositories.createJob(pack.id, 'thumbnail');
  const compressed = repositories.createJob(pack.id, 'compress');
  connection.getDb().prepare('UPDATE jobs SET created_at = ? WHERE pack_id = ?').run('2026-01-01 00:00:00', pack.id);
  const options = JSON.stringify({ autoName: true, autoTags: false });
  repositories.updateJobOptions(latest.id, options);
  repositories.updatePackArchivePassword(pack.id, 'synthetic-password');
  assert.equal(repositories.getLatestUploadJob(pack.id)?.id, latest.id);
  assert.equal(repositories.getLatestUploadJob(pack.id)?.options, options);
  assert.equal(repositories.getJob(first.id)?.options, null);
  assert.equal(repositories.getJob(compressed.id)?.options, null);
  assert.equal(repositories.getPack(pack.id)?.archivePassword, 'synthetic-password');
  assert.throws(() => connection.getDb().transaction(() => {
    repositories.updateJobOptions(latest.id, '{}');
    repositories.updatePackArchivePassword(pack.id, null);
    throw new Error('rollback');
  })(), /rollback/);
  assert.equal(repositories.getJob(latest.id)?.options, options);
  assert.equal(repositories.getPack(pack.id)?.archivePassword, 'synthetic-password');
});

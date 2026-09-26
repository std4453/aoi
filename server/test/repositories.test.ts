import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-repositories-'));
process.env.DATA_DIR = dataDir;

const connection = await import('../src/db/connection.js');
const repositories = await import('../src/db/repositories.js');
const { folderProcessor } = await import('../src/services/folder-processor.js');
const {
  ensureDir,
  getExtractedImagesDir,
  getFolderStagingDir,
} = await import('../src/services/storage.js');

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

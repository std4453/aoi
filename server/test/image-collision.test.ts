import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import sharp from 'sharp';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-image-collision-'));
process.env.DATA_DIR = dataDir;

const connection = await import('~/db/connection');
const repositories = await import('~/db/repositories');
const { archiveGenerator } = await import('~/services/archive-generator');
const { imageCompressor } = await import('~/services/image-compressor');
const { thumbnailGenerator } = await import('~/services/thumbnail-generator');
const { buildJpegOutputPaths } = await import('~/services/jpeg-output-path');
const {
  ensureDir,
  getExtractedImagesDir,
  getGeneratedDir,
  getGeneratedPath,
  getThumbnailsDir,
} = await import('~/services/storage');

test.after(() => {
  connection.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('preserves images with the same stem but different extensions', async () => {
  await connection.initDb();
  const pack = repositories.createPack({
    name: 'same stem',
    originalFilename: 'same-stem.zip',
    originalSize: 1,
    originalFormat: 'zip',
  });
  const imagesDir = getExtractedImagesDir(pack.id);
  ensureDir(imagesDir);

  const pixels = {
    create: {
      width: 40,
      height: 30,
      channels: 3 as const,
      background: '#eb3b5a',
    },
  };
  await sharp(pixels).png().toFile(path.join(imagesDir, 'same.png'));
  await sharp(pixels).jpeg().toFile(path.join(imagesDir, 'same.jpg'));

  const hashes = await thumbnailGenerator.generateAll(pack.id);
  const thumbnailDir = getThumbnailsDir(pack.id);
  assert.equal(fs.existsSync(path.join(thumbnailDir, 'same.png.jpg')), true);
  assert.equal(fs.existsSync(path.join(thumbnailDir, 'same.jpg.jpg')), true);
  assert.deepEqual(Object.keys(hashes).sort(), ['same.jpg.jpg', 'same.png.jpg']);

  await imageCompressor.compressPack(pack.id, {
    format: 'jpeg',
    quality: 80,
    keepVideos: true,
    scaleImages: true,
    maxDimension: 1920,
  });
  const workDir = path.join(getGeneratedDir(pack.id), 'temp');
  assert.equal(fs.existsSync(path.join(workDir, 'same.png.jpg')), true);
  assert.equal(fs.existsSync(path.join(workDir, 'same.jpg.jpg')), true);
});

test('JPEG output mapping remains unique for pathological filenames', () => {
  const outputs = buildJpegOutputPaths([
    'same.png',
    'same.jpg',
    'same.png.jpg',
  ]);
  assert.equal(new Set(outputs.values()).size, 3);
  assert.equal(outputs.get('same.png.jpg'), 'same.png.jpg');
  assert.equal(outputs.get('same.png'), 'same.png.converted-1.jpg');
});

test('compression fails closed when selected or source images cannot be processed', async () => {
  const pack = repositories.createPack({
    name: 'compression failure',
    originalFilename: 'failure.zip',
    originalSize: 1,
    originalFormat: 'zip',
  });
  const imagesDir = getExtractedImagesDir(pack.id);
  ensureDir(imagesDir);
  fs.writeFileSync(path.join(imagesDir, 'broken.jpg'), 'not an image');

  const options = {
    format: 'jpeg' as const,
    quality: 80,
    keepVideos: true,
    scaleImages: true,
    maxDimension: 1920,
  };
  await assert.rejects(
    imageCompressor.compressPack(pack.id, options, undefined, {
      images: ['missing.jpg'],
      videos: [],
    }),
    /Selected image files no longer exist/
  );
  await assert.rejects(
    imageCompressor.compressPack(pack.id, options),
    /Failed to compress 1 image/
  );
});

test('archive generation preserves the previous output when no source files remain', async () => {
  const pack = repositories.createPack({
    name: 'empty output protection',
    originalFilename: 'empty.zip',
    originalSize: 1,
    originalFormat: 'zip',
  });
  const generatedDir = getGeneratedDir(pack.id);
  const generatedPath = getGeneratedPath(pack.id);
  ensureDir(path.join(generatedDir, 'temp'));
  fs.writeFileSync(generatedPath, 'known-good-archive');

  await assert.rejects(
    archiveGenerator.generate(pack.id, {
      format: 'jpeg',
      quality: 80,
      keepVideos: true,
      scaleImages: true,
      maxDimension: 1920,
    }),
    /No source files remain/
  );
  assert.equal(fs.readFileSync(generatedPath, 'utf8'), 'known-good-archive');
});

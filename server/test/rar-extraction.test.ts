import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import sharp from 'sharp';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-rar-'));
process.env.DATA_DIR = root;
const { initDb, closeDb } = await import('../src/db/connection.js');
const { createPack, getPack } = await import('../src/db/repositories.js');
const { archiveExtractor } = await import('../src/services/archive-extractor.js');
const { getArchivePath, getExtractedImagesDir } = await import('../src/services/storage.js');
await initDb();
test.after(() => { closeDb(); fs.rmSync(root, { recursive: true, force: true }); });

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function block(type: number, flags: number, payload = Buffer.alloc(0)): Buffer {
  const data = Buffer.alloc(7 + payload.length);
  data[2] = type; data.writeUInt16LE(flags, 3); data.writeUInt16LE(data.length, 5);
  payload.copy(data, 7); data.writeUInt16LE(crc32(data.subarray(2)) & 0xffff);
  return data;
}

test('RAR image imports through the installed 7z backend and preserves image bytes', async () => {
  // A generated RAR4 stored entry avoids committing archives or third-party media.
  const formats = execFileSync('7z', ['i'], { encoding: 'utf8' });
  assert.match(formats, /\bRar\b/); assert.match(formats, /\bRar5\b/);
  const image = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#225599' } }).png().toBuffer();
  const name = Buffer.from('image.png');
  const header = Buffer.alloc(25 + name.length);
  header.writeUInt32LE(image.length, 0); header.writeUInt32LE(image.length, 4);
  header[8] = 2; header.writeUInt32LE(crc32(image), 9);
  header[17] = 20; header[18] = 0x30; header.writeUInt16LE(name.length, 19);
  header.writeUInt32LE(0x20, 21); name.copy(header, 25);
  const archive = Buffer.concat([Buffer.from('526172211a0700', 'hex'), block(0x73, 0, Buffer.alloc(6)), block(0x74, 0x8000, header), image, block(0x7b, 0)]);
  const pack = createPack({ name: 'RAR smoke test', originalFilename: 'test.rar', originalFormat: 'rar', originalSize: archive.length });
  const archivePath = getArchivePath(pack.id, 'original.rar');
  fs.mkdirSync(path.dirname(archivePath), { recursive: true }); fs.writeFileSync(archivePath, archive);
  await archiveExtractor.extract(pack);
  assert.equal(getPack(pack.id)?.imageCount, 1);
  assert.deepEqual(fs.readFileSync(path.join(getExtractedImagesDir(pack.id), 'image.png')), image);
});


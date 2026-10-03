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
const { createPack, getPack, updatePackStatus } = await import('../src/db/repositories.js');
const { archiveExtractor, is7zLinkField } = await import('../src/services/archive-extractor.js');
const { createUploadTask, updateUploadTask, getSyncedUploadTask } = await import('../src/services/upload-tasks.js');
const { getArchivePath, getExtractedImagesDir } = await import('../src/services/storage.js');
await initDb();
test.after(() => { closeDb(); fs.rmSync(root, { recursive: true, force: true }); });

test('7z RAR listings distinguish empty link fields from actual links', () => {
  for (const line of ['Symbolic Link = ', 'Hard Link = ', 'Copy Link = ', 'Attributes = A', 'Attributes = A -rw-r--r--']) {
    assert.equal(is7zLinkField(line), false, line);
  }
  for (const line of ['Symbolic Link = ../outside', 'Hard Link = image.png', 'Copy Link = image.png', 'Attributes = l---------', 'Attributes = A lrwxrwxrwx']) {
    assert.equal(is7zLinkField(line), true, line);
  }
});

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

test('RAR imports preserve image bytes and damaged archives never request a password', async () => {
  // A generated RAR4 stored entry avoids committing archives or third-party media.
  const formats = execFileSync('7z', ['i'], { encoding: 'utf8' });
  assert.match(formats, /\bRar\b/); assert.match(formats, /\bRar5\b/);
  const codecs = formats.split('Codecs:')[1]?.split('Hashers:')[0] ?? '';
  assert.match(codecs, /\bRar5\b/, '7z must include the RAR5 decoder, not just its archive handler');
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

  // A missing RAR end block makes 7z fail after listing "Encrypted = -".
  // That metadata must not turn a damaged, unencrypted archive into a password prompt.
  const truncated = createPack({ name: 'Truncated RAR', originalFilename: 'truncated.rar', originalFormat: 'rar', originalSize: archive.length - 15 });
  const truncatedPath = getArchivePath(truncated.id, 'original.rar');
  fs.mkdirSync(path.dirname(truncatedPath), { recursive: true });
  fs.writeFileSync(truncatedPath, archive.subarray(0, -15));
  const task = createUploadTask({ source: 'archive', name: truncated.name, filename: 'truncated.rar', fileSize: truncated.originalSize });
  updateUploadTask(task.id, { packId: truncated.id });
  await assert.rejects(archiveExtractor.extract(truncated), error => {
    const message = String(error);
    assert.doesNotMatch(message, /需要密码|密码错误/);
    assert.match(message, /Encrypted = -/);
    updatePackStatus(truncated.id, 'failed', message);
    assert.equal(getSyncedUploadTask(task.id)?.status, 'failed');
    return true;
  });
});

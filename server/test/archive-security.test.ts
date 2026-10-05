import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-archive-security-'));
process.env.DATA_DIR = dataDir;

const connection = await import('~/db/connection');
const repositories = await import('~/db/repositories');
const { archiveExtractor } = await import('~/services/archive-extractor');
const { ensureDir, getArchivePath, getPath } = await import('~/services/storage');

function makeStoredZip(entryName: string): Buffer {
  const name = Buffer.from(entryName);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0, 6);
  local.writeUInt16LE(0, 8);
  local.writeUInt32LE(0, 14);
  local.writeUInt32LE(0, 18);
  local.writeUInt32LE(0, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt32LE(0, 16);
  central.writeUInt32LE(0, 20);
  central.writeUInt32LE(0, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);

  const centralOffset = local.length + name.length;
  const centralSize = central.length + name.length;
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);

  return Buffer.concat([local, name, central, name, end]);
}

test.after(() => {
  connection.closeDb();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('rejects ZIP traversal without falling back to an external extractor', async () => {
  await connection.initDb();
  const pack = repositories.createPack({
    name: 'unsafe archive',
    originalFilename: 'unsafe.zip',
    originalSize: 1,
    originalFormat: 'zip',
  });
  const archivePath = getArchivePath(pack.id, 'original.zip');
  ensureDir(path.dirname(archivePath));
  fs.writeFileSync(archivePath, makeStoredZip('../escape.jpg'));

  await assert.rejects(
    archiveExtractor.extract(pack),
    /ZIP entry path contains an unsafe path segment/
  );
  assert.equal(
    fs.existsSync(path.join(getPath('extracted', pack.id), 'escape.jpg')),
    false
  );
});

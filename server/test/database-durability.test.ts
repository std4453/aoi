import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import {
  startTestServer,
  stopTestServer,
  waitForExit,
} from './helpers/server-process';

function createTestDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `aoi-${name}-`));
}

async function createTag(url: string, name: string): Promise<void> {
  const response = await fetch(`${url}/api/tags`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  assert.equal(response.status, 200);
}

async function listTagNames(url: string): Promise<string[]> {
  const response = await fetch(`${url}/api/tags`);
  assert.equal(response.status, 200);
  const tags = await response.json() as Array<{ name: string }>;
  return tags.map(tag => tag.name);
}

test('graceful shutdown creates a backup and preserves committed data', async () => {
  const dataDir = createTestDir('graceful');
  try {
    const first = await startTestServer(dataDir);
    await createTag(first.url, 'persistent-tag');
    assert.equal(await stopTestServer(first), 0);

    const backups = fs.readdirSync(path.join(dataDir, 'backups'))
      .filter(name => name.endsWith('.sqlite'));
    assert.equal(backups.length, 1);

    const second = await startTestServer(dataDir);
    assert.deepEqual(await listTagNames(second.url), ['persistent-tag']);
    assert.equal(await stopTestServer(second), 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('SIGKILL cannot roll back a committed SQLite transaction', async () => {
  const dataDir = createTestDir('sigkill');
  try {
    const first = await startTestServer(dataDir);
    await createTag(first.url, 'survives-sigkill');
    assert.equal(await stopTestServer(first, 'SIGKILL'), null);

    const second = await startTestServer(dataDir);
    assert.deepEqual(await listTagNames(second.url), ['survives-sigkill']);
    assert.equal(await stopTestServer(second), 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a second process sharing DATA_DIR is rejected by the SQLite instance lock', async () => {
  const dataDir = createTestDir('lock');
  try {
    const first = await startTestServer(dataDir);
    const second = await startTestServer(dataDir, false);
    assert.equal(await waitForExit(second), 1);
    assert.match(second.output(), /Another AoI instance is already using DATA_DIR/);
    assert.equal(await stopTestServer(first), 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('an empty database file is rejected and never overwritten', async () => {
  const dataDir = createTestDir('empty');
  const dbDir = path.join(dataDir, 'db');
  const dbPath = path.join(dbDir, 'packdb.sqlite');
  fs.mkdirSync(dbDir, { recursive: true });
  fs.writeFileSync(dbPath, Buffer.alloc(0));

  try {
    const server = await startTestServer(dataDir, false);
    assert.equal(await waitForExit(server), 1);
    assert.match(server.output(), /Refusing to start with an empty database file/);
    assert.equal(fs.statSync(dbPath).size, 0);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a missing database in an initialized data directory fails closed', async () => {
  const dataDir = createTestDir('missing');
  try {
    const first = await startTestServer(dataDir);
    assert.equal(await stopTestServer(first), 0);

    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(path.join(dataDir, 'db', `packdb.sqlite${suffix}`), { force: true });
    }

    const second = await startTestServer(dataDir, false);
    assert.equal(await waitForExit(second), 1);
    assert.match(second.output(), /Database file is missing from an initialized data directory/);
    assert.equal(fs.existsSync(path.join(dataDir, 'db', 'packdb.sqlite')), false);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('shutdown timeout terminates an active 7z child and requeues its job', async () => {
  const dataDir = createTestDir('archive-child');
  const fakeBin = path.join(dataDir, 'fake-bin');
  const childPidPath = path.join(dataDir, '7z-child.pid');
  let archiveChildPid: number | undefined;

  try {
    const initializer = await startTestServer(dataDir);
    assert.equal(await stopTestServer(initializer), 0);

    fs.mkdirSync(fakeBin, { recursive: true });
    const fake7z = path.join(fakeBin, '7z');
    fs.writeFileSync(
      fake7z,
      `#!/usr/bin/env node
if (process.argv[2] === 'i') process.exit(0);
require('node:fs').writeFileSync(process.env.AOI_7Z_PID_FILE, String(process.pid));
process.on('SIGTERM', () => process.exit(143));
setInterval(() => {}, 1000);
`,
      { mode: 0o755 }
    );

    const packId = '55555555-5555-4555-8555-555555555555';
    const database = new Database(path.join(dataDir, 'db', 'packdb.sqlite'));
    database.prepare(`
      INSERT INTO packs (
        id, name, original_filename, original_size, original_format, status, source_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(packId, 'slow rar', 'slow.rar', 4, 'rar', 'uploading', 'archive');
    database.close();
    const archivePath = path.join(dataDir, 'archives', packId, 'original.rar');
    fs.mkdirSync(path.dirname(archivePath), { recursive: true });
    fs.writeFileSync(archivePath, 'fake');

    const server = await startTestServer(dataDir, true, {
      PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      AOI_7Z_PID_FILE: childPidPath,
      SHUTDOWN_TIMEOUT: '100',
    });
    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(childPidPath) && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(fs.existsSync(childPidPath), true);
    archiveChildPid = Number(fs.readFileSync(childPidPath, 'utf8'));

    assert.equal(await stopTestServer(server), 1);
    assert.throws(() => process.kill(archiveChildPid!, 0), /ESRCH/);

    const recoveredDb = new Database(path.join(dataDir, 'db', 'packdb.sqlite'));
    const job = recoveredDb.prepare(
      'SELECT status FROM jobs WHERE pack_id = ? ORDER BY created_at DESC LIMIT 1'
    ).get(packId) as { status: string };
    recoveredDb.close();
    assert.equal(job.status, 'pending');
  } finally {
    if (archiveChildPid) {
      try {
        process.kill(archiveChildPid, 'SIGKILL');
      } catch {
        // The expected path already terminated the child.
      }
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

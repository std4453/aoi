import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../src/db/migrations.js';
import { createSnapshot, validateManifest, hashFile } from '../src/replication/protocol.js';
import { protocolVersion } from '../src/version.js';
import { beginMutation } from '../src/replication/state.js';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aoi-protocol-'));
  const db = new Database(path.join(root, 'source.sqlite'));
  db.exec(fs.readFileSync('src/db/schema.sql', 'utf8'));
  runMigrations(db);
  db.exec(`CREATE TABLE viewing_history (secret TEXT);
    INSERT INTO viewing_history VALUES ('private-history');
    ALTER TABLE packs ADD COLUMN future_private_column TEXT;
    INSERT INTO packs (id,name,original_filename,original_size,original_format,status,archive_password,future_private_column)
    VALUES ('pack1','First','a.zip',10,'zip','generated','secret-password','private-future');
    INSERT INTO packs (id,name,original_filename,original_size,original_format,status)
    VALUES ('unfinished','Not published','a.zip',10,'zip','uploading');
    INSERT INTO tags (id,name) VALUES ('tag1','Tag');
    INSERT INTO pack_tags VALUES ('pack1','tag1'), ('unfinished','tag1');
    INSERT INTO presets (id,name,options) VALUES ('preset1','Preset','{}');
    INSERT INTO pack_verifications (pack_id,version,status) VALUES ('pack1',1,'valid'), ('unfinished',1,'valid');
    INSERT INTO uploads (id,filename,file_size) VALUES ('upload1','secret-upload',10);`);
  const files = path.join(root, 'data', 'generated', 'pack1');
  fs.mkdirSync(files, { recursive: true });
  fs.writeFileSync(path.join(files, 'compressed.zip'), 'immutable-content');
  fs.mkdirSync(path.join(files, 'temp'));
  fs.writeFileSync(path.join(files, 'temp', 'working.jpg'), 'incomplete');
  return { root, db, data: path.join(root, 'data'), cleanup() { db.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

test('content scope exports only allowed rows and columns; blobs are stable across metadata edits', async () => {
  const f = fixture();
  try {
    f.db.exec("UPDATE packs SET original_size=9007199254740993 WHERE id='pack1'");
    const sourceBefore = await hashFile(f.db.name);
    const first = await createSnapshot(f.db, f.data, path.join(f.root, 'one'));
    assert.deepEqual(await hashFile(f.db.name), sourceBefore, 'export must not modify the source');
    assert.equal(fs.statSync(path.join(f.root, 'one')).mode & 0o777, 0o700);
    assert.equal(first.files.length, 1);
    assert.equal(first.files[0].path, 'generated/pack1/compressed.zip');
    const catalog = new Database(path.join(f.root, 'one', 'catalog.sqlite'), { readonly: true });
    try {
      assert.equal(catalog.prepare("SELECT 1 FROM sqlite_master WHERE name='viewing_history'").get(), undefined);
      assert.equal(catalog.prepare('SELECT count(*) AS n FROM packs').get()?.n, 1);
      assert.equal(catalog.prepare('SELECT original_size FROM packs').safeIntegers().pluck().get(), 9007199254740993n);
      assert.deepEqual(catalog.prepare('SELECT archive_password,future_private_column FROM packs').get(), { archive_password: null, future_private_column: null });
      assert.equal(catalog.prepare('SELECT count(*) AS n FROM uploads').get()?.n, 0);
      assert.equal(catalog.prepare('SELECT count(*) AS n FROM pack_tags').get()?.n, 1);
      assert.deepEqual(catalog.prepare('SELECT pack_id FROM pack_verifications').all(), [{ pack_id: 'pack1' }]);
      assert.equal(catalog.prepare('SELECT name FROM presets WHERE id=?').pluck().get('preset1'), 'Preset');
      assert.deepEqual(catalog.pragma('foreign_key_check'), []);
    } finally { catalog.close(); }
    f.db.prepare("UPDATE packs SET name='Renamed' WHERE id='pack1'").run();
    const second = await createSnapshot(f.db, f.data, path.join(f.root, 'two'));
    assert.deepEqual(first.files, second.files);
    assert.notEqual(first.catalog.hash, second.catalog.hash);
    assert.deepEqual(await hashFile(path.join(f.root, 'two', 'blobs', second.files[0].hash)), { hash: second.files[0].hash, size: second.files[0].size });
    assert.equal(first.protocol, protocolVersion);
    assert.equal('build' in first, false);
    assert.deepEqual(validateManifest(first), first);
    const [major, minor, patch] = protocolVersion.split('.').map(Number);
    for (const protocol of [1, undefined, `${major + 1}.${minor}.${patch}`, `${major}.${minor + 1}.${patch}`, `${major}.${minor}.${patch + 1}`, `${protocolVersion}-rc.1`]) {
      assert.throws(() => validateManifest({ ...first, protocol }), /Replication protocol mismatch/);
    }
    assert.throws(() => validateManifest({ ...first, scope: 'all-data' }));
    assert.throws(() => validateManifest({ ...first, files: [{ ...first.files[0], path: 'generated/pack1/../../escape' }] }), /unsafe/);
    assert.throws(() => validateManifest({ ...first, files: [first.files[0], first.files[0]] }), /Duplicate/);
  } finally { f.cleanup(); }
});

test('concurrent writes invalidate an export without blocking the writer', async () => {
  const f = fixture();
  try {
    const end = beginMutation();
    await assert.rejects(createSnapshot(f.db, f.data, path.join(f.root, 'active')), /deferred/);
    end();
    const attempt = createSnapshot(f.db, f.data, path.join(f.root, 'racing'));
    const finish = beginMutation();
    f.db.prepare("UPDATE packs SET name='changed' WHERE id='pack1'").run();
    finish();
    await assert.rejects(attempt, /changed during export/);
    assert.equal(fs.existsSync(path.join(f.root, 'racing', 'manifest.json')), false);
    await createSnapshot(f.db, f.data, path.join(f.root, 'retry'));
  } finally { f.cleanup(); }
});

test('pending jobs and symlinked files cannot enter a published snapshot', async () => {
  const f = fixture();
  try {
    f.db.exec("INSERT INTO jobs (id,pack_id,type) VALUES ('j','pack1','compress')");
    await assert.rejects(createSnapshot(f.db, f.data, path.join(f.root, 'pending')), /pending/);
    f.db.exec('DELETE FROM jobs');
    fs.symlinkSync('/etc/passwd', path.join(f.data, 'generated', 'pack1', 'escape'));
    await assert.rejects(createSnapshot(f.db, f.data, path.join(f.root, 'symlink')), /Symlinks/);
  } finally { f.cleanup(); }
});

test('a read request pins both database and file root across live generation activation', async () => {
  const { default: Fastify } = await import('fastify');
  const { config } = await import('../src/config.js');
  const { registerReplicationHooks } = await import('../src/replication/http.js');
  const { activateGeneration, closeGenerations } = await import('../src/replication/state.js');
  const { getDb } = await import('../src/db/connection.js');
  const { getGeneratedPath } = await import('../src/services/storage.js');
  const oldRole = config.replicationRole;
  config.replicationRole = 'replica';
  const oldDb = new Database(':memory:');
  oldDb.exec("CREATE TABLE marker(value); INSERT INTO marker VALUES ('old')");
  const newDb = new Database(':memory:');
  newDb.exec("CREATE TABLE marker(value); INSERT INTO marker VALUES ('new')");
  let started!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const paused = new Promise<void>(resolve => { resume = resolve; });
  const app = Fastify();
  registerReplicationHooks(app);
  app.get('/api/context', async () => {
    const before = getDb().prepare('SELECT value FROM marker').pluck().get();
    const fileBefore = getGeneratedPath('pack1');
    started();
    await paused;
    return { before, after: getDb().prepare('SELECT value FROM marker').pluck().get(), fileBefore, fileAfter: getGeneratedPath('pack1') };
  });
  try {
    activateGeneration({ id: 'old', root: '/old', db: oldDb, readers: 0, retired: false });
    const request = app.inject('/api/context');
    const responsePromise = Promise.resolve(request);
    await entered;
    activateGeneration({ id: 'new', root: '/new', db: newDb, readers: 0, retired: false });
    assert.equal(oldDb.open, true);
    resume();
    const result = (await responsePromise).json();
    assert.deepEqual(result, { before: 'old', after: 'old', fileBefore: '/old/generated/pack1/compressed.zip', fileAfter: '/old/generated/pack1/compressed.zip' });
    assert.equal(oldDb.open, false);
    assert.equal((await app.inject('/api/context')).json().after, 'new');
  } finally {
    resume();
    await app.close();
    closeGenerations();
    config.replicationRole = oldRole;
  }
});

import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { config } from '../config.js';
import { readContext, currentGeneration, closeGenerations } from '../replication/state.js';
import { runMigrations } from './migrations.js';

const DEFAULT_COMPRESSION_OPTIONS = {
  format: 'jpeg' as const,
  quality: 80,
  keepVideos: true,
  scaleImages: true,
  maxDimension: 1920,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATABASE_FILENAME = 'packdb.sqlite';
const LOCK_FILENAME = 'instance-lock.sqlite';
const INITIALIZED_MARKER = '.aoi-initialized';

let db: Database.Database | null = null;
let lockDb: Database.Database | null = null;

export function getDb(): Database.Database {
  const replica = readContext.getStore() ?? currentGeneration();
  if (replica) return replica.db;
  if (!db || !db.open) {
    throw new Error('Database is not initialized');
  }
  return db;
}

export function getDbPath(): string {
  return path.join(config.dirs.db, DATABASE_FILENAME);
}

function hasExistingRuntimeData(): boolean {
  const paths = [
    config.dirs.archives,
    config.dirs.extracted,
    config.dirs.generated,
    config.dirs.thumbnails,
    config.dirs.uploads,
    config.dirs.backups,
  ];
  return paths.some(dir => {
    try {
      return fs.readdirSync(dir).length > 0;
    } catch {
      return false;
    }
  });
}

function acquireInstanceLock(): void {
  const lockPath = path.join(config.dirs.db, LOCK_FILENAME);
  let candidate: Database.Database | null = null;
  try {
    candidate = new Database(lockPath, { timeout: config.instanceLockTimeout });
    fs.chmodSync(lockPath, 0o600);
    candidate.pragma('journal_mode = DELETE');
    candidate.pragma('locking_mode = EXCLUSIVE');
    candidate.exec(`
      CREATE TABLE IF NOT EXISTS instance_lock (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        holder TEXT NOT NULL
      )
    `);
    candidate.exec('BEGIN EXCLUSIVE');
    candidate.prepare(
      'INSERT INTO instance_lock (id, holder) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET holder = excluded.holder'
    ).run(`${process.pid}`);
    lockDb = candidate;
  } catch (error) {
    try {
      candidate?.close();
    } catch {
      // Ignore cleanup errors while reporting the lock failure.
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Another AoI instance is already using DATA_DIR=${config.dataDir}. ` +
      `Only one application instance may run at a time. SQLite error: ${message}`
    );
  }
}

function assertExistingDatabaseIsUsable(dbPath: string): void {
  const stat = fs.statSync(dbPath);
  if (stat.size === 0) {
    throw new Error(
      `Refusing to start with an empty database file: ${dbPath}. ` +
      'Restore a backup or move the damaged file before initializing a new database.'
    );
  }
}

function assertSafeToCreateDatabase(dbPath: string): void {
  const markerPath = path.join(config.dirs.db, INITIALIZED_MARKER);
  if (fs.existsSync(markerPath) || hasExistingRuntimeData()) {
    throw new Error(
      `Database file is missing from an initialized data directory: ${dbPath}. ` +
      'Refusing to create an empty replacement. Restore the database from backup.'
    );
  }
}

function configureDatabase(database: Database.Database): void {
  database.pragma(`busy_timeout = ${config.databaseBusyTimeout}`);
  database.pragma('foreign_keys = ON');
  database.pragma('journal_mode = WAL');
  database.pragma('synchronous = FULL');
  database.pragma('wal_autocheckpoint = 1000');
}

function assertIntegrity(database: Database.Database, dbPath: string): void {
  const rows = database.pragma('quick_check') as Array<Record<string, unknown>>;
  const result = rows[0] ? Object.values(rows[0])[0] : undefined;
  if (result !== 'ok') {
    throw new Error(`SQLite quick_check failed for ${dbPath}: ${String(result ?? 'no result')}`);
  }
}

function writeInitializedMarker(): void {
  const markerPath = path.join(config.dirs.db, INITIALIZED_MARKER);
  fs.writeFileSync(
    markerPath,
    JSON.stringify({ database: DATABASE_FILENAME, initializedAt: new Date().toISOString() }) + '\n',
    { encoding: 'utf8', mode: 0o600 }
  );
}

export async function initDb(): Promise<void> {
  if (db?.open) return;

  fs.mkdirSync(config.dirs.db, { recursive: true });
  fs.mkdirSync(config.dirs.backups, { recursive: true });
  acquireInstanceLock();
  if (config.replicationRole === 'replica') return;

  const dbPath = getDbPath();
  const existed = fs.existsSync(dbPath);

  try {
    if (existed) {
      assertExistingDatabaseIsUsable(dbPath);
    } else {
      assertSafeToCreateDatabase(dbPath);
    }

    const database = new Database(dbPath, {
      fileMustExist: existed,
      timeout: config.databaseBusyTimeout,
    });
    fs.chmodSync(dbPath, 0o600);
    db = database;
    configureDatabase(database);

    if (existed) {
      assertIntegrity(database, dbPath);
      await backupDb('startup');
    }

    const schema = readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    const initialize = database.transaction(() => {
      database.exec(schema);
      runMigrations(database);

      const row = database.prepare('SELECT COUNT(*) AS count FROM presets').get() as { count: number };
      if (row.count === 0) {
        database.prepare(
          'INSERT INTO presets (id, name, is_default, options) VALUES (?, ?, ?, ?)'
        ).run(uuidv4(), '默认', 1, JSON.stringify(DEFAULT_COMPRESSION_OPTIONS));
      }
    });
    initialize();

    assertIntegrity(database, dbPath);
    writeInitializedMarker();
  } catch (error) {
    closeDb();
    throw error;
  }
}

export async function backupDb(reason = 'manual'): Promise<string> {
  const database = getDb();
  fs.mkdirSync(config.dirs.backups, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeReason = reason.replace(/[^a-zA-Z0-9_-]/g, '_');
  const backupPath = path.join(config.dirs.backups, `packdb-${timestamp}-${safeReason}.sqlite`);
  await database.backup(backupPath);
  fs.chmodSync(backupPath, 0o600);

  const backups = fs.readdirSync(config.dirs.backups)
    .filter(name => /^packdb-.*\.sqlite$/.test(name))
    .sort()
    .reverse();
  for (const stale of backups.slice(config.backupRetention)) {
    fs.rmSync(path.join(config.dirs.backups, stale), { force: true });
  }

  return backupPath;
}

export function closeDb(): void {
  closeGenerations();
  if (db?.open) {
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } catch {
      // Closing the connection still safely releases SQLite resources.
    }
    db.close();
  }
  db = null;

  if (lockDb?.open) {
    try {
      lockDb.exec('ROLLBACK');
    } catch {
      // The transaction may already have been released.
    }
    lockDb.close();
  }
  lockDb = null;
}

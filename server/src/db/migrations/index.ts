import type Database from 'better-sqlite3';
import m001 from './001_add_compressed_size';
import m002 from './002_add_structure_type';
import m003 from './003_add_blurhashes_and_backfill';
import m004 from './004_add_source_type';
import m005 from './005_add_pack_files';
import m006 from './006_cleanup_orphaned_relations';
import m007 from './007_add_archive_md5';
import m008 from './008_add_content_verification';
import m009 from './009_add_snapshots';
import m010 from './010_add_upload_tasks';
import m011 from './011_add_task_error_codes';

export interface Migration {
  name: string;
  up: (db: Database.Database) => void;
}

const migrations: Migration[] = [
  m001,
  m002,
  m003,
  m004,
  m005,
  m006,
  m007,
  m008,
  m009,
  m010,
  m011,
];

export function runMigrations(db: Database.Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (
    name TEXT PRIMARY KEY,
    executed_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const executed = new Set(
    (db.prepare('SELECT name FROM migrations').all() as Array<{ name: string }>).map(row => row.name)
  );
  const record = db.prepare('INSERT INTO migrations (name) VALUES (?)');

  for (const migration of migrations) {
    if (executed.has(migration.name)) continue;
    console.log(`[migration] Running: ${migration.name}`);
    migration.up(db);
    record.run(migration.name);
    console.log(`[migration] Completed: ${migration.name}`);
  }
}

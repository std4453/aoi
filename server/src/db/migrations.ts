import m001 from './migrations/001_add_compressed_size.js';
import m002 from './migrations/002_add_structure_type.js';
import m003 from './migrations/003_add_blurhashes_and_backfill.js';

export interface Migration {
  name: string;
  up: (db: any) => void;
}

const migrations: Migration[] = [
  m001,
  m002,
  m003,
];

export function runMigrations(db: any): void {
  db.run(`CREATE TABLE IF NOT EXISTS migrations (
    name TEXT PRIMARY KEY,
    executed_at TEXT NOT NULL DEFAULT (datetime('now'))
  )`);

  const executed: Set<string> = new Set();
  const result = db.exec('SELECT name FROM migrations');
  if (result.length > 0) {
    for (const row of result[0].values) {
      executed.add(row[0] as string);
    }
  }

  for (const migration of migrations) {
    if (executed.has(migration.name)) continue;
    console.log(`[migration] Running: ${migration.name}`);
    migration.up(db);
    db.run('INSERT INTO migrations (name) VALUES (?)', [migration.name]);
    console.log(`[migration] Completed: ${migration.name}`);
  }
}

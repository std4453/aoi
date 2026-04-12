import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { v4 as uuidv4 } from 'uuid';
import { runMigrations } from './migrations.js';
// Default compression options (inlined to avoid ESM re-export issue)
const DEFAULT_COMPRESSION_OPTIONS = {
  format: 'jpeg' as const,
  quality: 80,
  keepVideos: true,
  scaleImages: true,
  maxDimension: 1920,
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let db: any = null;
let saveTimeout: ReturnType<typeof setTimeout> | null = null;

export function getDb(): any {
  return db;
}

export async function initDb(): Promise<void> {
  const initSqlJs = (await import('sql.js')).default;
  const dbDir = config.dirs.db;
  fs.mkdirSync(dbDir, { recursive: true });

  const dbPath = path.join(dbDir, 'packdb.sqlite');

  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const buffer = fs.readFileSync(dbPath);
    db = new SQL.Database(buffer);
  } else {
    db = new SQL.Database();
  }

  const schema = readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  db.run(schema);

  // Run tracked migrations
  runMigrations(db);

  // Seed default preset if none exists
  const count = db.exec('SELECT COUNT(*) FROM presets');
  if (count.length > 0 && count[0].values[0][0] === 0) {
    db.run(
      'INSERT INTO presets (id, name, is_default, options) VALUES (?, ?, ?, ?)',
      [uuidv4(), '默认', 1, JSON.stringify(DEFAULT_COMPRESSION_OPTIONS)]
    );
  }

  // Periodic save to disk
  setInterval(() => saveDb(), 5000);
}

export function saveDb(): void {
  if (!db) return;
  const dbPath = path.join(config.dirs.db, 'packdb.sqlite');
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(dbPath, buffer);
}

export { db };

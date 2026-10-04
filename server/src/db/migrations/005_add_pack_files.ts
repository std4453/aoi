import type { Migration } from '~/db/migrations';

export default {
  name: '005_add_pack_files',
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS pack_files (
      id TEXT PRIMARY KEY,
      pack_id TEXT NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
      relative_path TEXT NOT NULL,
      file_size INTEGER NOT NULL,
      upload_id TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      uploaded_at TEXT
    )`);
    db.exec('CREATE INDEX IF NOT EXISTS idx_pack_files_pack_id ON pack_files(pack_id)');
  },
} satisfies Migration;

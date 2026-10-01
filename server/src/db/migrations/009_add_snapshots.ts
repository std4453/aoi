import type { Migration } from '../migrations.js';

export default {
  name: '009_add_snapshots',
  up(db) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS snapshot_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshot_manifests (
        pack_id TEXT PRIMARY KEY REFERENCES packs(id) ON DELETE CASCADE,
        manifest TEXT NOT NULL,
        signatures TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS replica_packs (
        pack_id TEXT PRIMARY KEY REFERENCES packs(id) ON DELETE CASCADE,
        manifest TEXT NOT NULL,
        root TEXT NOT NULL
      );
    `);
  },
} satisfies Migration;

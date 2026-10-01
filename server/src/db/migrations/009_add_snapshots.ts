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
        manifest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS replica_installs (
        pack_id TEXT PRIMARY KEY REFERENCES packs(id) ON DELETE CASCADE,
        manifest TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS snapshot_content_clock (
        id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO snapshot_content_clock VALUES (1, 0);
      CREATE VIEW IF NOT EXISTS pack_display_tags AS
        SELECT pt.pack_id, t.id, t.name FROM pack_tags pt JOIN tags t ON t.id = pt.tag_id
          WHERE NOT EXISTS (SELECT 1 FROM replica_packs r WHERE r.pack_id = pt.pack_id)
        UNION ALL
        SELECT r.pack_id, json_extract(t.value, '$.id'), json_extract(t.value, '$.name')
          FROM replica_packs r, json_each(r.manifest, '$.metadata.tags') t;
    `);
    // Track only the content contract and publication readiness, never cache,
    // history, progress, or snapshot bookkeeping writes. Triggers also cover
    // transactional bulk writes without relying on every caller to invalidate.
    const updates: Record<string, string> = {
      packs: 'name,original_filename,original_size,original_format,source_type,created_at,updated_at,status,image_count,video_count,total_images_size,total_videos_size',
      tags: 'name', pack_tags: 'pack_id,tag_id', jobs: 'pack_id,status',
    };
    for (const [table, columns] of Object.entries(updates)) {
      for (const event of ['INSERT', 'DELETE', 'UPDATE']) {
        const change = event === 'UPDATE'
          ? `UPDATE OF ${columns}` : event;
        const condition = event === 'UPDATE'
          ? `WHEN ${columns.split(',').map(column => `OLD.${column} IS NOT NEW.${column}`).join(' OR ')}` : '';
        db.exec(`CREATE TRIGGER IF NOT EXISTS snapshot_${table}_${event.toLowerCase()}
          AFTER ${change} ON ${table} ${condition} BEGIN
            UPDATE snapshot_content_clock SET revision = revision + 1 WHERE id = 1;
          END`);
      }
    }
  },
} satisfies Migration;

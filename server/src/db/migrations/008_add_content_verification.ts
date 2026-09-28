import { randomUUID } from 'node:crypto';
import type { Migration } from '../migrations.js';

export default {
  name: '008_add_content_verification',
  up(db) {
    db.transaction(() => {
      db.exec(`CREATE TABLE IF NOT EXISTS pack_verifications (
        pack_id TEXT PRIMARY KEY REFERENCES packs(id) ON DELETE CASCADE,
        version TEXT NOT NULL DEFAULT 'media-md5-v1',
        status TEXT NOT NULL DEFAULT 'pending',
        fingerprint TEXT,
        file_count INTEGER,
        total_bytes INTEGER,
        checked_at TEXT,
        matches TEXT,
        error TEXT,
        historical INTEGER NOT NULL DEFAULT 0,
        next_status TEXT NOT NULL DEFAULT 'thumbnailing',
        previous_error TEXT,
        approved INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_verifications_fingerprint
        ON pack_verifications(version, fingerprint) WHERE status = 'completed';`);
      const packs = db.prepare(`SELECT id, status, error_message FROM packs WHERE
        status IN ('extracted', 'generated', 'thumbnailing', 'generating')
        OR (status = 'failed' AND image_count + video_count > 0)`).all() as Array<{
          id: string; status: string; error_message: string | null;
        }>;
      const insert = db.prepare(`INSERT OR IGNORE INTO pack_verifications
        (pack_id, historical, approved, next_status, previous_error) VALUES (?, 1, 1, ?, ?)`);
      for (const pack of packs) {
        const next = pack.status === 'generating' ? 'generated' : pack.status === 'thumbnailing' ? 'extracted' : pack.status;
        if (!insert.run(pack.id, next, pack.error_message).changes) continue;
        db.prepare("INSERT INTO jobs (id, pack_id, type) VALUES (?, ?, 'verify')").run(randomUUID(), pack.id);
        if (['extracted', 'generated', 'failed'].includes(pack.status)) {
          db.prepare("UPDATE packs SET status = 'verifying' WHERE id = ?").run(pack.id);
        }
      }
    })();
  },
} satisfies Migration;

import type { Migration } from '../migrations.js';

export default {
  name: '003_add_blurhashes_and_backfill',
  up(db) {
    const result = db.exec('PRAGMA table_info(packs)');
    const colNames = result.length > 0 ? result[0].values.map((r: any[]) => r[1]) : [];
    if (!colNames.includes('blurhashes')) {
      db.run('ALTER TABLE packs ADD COLUMN blurhashes TEXT DEFAULT NULL');
    }
    // Re-enqueue thumbnail generation for existing packs so blurhashes are computed.
    // After thumbnail job completes, packs become 'extracted'.
    db.run("UPDATE packs SET status = 'thumbnailing' WHERE status IN ('extracted', 'generated')");
  },
} satisfies Migration;

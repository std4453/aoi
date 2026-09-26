import type { Migration } from '../migrations.js';

export default {
  name: '003_add_blurhashes_and_backfill',
  up(db) {
    const colNames = (db.pragma('table_info(packs)') as Array<{ name: string }>).map(row => row.name);
    if (!colNames.includes('blurhashes')) {
      db.exec('ALTER TABLE packs ADD COLUMN blurhashes TEXT DEFAULT NULL');
    }
    // Re-enqueue thumbnail generation for existing packs so blurhashes are computed.
    // After thumbnail job completes, packs become 'extracted'.
    db.exec("UPDATE packs SET status = 'thumbnailing' WHERE status IN ('extracted', 'generated')");
  },
} satisfies Migration;

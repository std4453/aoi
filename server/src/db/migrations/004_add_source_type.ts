import type { Migration } from '../migrations.js';

export default {
  name: '004_add_source_type',
  up(db) {
    const result = db.exec('PRAGMA table_info(packs)');
    const colNames = result.length > 0 ? result[0].values.map((r: any[]) => r[1]) : [];
    if (!colNames.includes('source_type')) {
      db.run("ALTER TABLE packs ADD COLUMN source_type TEXT NOT NULL DEFAULT 'archive'");
    }
  },
} satisfies Migration;

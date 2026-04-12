import type { Migration } from '../migrations.js';

export default {
  name: '002_add_structure_type',
  up(db) {
    const result = db.exec('PRAGMA table_info(packs)');
    const colNames = result.length > 0 ? result[0].values.map((r: any[]) => r[1]) : [];
    if (!colNames.includes('structure_type')) {
      db.run("ALTER TABLE packs ADD COLUMN structure_type TEXT DEFAULT 'flat'");
    }
  },
} satisfies Migration;

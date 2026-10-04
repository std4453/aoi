import type { Migration } from '~/db/migrations';

export default {
  name: '002_add_structure_type',
  up(db) {
    const colNames = (db.pragma('table_info(packs)') as Array<{ name: string }>).map(row => row.name);
    if (!colNames.includes('structure_type')) {
      db.exec("ALTER TABLE packs ADD COLUMN structure_type TEXT DEFAULT 'flat'");
    }
  },
} satisfies Migration;

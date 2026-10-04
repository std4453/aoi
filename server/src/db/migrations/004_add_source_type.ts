import type { Migration } from '~/db/migrations';

export default {
  name: '004_add_source_type',
  up(db) {
    const colNames = (db.pragma('table_info(packs)') as Array<{ name: string }>).map(row => row.name);
    if (!colNames.includes('source_type')) {
      db.exec("ALTER TABLE packs ADD COLUMN source_type TEXT NOT NULL DEFAULT 'archive'");
    }
  },
} satisfies Migration;

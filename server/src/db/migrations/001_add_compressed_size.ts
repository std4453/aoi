import type { Migration } from '~/db/migrations';

export default {
  name: '001_add_compressed_size',
  up(db) {
    const colNames = (db.pragma('table_info(packs)') as Array<{ name: string }>).map(row => row.name);
    if (!colNames.includes('compressed_size')) {
      db.exec('ALTER TABLE packs ADD COLUMN compressed_size INTEGER DEFAULT 0');
    }
  },
} satisfies Migration;

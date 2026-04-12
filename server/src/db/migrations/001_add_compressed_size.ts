import type { Migration } from '../migrations.js';

export default {
  name: '001_add_compressed_size',
  up(db) {
    const result = db.exec('PRAGMA table_info(packs)');
    const colNames = result.length > 0 ? result[0].values.map((r: any[]) => r[1]) : [];
    if (!colNames.includes('compressed_size')) {
      db.run('ALTER TABLE packs ADD COLUMN compressed_size INTEGER DEFAULT 0');
    }
  },
} satisfies Migration;

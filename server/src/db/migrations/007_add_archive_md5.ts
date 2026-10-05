import type { Migration } from '~/db/migrations';

export default {
  name: '007_add_archive_md5',
  up(db) {
    const columns = db.pragma('table_info(packs)') as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'archive_md5')) {
      db.exec('ALTER TABLE packs ADD COLUMN archive_md5 TEXT');
    }
    db.exec('CREATE INDEX IF NOT EXISTS idx_packs_archive_md5 ON packs(archive_md5)');
  },
} satisfies Migration;

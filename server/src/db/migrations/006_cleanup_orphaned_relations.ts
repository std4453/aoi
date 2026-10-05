import type { Migration } from '~/db/migrations';

export default {
  name: '006_cleanup_orphaned_relations',
  up(db) {
    db.exec(`
      DELETE FROM jobs WHERE pack_id NOT IN (SELECT id FROM packs);
      DELETE FROM pack_tags
        WHERE pack_id NOT IN (SELECT id FROM packs)
           OR tag_id NOT IN (SELECT id FROM tags);
      DELETE FROM pack_files WHERE pack_id NOT IN (SELECT id FROM packs);
    `);
  },
} satisfies Migration;

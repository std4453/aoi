import type { Migration } from '~/db/migrations';

export default {
  name: '010_add_upload_tasks',
  up(db) {
    db.exec(`CREATE TABLE IF NOT EXISTS upload_tasks (
      id TEXT PRIMARY KEY,
      task TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}'
    )`);
  },
} satisfies Migration;

import type { Migration } from '../migrations.js';

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

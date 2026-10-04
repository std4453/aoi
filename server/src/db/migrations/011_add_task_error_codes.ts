import type { Migration } from '~/db/migrations';

export default {
  name: '011_add_task_error_codes',
  up(db) {
    const columns = db.pragma('table_info(jobs)') as Array<{ name: string }>;
    if (!columns.some(column => column.name === 'error_code')) db.exec('ALTER TABLE jobs ADD COLUMN error_code TEXT');
  },
} satisfies Migration;

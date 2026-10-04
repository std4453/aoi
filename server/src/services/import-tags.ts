import { getDb } from '~/db/connection';
import { createTag, listTags } from '~/db/repositories';
import type { Tag } from '~/types';

export function ensureImportTags(names: string[]): Tag[] {
  return getDb().transaction(() => {
    const existing = new Map(listTags().map(tag => [tag.name, tag]));
    const safe = [...new Set(names.map(name => name.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 200)).filter(Boolean))].slice(0, 1000);
    return safe.map(name => existing.get(name) ?? createTag(name));
  })();
}

import { v4 as uuidv4 } from 'uuid';
import { getDb, saveDb } from './connection.js';
import type { Pack, PackStatus, Preset, Job, CompressionOptions, Tag, PaginatedResponse, PackListParams } from '../types.js';

function queryOne(sql: string, params?: any[]): any | null {
  const db = getDb();
  const stmt = db.prepare(sql);
  const safeParams = params?.map(p => (p === undefined ? null : p));
  if (safeParams) stmt.bind(safeParams);
  if (stmt.step()) {
    const row = stmt.getAsObject();
    stmt.free();
    return row;
  }
  stmt.free();
  return null;
}

function queryAll(sql: string, params?: any[]): any[] {
  const db = getDb();
  const stmt = db.prepare(sql);
  const safeParams = params?.map(p => (p === undefined ? null : p));
  if (safeParams) stmt.bind(safeParams);
  const rows: any[] = [];
  while (stmt.step()) {
    rows.push(stmt.getAsObject());
  }
  stmt.free();
  return rows;
}

function run(sql: string, params?: any[]): void {
  const db = getDb();
  // sql.js rejects undefined bind values — replace with null
  const safeParams = params?.map(p => (p === undefined ? null : p));
  if (safeParams) {
    db.run(sql, safeParams);
  } else {
    db.run(sql);
  }
  // Trigger async save (debounced)
  if (typeof saveDb === 'function') {
    setTimeout(saveDb, 1000);
  }
}

// --- Packs ---

function rowToPack(row: any, tags?: Tag[]): Pack {
  return {
    id: row.id,
    name: row.name,
    originalFilename: row.original_filename,
    originalSize: row.original_size,
    originalFormat: row.original_format,
    status: row.status,
    imageCount: row.image_count ?? 0,
    videoCount: row.video_count ?? 0,
    totalImagesSize: row.total_images_size ?? 0,
    totalVideosSize: row.total_videos_size ?? 0,
    errorMessage: row.error_message ?? null,
    archivePassword: row.archive_password ?? null,
    compressedSize: row.compressed_size ?? 0,
    tags: tags ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// --- Tags ---

export function createTag(name: string): Tag {
  const id = uuidv4();
  run('INSERT INTO tags (id, name) VALUES (?, ?)', [id, name]);
  return getTag(id)!;
}

export function getTag(id: string): Tag | undefined {
  const row = queryOne('SELECT * FROM tags WHERE id = ?', [id]);
  if (!row) return undefined;
  return { id: row.id, name: row.name };
}

export function listTags(): Tag[] {
  return queryAll('SELECT * FROM tags ORDER BY name').map(row => ({
    id: row.id,
    name: row.name,
  }));
}

export function renameTag(id: string, newName: string): Tag | undefined {
  run("UPDATE tags SET name = ? WHERE id = ?", [newName, id]);
  return getTag(id);
}

export function deleteTag(id: string): void {
  run('DELETE FROM pack_tags WHERE tag_id = ?', [id]);
  run('DELETE FROM tags WHERE id = ?', [id]);
}

export function setPackTags(packId: string, tagIds: string[]): void {
  run('DELETE FROM pack_tags WHERE pack_id = ?', [packId]);
  for (const tagId of tagIds) {
    run('INSERT OR IGNORE INTO pack_tags (pack_id, tag_id) VALUES (?, ?)', [packId, tagId]);
  }
}

export function getPackTags(packId: string): Tag[] {
  const rows = queryAll(
    'SELECT t.id, t.name FROM pack_tags pt JOIN tags t ON pt.tag_id = t.id WHERE pt.pack_id = ? ORDER BY t.name',
    [packId]
  );
  return rows.map(row => ({ id: row.id, name: row.name }));
}

export function createPack(data: {
  name: string;
  originalFilename: string;
  originalSize: number;
  originalFormat: string;
  archivePassword?: string;
}): Pack {
  const id = uuidv4();
  run(
    'INSERT INTO packs (id, name, original_filename, original_size, original_format, archive_password) VALUES (?, ?, ?, ?, ?, ?)',
    [id, data.name, data.originalFilename, data.originalSize, data.originalFormat, data.archivePassword ?? null]
  );
  return getPack(id)!;
}

export function getPack(id: string): Pack | undefined {
  const row = queryOne('SELECT * FROM packs WHERE id = ?', [id]);
  if (!row) return undefined;
  const tags = getPackTags(id);
  return rowToPack(row, tags);
}

export function listPacks(): Pack[] {
  const rows = queryAll('SELECT * FROM packs ORDER BY created_at DESC');
  // Batch load all tags for efficiency
  const allTags = rows.length > 0
    ? queryAll('SELECT pt.pack_id, t.id, t.name FROM pack_tags pt JOIN tags t ON pt.tag_id = t.id')
    : [];
  const tagMap = new Map<string, Tag[]>();
  for (const row of allTags) {
    if (!tagMap.has(row.pack_id)) tagMap.set(row.pack_id, []);
    tagMap.get(row.pack_id)!.push({ id: row.id, name: row.name });
  }
  return rows.map(row => rowToPack(row, tagMap.get(row.id) ?? []));
}

export function listPacksPaginated(params: PackListParams): PaginatedResponse<Pack> {
  const page = Math.max(1, params.page ?? 1);
  const pageSize = Math.max(1, Math.min(100, params.pageSize ?? 20));
  const search = params.search?.trim() ?? '';
  const keywords = search.split(/\s+/).filter(Boolean);

  let whereClause = '';
  const whereParams: string[] = [];
  if (keywords.length > 0) {
    const conditions: string[] = [];
    for (const kw of keywords) {
      conditions.push('p.name LIKE ?');
      whereParams.push(`%${kw}%`);
      conditions.push('t.name LIKE ?');
      whereParams.push(`%${kw}%`);
    }
    whereClause = 'WHERE ' + conditions.join(' OR ');
  }

  // Count query
  const countSql = keywords.length > 0
    ? `SELECT COUNT(DISTINCT p.id) as cnt FROM packs p LEFT JOIN pack_tags pt ON pt.pack_id = p.id LEFT JOIN tags t ON pt.tag_id = t.id ${whereClause}`
    : 'SELECT COUNT(*) as cnt FROM packs p';
  const countRow = queryOne(countSql, whereParams.length > 0 ? whereParams : undefined);
  const total = (countRow?.cnt as number) ?? 0;

  // Data query
  const offset = (page - 1) * pageSize;
  const dataSql = keywords.length > 0
    ? `SELECT p.* FROM packs p LEFT JOIN pack_tags pt ON pt.pack_id = p.id LEFT JOIN tags t ON pt.tag_id = t.id ${whereClause} GROUP BY p.id ORDER BY p.created_at DESC LIMIT ? OFFSET ?`
    : 'SELECT * FROM packs p ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
  const dataParams = keywords.length > 0
    ? [...whereParams, pageSize, offset]
    : [pageSize, offset];
  const rows = queryAll(dataSql, dataParams);

  // Batch load tags for returned pack IDs only
  const packIds = rows.map(r => r.id as string);
  const tagPlaceholders = packIds.map(() => '?').join(',');
  const allTags = packIds.length > 0
    ? queryAll(`SELECT pt.pack_id, t.id, t.name FROM pack_tags pt JOIN tags t ON pt.tag_id = t.id WHERE pt.pack_id IN (${tagPlaceholders})`, packIds)
    : [];
  const tagMap = new Map<string, Tag[]>();
  for (const row of allTags) {
    if (!tagMap.has(row.pack_id)) tagMap.set(row.pack_id, []);
    tagMap.get(row.pack_id)!.push({ id: row.id, name: row.name });
  }

  return {
    items: rows.map(row => rowToPack(row, tagMap.get(row.id as string) ?? [])),
    total,
    page,
    pageSize,
  };
}

export function updatePackStatus(id: string, status: PackStatus, errorMessage?: string): void {
  run(
    "UPDATE packs SET status = ?, error_message = ?, updated_at = datetime('now') WHERE id = ?",
    [status, errorMessage ?? null, id]
  );
}

export function updatePackStats(
  id: string,
  stats: { imageCount: number; videoCount: number; totalImagesSize: number; totalVideosSize: number }
): void {
  run(
    "UPDATE packs SET image_count = ?, video_count = ?, total_images_size = ?, total_videos_size = ?, updated_at = datetime('now') WHERE id = ?",
    [stats.imageCount, stats.videoCount, stats.totalImagesSize, stats.totalVideosSize, id]
  );
}

export function updatePackCompressedSize(id: string, size: number): void {
  run(
    "UPDATE packs SET compressed_size = ?, updated_at = datetime('now') WHERE id = ?",
    [size, id]
  );
}

export type BlurhashEntry = { hash: string; width: number; height: number };

export function updatePackBlurhashes(id: string, blurhashes: Record<string, BlurhashEntry>): void {
  run("UPDATE packs SET blurhashes = ?, updated_at = datetime('now') WHERE id = ?", [JSON.stringify(blurhashes), id]);
}

export function getPackBlurhashes(id: string): Record<string, BlurhashEntry> {
  const row = queryOne('SELECT blurhashes FROM packs WHERE id = ?', [id]);
  if (!row || !row.blurhashes) return {};
  try {
    return JSON.parse(row.blurhashes);
  } catch {
    return {};
  }
}

export function deletePack(id: string): void {
  run('DELETE FROM jobs WHERE pack_id = ?', [id]);
  run('DELETE FROM packs WHERE id = ?', [id]);
}

export function renamePack(id: string, newName: string): Pack | undefined {
  run("UPDATE packs SET name = ?, updated_at = datetime('now') WHERE id = ?", [newName, id]);
  return getPack(id);
}

// --- Presets ---

export function createPreset(name: string, options: CompressionOptions, isDefault = false): Preset {
  const id = uuidv4();
  if (isDefault) {
    run('UPDATE presets SET is_default = 0 WHERE is_default = 1');
  }
  run('INSERT INTO presets (id, name, is_default, options) VALUES (?, ?, ?, ?)', [
    id,
    name,
    isDefault ? 1 : 0,
    JSON.stringify(options),
  ]);
  return getPreset(id)!;
}

export function getPreset(id: string): Preset | undefined {
  const row = queryOne('SELECT * FROM presets WHERE id = ?', [id]);
  if (!row) return undefined;
  return { ...row, options: JSON.parse(row.options), isDefault: row.is_default === 1 };
}

export function listPresets(): Preset[] {
  return queryAll('SELECT * FROM presets ORDER BY is_default DESC, created_at ASC').map((row) => ({
    ...row,
    options: JSON.parse(row.options),
    isDefault: row.is_default === 1,
  }));
}

export function updatePreset(id: string, name: string, options: CompressionOptions): Preset | undefined {
  run("UPDATE presets SET name = ?, options = ?, updated_at = datetime('now') WHERE id = ?", [
    id,
    name,
    JSON.stringify(options),
    id,
  ]);
  return getPreset(id);
}

export function deletePreset(id: string): void {
  run('DELETE FROM presets WHERE id = ?', [id]);
}

export function setDefaultPreset(id: string): void {
  run('UPDATE presets SET is_default = 0 WHERE is_default = 1');
  run("UPDATE presets SET is_default = 1, updated_at = datetime('now') WHERE id = ?", [id]);
}

export function getDefaultPreset(): Preset | undefined {
  const row = queryOne('SELECT * FROM presets WHERE is_default = 1 LIMIT 1');
  if (!row) return undefined;
  return { ...row, options: JSON.parse(row.options), isDefault: row.is_default === 1 };
}

// --- Jobs ---

export function createJob(packId: string, type: Job['type'], options?: CompressionOptions): Job {
  const id = uuidv4();
  run('INSERT INTO jobs (id, pack_id, type, options) VALUES (?, ?, ?, ?)', [
    id,
    packId,
    type,
    options ? JSON.stringify(options) : null,
  ]);
  return getJob(id)!;
}

export function getJob(id: string): Job | undefined {
  const row = queryOne('SELECT * FROM jobs WHERE id = ?', [id]);
  if (!row) return undefined;
  return rowToJob(row);
}

export function updateJobStatus(id: string, status: Job['status'], progress?: number, error?: string): void {
  if (status === 'running') {
    run("UPDATE jobs SET status = ?, progress = ?, started_at = datetime('now') WHERE id = ?", [
      status,
      progress ?? 0,
      id,
    ]);
  } else if (status === 'completed' || status === 'failed') {
    run(
      "UPDATE jobs SET status = ?, progress = ?, error = ?, completed_at = datetime('now') WHERE id = ?",
      [status, progress ?? 0, error ?? null, id]
    );
  } else {
    run('UPDATE jobs SET status = ?, progress = ? WHERE id = ?', [status, progress ?? 0, id]);
  }
}

export function updateJobResult(id: string, result: object): void {
  run('UPDATE jobs SET result = ? WHERE id = ?', [JSON.stringify(result), id]);
}

export function getNextPendingJob(): Job | undefined {
  const row = queryOne("SELECT * FROM jobs WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1");
  if (!row) return undefined;
  return rowToJob(row);
}

// --- Uploads ---

function rowToJob(row: any): Job {
  return {
    ...row,
    packId: row.pack_id,
    createdAt: row.created_at,
    startedAt: row.started_at ?? null,
    completedAt: row.completed_at ?? null,
  } as Job;
}

export function createUpload(id: string, filename: string, fileSize: number): void {
  run('INSERT INTO uploads (id, filename, file_size) VALUES (?, ?, ?)', [id, filename, fileSize]);
}

export function completeUpload(id: string, packId: string): void {
  run("UPDATE uploads SET pack_id = ?, status = 'completed', completed_at = datetime('now') WHERE id = ?", [
    packId,
    id,
  ]);
}

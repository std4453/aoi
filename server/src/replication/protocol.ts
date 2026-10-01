import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { normalizeRelativePath, resolveWithin, validateIdentifier } from '../services/safe-path.js';
import { dataScope, protocolVersion } from '../version.js';
import { snapshotFence, assertSnapshotFence } from './state.js';

const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const objectSchema = z.object({ hash: hashSchema, size: z.number().int().nonnegative().safe() }).strict();
export const manifestSchema = z.object({
  protocol: z.literal(protocolVersion, { errorMap: () => ({ message: `Replication protocol mismatch: expected ${protocolVersion}` }) }),
  scope: z.literal(dataScope),
  generation: z.string().uuid(),
  createdAt: z.string().datetime(),
  catalog: objectSchema,
  files: z.array(objectSchema.extend({ path: z.string() }).strict()).max(1_000_000),
}).strict();
export type Manifest = z.infer<typeof manifestSchema>;
export type BlobInfo = z.infer<typeof objectSchema>;
export const contentRoots = ['archives', 'extracted', 'generated', 'thumbnails'] as const;

// Required catalog columns, checked before activating a replica. The explicit
// export projections and row filters live in catalog.sql.
export const columns: Record<string, string[]> = {
  packs: 'id name original_filename original_size original_format status image_count video_count total_images_size total_videos_size error_message compressed_size created_at updated_at structure_type blurhashes source_type archive_md5'.split(' '),
  presets: 'id name is_default options created_at updated_at'.split(' '),
  tags: 'id name created_at'.split(' '),
  pack_tags: 'pack_id tag_id'.split(' '),
  pack_verifications: 'pack_id version status fingerprint file_count total_bytes checked_at error historical next_status previous_error approved'.split(' '),
  migrations: 'name executed_at'.split(' '),
};
const emptyTables = ['jobs', 'uploads', 'pack_files'];
const catalogSql = fs.readFileSync(new URL('./catalog.sql', import.meta.url), 'utf8');

export function validateManifest(value: unknown): Manifest {
  const manifest = manifestSchema.parse(value);
  const paths = new Set<string>();
  const hashes = new Map<string, number>();
  for (const file of manifest.files) {
    const normalized = normalizeRelativePath(file.path);
    const [root, packId, ...rest] = normalized.split('/');
    if (normalized !== file.path || !contentRoots.includes(root as typeof contentRoots[number]) || !rest.length) {
      throw new Error('Invalid replicated file path');
    }
    validateIdentifier(packId, 'replicated pack id');
    if (paths.has(normalized)) throw new Error('Duplicate replicated file path');
    paths.add(normalized);
    if (hashes.has(file.hash) && hashes.get(file.hash) !== file.size) throw new Error('Conflicting blob sizes');
    hashes.set(file.hash, file.size);
  }
  return manifest;
}

export async function hashFile(filename: string, signal?: AbortSignal): Promise<BlobInfo> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(filename, { signal })) {
    hash.update(chunk);
    size += chunk.length;
  }
  return { hash: hash.digest('hex'), size };
}

export async function durableFile(filename: string): Promise<void> {
  const fd = await fs.promises.open(filename, 'r');
  try { await fd.sync(); } finally { await fd.close(); }
}
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    : item);
}

export function durableJson(filename: string, value: unknown): void {
  const temp = `${filename}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try {
    fs.writeFileSync(fd, canonicalJson(value));
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temp, filename);
  const dir = fs.openSync(path.dirname(filename), 'r');
  try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
}

export function exportCatalog(source: Database.Database, target: string): string[] {
  const dest = new Database(target);
  try {
    dest.pragma('foreign_keys = ON');
    // Attach only the private backup; catalog.sql reads source and writes main.
    dest.prepare('ATTACH DATABASE ? AS source').run(source.name);
    dest.transaction(() => {
      for (const table of [...Object.keys(columns), ...emptyTables]) {
        const schema = source.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(table) as { sql: string };
        if (!schema) throw new Error(`Missing content schema: ${table}`);
        dest.exec(schema.sql);
      }
      dest.exec(catalogSql);
    })();
    if ((dest.pragma('foreign_key_check') as unknown[]).length) throw new Error('Export foreign key check failed');
    return (dest.prepare('SELECT id FROM packs ORDER BY id').all() as Array<{ id: string }>).map(row => row.id);
  } finally { dest.close(); }
}

async function copyBlob(source: string, blobs: string, signal?: AbortSignal): Promise<BlobInfo> {
  const temp = path.join(blobs, `${randomUUID()}.tmp`);
  const hash = createHash('sha256');
  let size = 0;
  try {
    await pipeline(fs.createReadStream(source), new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        hash.update(chunk);
        size += chunk.length;
        callback(null, chunk);
      },
    }), fs.createWriteStream(temp, { flags: 'wx', mode: 0o600 }), { signal });
    const info = { hash: hash.digest('hex'), size };
    const target = path.join(blobs, info.hash);
    await durableFile(temp);
    if (fs.existsSync(target)) await fs.promises.unlink(temp);
    else await fs.promises.rename(temp, target);
    return info;
  } catch (error) {
    await fs.promises.rm(temp, { force: true });
    throw error;
  }
}

export async function createSnapshot(database: Database.Database, dataDir: string, directory: string, signal?: AbortSignal): Promise<Manifest> {
  signal?.throwIfAborted();
  const fence = snapshotFence();
  if (database.prepare("SELECT 1 FROM jobs WHERE status IN ('pending','running') LIMIT 1").get()) {
    throw new Error('Snapshot deferred: background jobs are pending');
  }
  const changes = () => (database.prepare('SELECT total_changes() AS n').get() as { n: number }).n;
  const initialChanges = changes();
  await fs.promises.mkdir(directory, { recursive: true, mode: 0o700 });
  const blobs = path.join(directory, 'blobs');
  await fs.promises.mkdir(blobs, { recursive: true });
  const sourcePath = path.join(directory, 'source.sqlite');
  const catalogPath = path.join(directory, 'catalog.sqlite');
  await database.backup(sourcePath);
  const source = new Database(sourcePath, { readonly: true });
  let ids: string[];
  try { ids = exportCatalog(source, catalogPath); } finally { source.close(); }
  await fs.promises.unlink(sourcePath);
  const files: Manifest['files'] = [];
  async function walk(relative: string): Promise<void> {
    signal?.throwIfAborted();
    const full = resolveWithin(dataDir, relative);
    for (const entry of await fs.promises.readdir(full, { withFileTypes: true })) {
      if (['_staging', 'temp'].includes(entry.name) || entry.name.endsWith('.tmp')) continue;
      const child = `${relative}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error('Symlinks are not supported in replicated data');
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) files.push({ path: child, ...await copyBlob(resolveWithin(dataDir, child), blobs, signal) });
      else throw new Error('Unsupported replicated file type');
    }
  }
  for (const id of ids) {
    validateIdentifier(id);
    for (const root of contentRoots) {
      const relative = `${root}/${id}`;
      signal?.throwIfAborted();
    const full = resolveWithin(dataDir, relative);
      if (fs.existsSync(full)) {
        if (!(await fs.promises.lstat(full)).isDirectory()) throw new Error('Invalid pack directory');
        await walk(relative);
      }
    }
  }
  assertSnapshotFence(fence);
  if (changes() !== initialChanges) throw new Error('Snapshot deferred: database changed during export');
  await durableFile(catalogPath);
  const manifest: Manifest = {
    protocol: protocolVersion, scope: dataScope,
    generation: randomUUID(), createdAt: new Date().toISOString(),
    catalog: await hashFile(catalogPath, signal), files: files.sort((a, b) => a.path.localeCompare(b.path)),
  };
  validateManifest(manifest);
  durableJson(path.join(directory, 'manifest.json'), manifest);
  return manifest;
}

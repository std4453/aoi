import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { normalizeRelativePath, validateIdentifier, resolveWithin } from '../services/safe-path.js';
import { protocolVersion, dataScope } from '../version.js';
import type { PackSnapshot, PackSnapshotIndex } from '../../../shared/types.js';
import type { StoredPack } from '../db/repositories.js';

const id = z.string().refine(value => { try { validateIdentifier(value); return true; } catch { return false; } });
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const size = z.number().int().nonnegative().safe();
const metadata = z.object({
  id, name: z.string().min(1).max(200), originalFilename: z.string().max(255),
  originalSize: size, originalFormat: z.string().max(32), sourceType: z.enum(['archive', 'folder']),
  createdAt: z.string().max(100), updatedAt: z.string().max(100),
  tags: z.array(z.object({ id, name: z.string().min(1).max(200) }).strict()).max(1000),
}).strict();
const contract = {
  protocol: z.literal(protocolVersion, { errorMap: () => ({ message: 'Snapshot protocol mismatch' }) }),
  scope: z.literal(dataScope),
};
export const manifestSchema = z.object({
  ...contract, metadata, contentHash: hash, revision: hash,
  files: z.array(z.object({ path: z.string(), hash, size }).strict()).max(100_000),
}).strict();
export const indexSchema = z.object({
  ...contract, datasetId: z.string().uuid(),
  packs: z.array(z.discriminatedUnion('state', [
    z.object({ id, state: z.literal('ready'), revision: hash }).strict(),
    z.object({ id, state: z.literal('pending') }).strict(),
  ])).max(1_000_000),
}).strict();
export type Manifest = PackSnapshot;
export type SnapshotIndex = PackSnapshotIndex;
export type FileInfo = Manifest['files'][number];
export const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => compare(a, b))) : item);
}
export const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
export async function hashFile(filename: string, signal?: AbortSignal): Promise<{ hash: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(filename, { signal })) { hash.update(chunk); size += chunk.length; }
  return { hash: hash.digest('hex'), size };
}
export async function durableFile(filename: string): Promise<void> {
  const fd = await fs.promises.open(filename, 'r');
  try { await fd.sync(); } finally { await fd.close(); }
}
export async function syncTree(directory: string): Promise<void> {
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await syncTree(path.join(directory, entry.name));
  }
  await durableFile(directory);
}
export function packMetadata(pack: StoredPack): Manifest['metadata'] {
  return { id: pack.id, name: pack.name, originalFilename: pack.originalFilename,
    originalSize: pack.originalSize, originalFormat: pack.originalFormat, sourceType: pack.sourceType,
    createdAt: pack.createdAt, updatedAt: pack.updatedAt, tags: [...pack.tags].sort((a, b) => compare(a.id, b.id)) };
}
export function makeManifest(pack: StoredPack, files: FileInfo[]): Manifest {
  files = [...files].sort((a, b) => compare(a.path, b.path));
  const content = { ...contractValues(), metadata: packMetadata(pack), contentHash: digest(files), files };
  return validateManifest({ ...content, revision: digest(content) });
}
export const contractValues = () => ({ protocol: protocolVersion, scope: dataScope } as const);
export function validateManifest(value: unknown): Manifest {
  const result = manifestSchema.parse(value);
  const paths = new Set<string>();
  const hashes = new Map<string, number>();
  for (const file of result.files) {
    if (normalizeRelativePath(file.path) !== file.path || !/^(images|videos)\/.+/.test(file.path)) throw new Error('Invalid snapshot path');
    if (paths.has(file.path)) throw new Error('Duplicate snapshot path');
    paths.add(file.path);
    if (hashes.has(file.hash) && hashes.get(file.hash) !== file.size) throw new Error('Conflicting blob sizes');
    hashes.set(file.hash, file.size);
  }
  for (const name of paths) {
    const parts = name.split('/'); parts.pop();
    while (parts.length > 1) {
      if (paths.has(parts.join('/'))) throw new Error('Conflicting snapshot paths');
      parts.pop();
    }
  }
  if (new Set(result.metadata.tags.map(tag => tag.id)).size !== result.metadata.tags.length) throw new Error('Duplicate tags');
  if (digest([...result.files].sort((a, b) => compare(a.path, b.path))) !== result.contentHash) throw new Error('Content checksum mismatch');
  const { revision, ...content } = result;
  if (digest(content) !== revision) throw new Error('Manifest checksum mismatch');
  return result;
}
export function validateIndex(value: unknown): SnapshotIndex {
  const result = indexSchema.parse(value);
  if (new Set(result.packs.map(pack => pack.id)).size !== result.packs.length) throw new Error('Duplicate pack identifiers');
  return result;
}
export function manifestPack(manifest: Manifest): StoredPack {
  const images = manifest.files.filter(file => file.path.startsWith('images/'));
  const videos = manifest.files.filter(file => file.path.startsWith('videos/'));
  return { ...manifest.metadata, status: 'extracted', archivePassword: null, errorMessage: null, compressedSize: 0,
    imageCount: images.length, videoCount: videos.length,
    totalImagesSize: images.reduce((n, file) => n + file.size, 0), totalVideosSize: videos.reduce((n, file) => n + file.size, 0) };
}
// lstat every component: resolveWithin alone does not reject symlink traversal.
export async function safeContentFile(root: string, relative: string): Promise<string> {
  const full = resolveWithin(root, relative);
  const rootStat = await fs.promises.lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error('Invalid content root');
  let current = root;
  const parts = normalizeRelativePath(relative).split('/');
  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    const stat = await fs.promises.lstat(current);
    if (stat.isSymbolicLink() || (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) throw new Error('Invalid content file');
  }
  return full;
}

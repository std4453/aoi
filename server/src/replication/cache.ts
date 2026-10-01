import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pLimit from 'p-limit';
import { buildJpegOutputPaths } from '../services/jpeg-output-path.js';
import { generateThumbnail, generateCover, computeBlurhash } from '../services/thumbnail-generator.js';
import { resolveWithin } from '../services/safe-path.js';
import { getActiveVersion, pinVersion, readContext, type ReadVersion } from './state.js';

const limit = pLimit(2);
const pending = new Map<string, Promise<void>>();
const warming = new Map<string, Promise<void>>();
export const cacheRoot = (version: ReadVersion) => path.join(version.root, 'cache-v1');
export function imagePaths(version: ReadVersion): Map<string, string> {
  const root = path.join(version.root, 'extracted', version.pack.id, 'images');
  const names: string[] = [];
  const walk = (dir: string, prefix = '') => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix + entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${relative}/`);
      else if (entry.isFile()) names.push(relative);
    }
  };
  walk(root);
  return new Map([...buildJpegOutputPaths(names)].map(([original, thumb]) => [thumb, resolveWithin(root, original)]));
}
export async function cachedImage(version: ReadVersion, relative: string, cover = false): Promise<string | undefined> {
  const paths = imagePaths(version);
  const input = cover ? [...paths.values()].sort()[0] : paths.get(relative);
  if (!input) return undefined;
  const output = cover ? path.join(cacheRoot(version), 'covers', version.pack.id, '_cover.jpg')
    : resolveWithin(path.join(cacheRoot(version), 'thumbnails'), relative);
  if (fs.existsSync(output)) return output;
  let job = pending.get(output);
  if (!job) {
    const release = pinVersion(version);
    job = limit(async () => {
      const temp = `${output}.${randomUUID()}.tmp`;
      try {
        await fs.promises.mkdir(path.dirname(output), { recursive: true });
        await (cover ? generateCover(input, temp) : generateThumbnail(input, temp));
        await fs.promises.rename(temp, output);
      } finally { await fs.promises.rm(temp, { force: true }); }
    }).finally(() => { release(); pending.delete(output); });
    pending.set(output, job);
  }
  try { await job; return output; } catch { return input; }
}
export function warmCache(version: ReadVersion): void {
  if (warming.has(version.root) || fs.existsSync(path.join(cacheRoot(version), 'blurhashes.json'))) return;
  const release = pinVersion(version);
  const job = (async () => {
    const values: Record<string, unknown> = {};
    for (const [relative, input] of imagePaths(version)) {
      await cachedImage(version, relative);
      values[relative] = await limit(() => computeBlurhash(input));
    }
    await cachedImage(version, '', true);
    await fs.promises.mkdir(cacheRoot(version), { recursive: true });
    const target = path.join(cacheRoot(version), 'blurhashes.json');
    const temp = `${target}.${randomUUID()}.tmp`;
    await fs.promises.writeFile(temp, JSON.stringify(values)); await fs.promises.rename(temp, target);
  })().catch(() => {}).finally(() => { release(); warming.delete(version.root); });
  warming.set(version.root, job);
}
export async function drainCaches(): Promise<void> { await Promise.all([...warming.values(), ...pending.values()].map(job => job.catch(() => {}))); }
export const requestVersion = (id: string) => readContext.getStore() ?? getActiveVersion(id);

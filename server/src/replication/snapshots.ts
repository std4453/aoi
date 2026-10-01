import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { contentRevision, initializeDataset, readManifestCache, saveManifestCache, sourceView } from '../db/snapshot-repository.js';
import { getPack, hasAnyActiveJob } from '../db/repositories.js';
import { resolveWithin } from '../services/safe-path.js';
import { snapshotFence, assertSnapshotFence } from './state.js';
import { canonicalJson, compare, contractValues, hashFile, makeManifest, packMetadata, safeContentFile, type Manifest, type SnapshotIndex, type FileInfo } from './protocol.js';

const published = new Map<string, Manifest>();
const signaturesByPack = new Map<string, Record<string, string>>();
export const cachedManifest = (id: string) => published.get(id);
export const cachedSignature = (id: string, relative: string) => signaturesByPack.get(id)?.[relative];
export class SnapshotPublisher {
  private checked = new Set<string>();
  private lastChanges = -1;
  private lastFence = -1;
  private forceHash = true;
  entry(id: string): SnapshotIndex['packs'][number] | undefined {
    const pack = getPack(id);
    if (!pack) return undefined;
    const busy = hasAnyActiveJob(id);
    const manifest = cachedManifest(id);
    return this.checked.has(id) && !busy && ['extracted', 'generated'].includes(pack.status) && manifest && canonicalJson(packMetadata(pack)) === canonicalJson(manifest.metadata)
      ? { id, state: 'ready', revision: manifest.revision } : { id, state: 'pending' };
  }
  index(): SnapshotIndex {
    const { packs, busy, datasetId } = sourceView();
    packs.sort((a, b) => compare(a.id, b.id));
    return { ...contractValues(), datasetId, packs: packs.map(pack => {
        const manifest = this.checked.has(pack.id) && !busy.has(pack.id) && ['extracted', 'generated'].includes(pack.status) ? cachedManifest(pack.id) : undefined;
        // Metadata changes are also made visible as pending until rebuilt.
        if (manifest && canonicalJson(packMetadata(pack)) === canonicalJson(manifest.metadata)) return { id: pack.id, state: 'ready' as const, revision: manifest.revision };
        return { id: pack.id, state: 'pending' as const };
      }) };
  }
  initialize(): void { initializeDataset(); }
  async run(signal: AbortSignal): Promise<void> {
    const changes = contentRevision;
    const fence = snapshotFence();
    if (changes() === this.lastChanges && fence === this.lastFence) return;
    const { packs, busy, revision } = sourceView();
    const ids = new Set(packs.map(pack => pack.id));
    for (const id of published.keys()) if (!ids.has(id)) { published.delete(id); signaturesByPack.delete(id); this.checked.delete(id); }
    const errors: string[] = [];
    for (const pack of packs) {
      signal.throwIfAborted();
      if (busy.has(pack.id) || !['extracted', 'generated'].includes(pack.status)) { this.checked.delete(pack.id); continue; }
      const before = revision;
      const row = readManifestCache(pack.id);
      const old = row?.manifest;
      const oldFiles = new Map(old?.files.map(file => [file.path, file]) ?? []);
      const signatures = row?.signatures ?? {};
      const nextSignatures: Record<string, string> = {};
      const files: FileInfo[] = [];
      const root = resolveWithin(config.dirs.extracted, pack.id);
      const walk = async (relative: string): Promise<void> => {
        const full = resolveWithin(root, relative);
        const stat = await fs.promises.lstat(full);
        if (stat.isSymbolicLink()) throw new Error('Symlink in content');
        if (stat.isDirectory()) {
          for (const name of (await fs.promises.readdir(full)).sort(compare)) await walk(`${relative}/${name}`);
        } else {
          const filename = await safeContentFile(root, relative);
          const signature = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
          const cached = (!this.forceHash || this.checked.has(pack.id)) && signatures[relative] === signature ? oldFiles.get(relative) : undefined;
          files.push(cached ?? { path: relative, ...await hashFile(filename, signal) });
          nextSignatures[relative] = signature;
        }
      };
      try {
        for (const dir of ['images', 'videos']) if (fs.existsSync(path.join(root, dir))) await walk(dir);
        if (files.filter(file => file.path.startsWith('images/')).length !== pack.imageCount || files.filter(file => file.path.startsWith('videos/')).length !== pack.videoCount) throw new Error('Content files do not match pack counts');
        assertSnapshotFence(fence);
        if (changes() !== before) throw new Error('Snapshot deferred: database changed');
        const manifest = makeManifest(pack, files);
        saveManifestCache(manifest, nextSignatures);
        published.set(pack.id, manifest); signaturesByPack.set(pack.id, nextSignatures);
        this.checked.add(pack.id);
      } catch (error) {
        this.checked.delete(pack.id);
        signal.throwIfAborted();
        errors.push(error instanceof Error ? error.message : 'Snapshot build failed');
      }
    }
    assertSnapshotFence(fence);
    this.lastChanges = errors.length ? -1 : changes(); this.lastFence = fence; this.forceHash = false;
    if (errors.length) throw new Error(`${errors.length} pack snapshots pending: ${errors[0]}`);
  }
}

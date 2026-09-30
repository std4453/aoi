import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import Database from 'better-sqlite3';
import { z } from 'zod';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';
import { resolveWithin } from '../services/safe-path.js';
import { activateGeneration, currentGeneration } from './state.js';
import { buildRevision, protocolVersion, dataScope } from './build.js';
import { canonicalJson, createSnapshot, durableFile, durableJson, hashFile, validateManifest, columns, type BlobInfo, type Manifest } from './protocol.js';
import { S3Store, type ObjectStore } from './s3.js';

const pointerSchema = z.object({ generation: z.string().uuid(), sequence: z.number().int().positive().safe(), manifestHash: z.string().regex(/^[a-f0-9]{64}$/), owner: z.string().uuid() }).strict();
type Pointer = z.infer<typeof pointerSchema>;
const root = path.join(config.dataDir, 'replication');
export const replicationStatus = {
  role: config.replicationRole,
  ready: config.replicationRole !== 'replica',
  running: false,
  generation: null as string | null,
  snapshotAt: null as string | null,
  lastSuccess: null as string | null,
  lastError: null as string | null,
  uploadedBlobs: 0,
  downloadedBlobs: 0,
  build: buildRevision,
  protocol: protocolVersion,
  scope: dataScope,
};
const blobKey = (hash: string) => `blobs/sha256/${hash.slice(0, 2)}/${hash}`;

export class Replicator {
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private stopped = false;
  private readonly abort = new AbortController();
  constructor(private readonly store: ObjectStore = new S3Store()) {}

  async initialize(): Promise<void> {
    if (buildRevision === 'development') throw new Error('Replication requires a baked build revision or AOI_BUILD_REVISION');
    fs.mkdirSync(root, { recursive: true });
    if (config.replicationRole === 'replica') {
      const pointerPath = path.join(root, 'current.json');
      if (fs.existsSync(pointerPath)) {
        const pointer = pointerSchema.parse(JSON.parse(fs.readFileSync(pointerPath, 'utf8')));
        try { await this.activate(pointer, false); }
        catch (error) {
          replicationStatus.lastError = error instanceof Error ? error.message : 'Cannot load local snapshot';
          console.error(`[replication] ${replicationStatus.lastError}`);
        }
      }
    }
  }
  start(): void {
    void this.run();
    this.timer = setInterval(() => void this.run(), config.replicationInterval * 1000);
    this.timer.unref();
  }
  run(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.stopped) return Promise.resolve();
    replicationStatus.running = true;
    this.pending = (async () => {
      try {
        if (config.replicationRole === 'primary') await this.publish();
        else await this.pull();
        replicationStatus.lastSuccess = new Date().toISOString();
        replicationStatus.lastError = null;
      } catch (error) {
        // Never log SDK requests/credentials. Status carries only the error message.
        replicationStatus.lastError = error instanceof Error ? error.message : 'Replication failed';
        console.error(`[replication] ${replicationStatus.lastError}`);
      } finally {
        replicationStatus.running = false;
        this.pending = undefined;
      }
    })();
    return this.pending;
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.abort.abort();
    clearInterval(this.timer);
    this.store.close();
    await this.pending;
  }
  private async publish(): Promise<void> {
    const ownerPath = path.join(root, 'publisher.json');
    if (!fs.existsSync(ownerPath)) durableJson(ownerPath, { id: randomUUID() });
    const owner = z.object({ id: z.string().uuid() }).parse(JSON.parse(fs.readFileSync(ownerPath, 'utf8'))).id;
    const claim = await this.store.json('publisher.json');
    if (!claim) await this.store.putJson('publisher.json', { id: owner });
    else if (z.object({ id: z.string().uuid() }).parse(claim.value).id !== owner) throw new Error('S3 prefix belongs to another primary');
    const previous = await this.store.json('latest.json');
    const prior = previous ? pointerSchema.parse(previous.value) : undefined;
    if (prior && prior.owner !== owner) throw new Error('Publisher identity mismatch');
    const staging = path.join(root, 'export');
    // Only this serial exporter owns this directory; it never contains live data.
    await fs.promises.rm(staging, { recursive: true, force: true });
    try {
      const manifest = await createSnapshot(getDb(), config.dataDir, staging, this.abort.signal);
      if (this.stopped) return;
      let uploaded = 0;
      for (const file of new Map(manifest.files.map(file => [file.hash, file])).values()) {
        if (this.stopped) return;
        if (await this.store.upload(blobKey(file.hash), path.join(staging, 'blobs', file.hash), file)) uploaded++;
      }
      const prefix = `snapshots/${manifest.generation}`;
      await this.store.upload(`${prefix}/catalog.sqlite`, path.join(staging, 'catalog.sqlite'), manifest.catalog);
      await this.store.putJson(`${prefix}/manifest.json`, manifest);
      const manifestHash = (await hashFile(path.join(staging, 'manifest.json'))).hash;
      const pointer: Pointer = { generation: manifest.generation, sequence: (prior?.sequence ?? 0) + 1, manifestHash, owner };
      await this.store.putJson(`${prefix}/COMMITTED`, pointer);
      await this.store.putJson('latest.json', pointer, previous?.etag);
      replicationStatus.uploadedBlobs = uploaded;
      replicationStatus.generation = manifest.generation;
      replicationStatus.snapshotAt = manifest.createdAt;
    } finally { await fs.promises.rm(staging, { recursive: true, force: true }); }
  }
  private async receive(key: string, destination: string, info: BlobInfo): Promise<boolean> {
    if (fs.existsSync(destination)) {
      const existing = await hashFile(destination, this.abort.signal);
      if (existing.hash === info.hash && existing.size === info.size) return false;
      // Never modify blobs already linked into a serving generation.
      throw new Error('Local immutable object is corrupt; repair the replica cache offline');
    }
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    const temp = `${destination}.${randomUUID()}.tmp`;
    try {
      await this.store.download(key, temp, info.size);
      const actual = await hashFile(temp, this.abort.signal);
      if (actual.hash !== info.hash || actual.size !== info.size) throw new Error('Downloaded object checksum mismatch');
      await durableFile(temp);
      await fs.promises.rename(temp, destination);
      return true;
    } finally { await fs.promises.rm(temp, { force: true }); }
  }
  private async pull(): Promise<void> {
    const latest = await this.store.json('latest.json');
    if (!latest) throw new Error('Waiting for the first published snapshot');
    const pointer = pointerSchema.parse(latest.value);
    const currentPath = path.join(root, 'current.json');
    if (fs.existsSync(currentPath)) {
      const old = pointerSchema.parse(JSON.parse(fs.readFileSync(currentPath, 'utf8')));
      if (old.owner !== pointer.owner) throw new Error('Publisher changed; explicit replica reseeding is required');
      if (old.generation === pointer.generation && currentGeneration()?.id === pointer.generation) return;
      if (pointer.sequence < old.sequence || (pointer.sequence === old.sequence && pointer.generation !== old.generation)) throw new Error('Refusing snapshot rollback');
    }
    const prefix = `snapshots/${pointer.generation}`;
    const committed = await this.store.json(`${prefix}/COMMITTED`);
    if (!committed || JSON.stringify(pointerSchema.parse(committed.value)) !== JSON.stringify(pointer)) throw new Error('Snapshot is not committed');
    const object = await this.store.json(`${prefix}/manifest.json`);
    if (!object) throw new Error('Missing manifest');
    const manifest = validateManifest(object.value);
    const { createHash } = await import('node:crypto');
    if (manifest.generation !== pointer.generation || createHash('sha256').update(canonicalJson(object.value)).digest('hex') !== pointer.manifestHash) {
      throw new Error('Manifest checksum mismatch');
    }
    const directory = path.join(root, 'generations', pointer.generation);
    // Failed installation directories are safe to replace; the active one was
    // handled above and is never mutated.
    await fs.promises.rm(directory, { recursive: true, force: true });
    await fs.promises.mkdir(directory, { recursive: true });
    await this.receive(`${prefix}/catalog.sqlite`, path.join(directory, 'catalog.sqlite'), manifest.catalog);
    let downloaded = 0;
    for (const file of manifest.files) {
      if (this.stopped) return;
      const blob = path.join(root, 'blobs', file.hash);
      if (await this.receive(blobKey(file.hash), blob, file)) downloaded++;
      const target = resolveWithin(directory, file.path);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.link(blob, target);
    }
    durableJson(path.join(directory, 'manifest.json'), manifest);
    async function syncDirectories(dir: string): Promise<void> {
      for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await syncDirectories(path.join(dir, entry.name));
      }
      await durableFile(dir);
    }
    await syncDirectories(directory);
    await durableFile(path.join(root, 'generations'));
    if (manifest.files.length) await durableFile(path.join(root, 'blobs'));
    await this.activate(pointer, true);
    replicationStatus.downloadedBlobs = downloaded;
  }
  private async activate(pointer: Pointer, save: boolean): Promise<void> {
    const directory = path.join(root, 'generations', pointer.generation);
    const manifest = validateManifest(JSON.parse(fs.readFileSync(path.join(directory, 'manifest.json'), 'utf8')));
    const { createHash } = await import('node:crypto');
    if (manifest.generation !== pointer.generation || createHash('sha256').update(canonicalJson(manifest)).digest('hex') !== pointer.manifestHash) throw new Error('Local manifest mismatch');
    const catalog = await hashFile(path.join(directory, 'catalog.sqlite'), this.abort.signal);
    if (catalog.hash !== manifest.catalog.hash || catalog.size !== manifest.catalog.size) throw new Error('Local catalog checksum mismatch');
    for (const file of manifest.files) {
      const actual = await hashFile(resolveWithin(directory, file.path), this.abort.signal);
      if (actual.hash !== file.hash || actual.size !== file.size) throw new Error('Local content checksum mismatch');
    }
    const db = new Database(path.join(directory, 'catalog.sqlite'), { readonly: true, fileMustExist: true });
    try {
      db.pragma('query_only = ON');
      if (db.pragma('quick_check', { simple: true }) !== 'ok' || (db.pragma('foreign_key_check') as unknown[]).length) throw new Error('Replica database integrity check failed');
      for (const [table, fields] of Object.entries(columns)) db.prepare(`SELECT ${fields.join(',')} FROM ${table} LIMIT 0`).all();
      // Persist before swapping the in-memory context. All referenced objects
      // have been fsynced; a restart can safely reopen the selected generation.
      if (save) durableJson(path.join(root, 'current.json'), pointer);
      activateGeneration({ id: pointer.generation, root: directory, db, readers: 0, retired: false });
      replicationStatus.ready = true;
      replicationStatus.generation = pointer.generation;
      replicationStatus.snapshotAt = manifest.createdAt;
    } catch (error) { db.close(); throw error; }
  }
}

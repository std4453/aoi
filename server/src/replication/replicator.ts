import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config.js';
import { getDb } from '../db/connection.js';
import { resolveWithin } from '../services/safe-path.js';
import { activateVersion, getActiveVersion, clearVersions, removeVersion, referencedRoots } from './state.js';
import { canonicalJson, contractValues, durableFile, hashFile, manifestPack, safeContentFile, syncTree, validateIndex, validateManifest, type FileInfo, type Manifest } from './protocol.js';
import { readState, writeState, SnapshotPublisher } from './snapshots.js';
import { warmCache, drainCaches } from './cache.js';

export const publisher = new SnapshotPublisher();
export const replicationStatus = {
  role: config.isReplica ? 'replica' : 'standalone', ...contractValues(),
  ready: !config.isReplica, running: false, lastCheck: null as string | null,
  lastSuccess: null as string | null, lastError: null as string | null,
  pendingPacks: 0, failedPacks: 0, downloadedFiles: 0,
};
const root = path.join(config.dataDir, 'replica');
export class Replicator {
  private timer?: NodeJS.Timeout;
  private pending?: Promise<void>;
  private stopped = false;
  private abort = new AbortController();
  private token = '';
  async initialize(): Promise<void> {
    if (!config.isReplica) { publisher.initialize(); return; }
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    await durableFile(config.dataDir);
    const rows = getDb().prepare('SELECT manifest,root FROM replica_packs').all() as { manifest: string; root: string }[];
    for (const row of rows) {
      const manifest = validateManifest(JSON.parse(row.manifest));
      const expected = this.versionRoot(manifest);
      if (row.root !== expected) throw new Error('Invalid local version root');
      for (const file of manifest.files) {
        const filename = await safeContentFile(path.join(expected, 'extracted', manifest.metadata.id), file.path);
        const actual = await hashFile(filename);
        if (actual.hash !== file.hash || actual.size !== file.size) throw new Error('Local snapshot is corrupt');
      }
      this.activate(manifest);
    }
    replicationStatus.ready = rows.length > 0 || readState('replicaEmpty') === 'true';
    await this.collect(true);
  }
  start(): void {
    void this.run();
    this.timer = setInterval(() => void this.run(), config.isReplica ? config.replicationInterval * 1000 : 1000);
    this.timer.unref();
  }
  run(): Promise<void> {
    if (this.pending) return this.pending;
    if (this.stopped) return Promise.resolve();
    replicationStatus.running = true;
    this.pending = (async () => {
      try {
        if (config.isReplica) await this.pull(); else await publisher.run(this.abort.signal);
        replicationStatus.lastSuccess = new Date().toISOString(); replicationStatus.lastError = null;
      } catch (error) {
        replicationStatus.lastError = error instanceof Error ? error.message : 'Snapshot synchronization failed';
      } finally {
        replicationStatus.lastCheck = new Date().toISOString(); replicationStatus.running = false; this.pending = undefined;
      }
    })();
    return this.pending;
  }
  async stop(): Promise<void> {
    this.stopped = true; this.abort.abort(); clearInterval(this.timer);
    await this.pending; await drainCaches(); clearVersions();
  }
  private async request(endpoint: string, headers: Record<string, string> = {}, retry = true): Promise<Response> {
    const response = await fetch(`${config.replicaSourceUrl}${endpoint}`, {
      headers: { ...headers, ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}) },
      redirect: 'error', signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(120_000)]),
    });
    if (response.status === 401 && retry) {
      await response.body?.cancel(); await this.login(); return this.request(endpoint, headers, false);
    }
    return response;
  }
  private async login(): Promise<void> {
    const response = await fetch(`${config.replicaSourceUrl}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: config.replicaSourceKey }), redirect: 'error',
      signal: AbortSignal.any([this.abort.signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Upstream login failed: HTTP ${response.status}`); }
    const result = await response.json() as { token?: unknown };
    if (typeof result.token !== 'string') throw new Error('Invalid upstream login');
    this.token = result.token;
  }
  private async json(response: Response): Promise<unknown> {
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Upstream returned HTTP ${response.status}`); }
    // Limit metadata bodies independently of the file streaming path.
    if (!response.body) throw new Error('Empty upstream response');
    const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of Readable.fromWeb(response.body as never)) {
      bytes += chunk.length;
      if (bytes > 64 * 1024 * 1024) throw new Error('Snapshot metadata exceeds limit');
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString()); }
    catch { throw new Error('Invalid upstream JSON'); }
  }
  private versionRoot(manifest: Manifest): string {
    return path.join(root, 'versions', manifest.metadata.id, manifest.contentHash);
  }
  private activate(manifest: Manifest): void {
    const version = { id: manifest.revision, root: this.versionRoot(manifest), pack: manifestPack(manifest), readers: 0 };
    activateVersion(version); warmCache(version);
  }
  private async receive(manifest: Manifest, file: FileInfo): Promise<void> {
    const blobs = path.join(root, 'blobs'); await fs.promises.mkdir(blobs, { recursive: true });
    const destination = path.join(blobs, file.hash);
    if (fs.existsSync(destination)) {
      const existing = await hashFile(destination, this.abort.signal);
      if (existing.hash !== file.hash || existing.size !== file.size) throw new Error('Local immutable file is corrupt');
      return;
    }
    const temp = `${destination}.part`;
    let offset = fs.existsSync(temp) ? (await fs.promises.stat(temp)).size : 0;
    if (offset > file.size) { await fs.promises.truncate(temp, 0); offset = 0; }
    if (offset < file.size || !fs.existsSync(temp)) {
      const url = `/api/packs/${encodeURIComponent(manifest.metadata.id)}/snapshot/files/${file.path.split('/').map(encodeURIComponent).join('/')}?contentHash=${manifest.contentHash}`;
      const response = await this.request(url, offset ? { Range: `bytes=${offset}-`, 'If-Range': `"${file.hash}"` } : {});
      if (![200, 206].includes(response.status) || !response.body) {
        await response.body?.cancel(); throw new Error(`File download failed: HTTP ${response.status}`);
      }
      if (response.status === 200) offset = 0;
      else if (response.headers.get('content-range') !== `bytes ${offset}-${file.size - 1}/${file.size}`) {
        await response.body.cancel(); throw new Error('Invalid download range');
      }
      let received = offset;
      await pipeline(Readable.fromWeb(response.body as never), new Transform({
        transform(chunk: Buffer, _encoding, done) {
          received += chunk.length;
          done(received > file.size ? new Error('Downloaded file exceeds declared size') : null, chunk);
        },
      }), fs.createWriteStream(temp, { flags: offset ? 'a' : 'w', mode: 0o600 }), { signal: this.abort.signal });
    }
    const actual = await hashFile(temp, this.abort.signal);
    if (actual.hash !== file.hash || actual.size !== file.size) {
      await fs.promises.rm(temp, { force: true }); throw new Error('Downloaded file checksum mismatch');
    }
    await durableFile(temp); await fs.promises.rename(temp, destination); await durableFile(blobs);
    replicationStatus.downloadedFiles++;
  }
  private async install(manifest: Manifest): Promise<void> {
    const directory = this.versionRoot(manifest);
    if (!fs.existsSync(path.join(directory, 'manifest.json'))) {
      await fs.promises.rm(directory, { recursive: true, force: true });
      await fs.promises.mkdir(directory, { recursive: true });
      // Group identical hashes so concurrent workers never append to the same part file.
      const files = [...new Map(manifest.files.map(file => [file.hash, file])).values()];
      let cursor = 0;
      const worker = async () => { while (cursor < files.length) await this.receive(manifest, files[cursor++]); };
      const results = await Promise.allSettled([worker(), worker()]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure?.status === 'rejected') throw failure.reason;
      for (const file of manifest.files) {
        const target = resolveWithin(path.join(directory, 'extracted', manifest.metadata.id), file.path);
        await fs.promises.mkdir(path.dirname(target), { recursive: true });
        await fs.promises.link(path.join(root, 'blobs', file.hash), target);
      }
      await fs.promises.writeFile(path.join(directory, 'manifest.json'), canonicalJson(manifest), { mode: 0o600 });
      await durableFile(path.join(directory, 'manifest.json')); await syncTree(directory);
      await durableFile(path.dirname(directory)); await durableFile(path.join(root, 'versions'));
      await durableFile(root);
    }
    // A previous failed installation may have written its marker before fsync
    // failed. Never commit such a directory solely because the marker exists.
    if (getActiveVersion(manifest.metadata.id)?.root !== directory) {
      for (const file of manifest.files) {
        const filename = await safeContentFile(path.join(directory, 'extracted', manifest.metadata.id), file.path);
        const actual = await hashFile(filename, this.abort.signal);
        if (actual.hash !== file.hash || actual.size !== file.size) throw new Error('Incomplete local candidate');
        await durableFile(filename);
      }
      await durableFile(path.join(directory, 'manifest.json')); await syncTree(directory);
      await durableFile(path.dirname(directory)); await durableFile(path.join(root, 'versions')); await durableFile(root);
    }
    const pack = manifestPack(manifest); const db = getDb();
    db.transaction(() => {
      db.prepare(`INSERT INTO packs(id,name,original_filename,original_size,original_format,source_type,status,image_count,video_count,total_images_size,total_videos_size,created_at,updated_at)
        VALUES (@id,@name,@originalFilename,@originalSize,@originalFormat,@sourceType,'extracted',@imageCount,@videoCount,@totalImagesSize,@totalVideosSize,@createdAt,@updatedAt)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name,original_filename=excluded.original_filename,original_size=excluded.original_size,
        original_format=excluded.original_format,source_type=excluded.source_type,status='extracted',image_count=excluded.image_count,video_count=excluded.video_count,
        total_images_size=excluded.total_images_size,total_videos_size=excluded.total_videos_size,updated_at=excluded.updated_at,compressed_size=0,error_message=NULL`).run(pack);
      // Per-pack manifests own their tag names: partially synchronized packs may
      // legitimately refer to different revisions of the same upstream tag.
      db.prepare(`INSERT INTO replica_packs(pack_id,manifest,root) VALUES (?,?,?)
        ON CONFLICT(pack_id) DO UPDATE SET manifest=excluded.manifest,root=excluded.root`).run(pack.id, canonicalJson(manifest), directory);
    })();
    this.activate(manifest); replicationStatus.ready = true;
  }
  private async pull(): Promise<void> {
    const health = await this.json(await this.request('/api/health')) as { service?: string; writable?: boolean; replicationProtocol?: string; capabilities?: { snapshots?: boolean } };
    if (health.service !== 'aoi' || health.writable !== true || !health.capabilities?.snapshots || health.replicationProtocol !== contractValues().protocol) throw new Error('Upstream must be a writable snapshot server with the same protocol');
    const previous = readState('replicaIndex'); const etag = readState('replicaEtag');
    const response = await this.request('/api/packs/snapshot', previous && etag ? { 'If-None-Match': etag } : {});
    const index = response.status === 304 && previous ? validateIndex(JSON.parse(previous)) : validateIndex(await this.json(response));
    const bound = readState('replicaDataset');
    if (bound && bound !== index.datasetId) throw new Error('Upstream dataset changed; use a new replica DATA_DIR');
    const db = getDb();
    db.transaction(() => {
      writeState('replicaDataset', index.datasetId); writeState('replicaIndex', canonicalJson(index));
      if (response.status !== 304) writeState('replicaEtag', response.headers.get('etag') ?? '');
    })();
    replicationStatus.failedPacks = 0; replicationStatus.downloadedFiles = 0; replicationStatus.pendingPacks = 0;
    for (const entry of index.packs) {
      if (entry.state === 'pending') { replicationStatus.pendingPacks++; continue; }
      const stored = db.prepare('SELECT manifest FROM replica_packs WHERE pack_id=?').pluck().get(entry.id) as string | undefined;
      if (stored && validateManifest(JSON.parse(stored)).revision === entry.revision) continue;
      try {
        const manifest = validateManifest(await this.json(await this.request(`/api/packs/${encodeURIComponent(entry.id)}/snapshot?revision=${entry.revision}`)));
        if (manifest.metadata.id !== entry.id || manifest.revision !== entry.revision) throw new Error('Snapshot identity mismatch');
        await this.install(manifest);
      } catch {
        // Do not include remote bodies or URLs (which could expose credentials).
        replicationStatus.failedPacks++; replicationStatus.pendingPacks++;
      }
    }
    const ids = new Set(index.packs.map(pack => pack.id));
    const removed: string[] = [];
    db.transaction(() => {
      for (const row of db.prepare('SELECT pack_id FROM replica_packs').all() as { pack_id: string }[]) {
        if (!ids.has(row.pack_id)) { db.prepare('DELETE FROM packs WHERE id=?').run(row.pack_id); removed.push(row.pack_id); }
      }
      writeState('replicaEmpty', String(index.packs.length === 0));
    })();
    for (const id of removed) removeVersion(id);
    replicationStatus.ready = index.packs.length === 0 || Boolean(db.prepare('SELECT 1 FROM replica_packs LIMIT 1').get());
    await this.collect();
    if (replicationStatus.failedPacks) throw new Error(`${replicationStatus.failedPacks} pack snapshots could not be synchronized`);
  }
  private async collect(startup = false): Promise<void> {
    const protectedRoots = referencedRoots();
    const keepHashes = new Set<string>();
    const desired = readState('replicaIndex');
    const desiredIds = new Set(desired ? validateIndex(JSON.parse(desired)).packs.map(pack => pack.id) : []);
    const versions = path.join(root, 'versions');
    if (fs.existsSync(versions)) for (const id of await fs.promises.readdir(versions)) {
      const packDir = resolveWithin(versions, id);
      for (const hash of await fs.promises.readdir(packDir)) {
        const dir = resolveWithin(packDir, hash);
        if (protectedRoots.has(dir)) {
          const manifest = validateManifest(JSON.parse(await fs.promises.readFile(path.join(dir, 'manifest.json'), 'utf8')));
          for (const file of manifest.files) keepHashes.add(file.hash);
        } else await fs.promises.rm(dir, { recursive: true, force: true });
      }
    }
    // Retain partial files across retries. Completed unreferenced blobs are also
    // retained while any pack is pending so a failed install can reuse them.
    if (startup || replicationStatus.pendingPacks || desiredIds.size && !replicationStatus.ready) return;
    const blobs = path.join(root, 'blobs');
    if (fs.existsSync(blobs)) for (const name of await fs.promises.readdir(blobs)) {
      if (!keepHashes.has(name)) await fs.promises.rm(resolveWithin(blobs, name), { force: true });
    }
  }
}

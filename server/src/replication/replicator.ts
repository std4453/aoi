import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config/index.js';
import { beginReplicaInstall, finishReplicaInstall, installedManifest, pendingInstallations, markReplicaRemoving, readState, removeReplicaPack, replicaReady, retryReplicaProcessing, saveReplicaIndex, writeState } from '../db/snapshot-repository.js';
import { getPath, removePackFiles } from '../services/storage.js';
import { getPack, hasAnyActiveJob, listPacks } from '../db/repositories.js';
import { jobQueue } from '../services/job-queue.js';
import { resolveWithin } from '../services/safe-path.js';
import { contractValues, durableFile, hashFile, safeContentFile, syncTree, validateIndex, validateManifest, type FileInfo, type Manifest } from './protocol.js';
import { SnapshotPublisher } from './snapshots.js';

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
    for (const directory of [root, config.dirs.extracted, config.dirs.thumbnails]) {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    await durableFile(config.dataDir);
    replicationStatus.ready = replicaReady();
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
        if (config.isReplica) {
          await this.recoverInstalls();
          for (const pack of listPacks()) retryReplicaProcessing(pack.id);
          jobQueue.start();
          await this.cleanStaging();
          await this.pull();
        } else await publisher.run(this.abort.signal);
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
    await this.pending;
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
  private staging(id: string): string {
    return resolveWithin(path.join(root, 'staging'), id);
  }
  private async receive(manifest: Manifest, file: FileInfo): Promise<void> {
    const downloads = path.join(this.staging(manifest.metadata.id), 'downloads');
    await fs.promises.mkdir(downloads, { recursive: true });
    const destination = path.join(downloads, file.hash);
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
    await durableFile(temp); await fs.promises.rename(temp, destination); await durableFile(downloads);
    replicationStatus.downloadedFiles++;
  }
  private async verifyContent(directory: string, manifest: Manifest): Promise<void> {
    for (const file of manifest.files) {
      const filename = await safeContentFile(directory, file.path);
      const actual = await hashFile(filename, this.abort.signal);
      if (actual.hash !== file.hash || actual.size !== file.size) throw new Error('Incomplete local candidate');
      await durableFile(filename);
    }
    await syncTree(directory);
  }
  private async install(manifest: Manifest): Promise<void> {
    const id = manifest.metadata.id;
    if (hasAnyActiveJob(id)) throw new Error('Local pack processing is still active');
    const stage = this.staging(manifest.metadata.id);
    const content = path.join(stage, 'content');
    await fs.promises.rm(content, { recursive: true, force: true });
    await fs.promises.mkdir(content, { recursive: true });
    const previous = installedManifest(id);
    const reusable = new Map(previous?.files.map(file => [file.hash, file]) ?? []);
    const files = [...new Map(manifest.files.map(file => [file.hash, file])).values()];
    const downloads = path.join(stage, 'downloads');
    const needed = new Set(files.flatMap(file => [file.hash, `${file.hash}.part`]));
    if (fs.existsSync(downloads)) for (const name of await fs.promises.readdir(downloads)) {
      if (!needed.has(name)) await fs.promises.rm(resolveWithin(downloads, name), { force: true });
    }
    const locations = new Map<string, string>();
    let cursor = 0;
    const worker = async () => {
      while (cursor < files.length) {
        const file = files[cursor++];
        const old = reusable.get(file.hash);
        if (old) {
          try {
            const filename = await safeContentFile(getPath('extracted', id), old.path);
            const actual = await hashFile(filename, this.abort.signal);
            if (actual.hash === file.hash && actual.size === file.size) {
              locations.set(file.hash, filename); continue;
            }
          } catch { this.abort.signal.throwIfAborted(); }
          // A missing/corrupt reusable file must be downloaded again.
        }
        await this.receive(manifest, file);
        locations.set(file.hash, path.join(stage, 'downloads', file.hash));
      }
    };
    const results = await Promise.allSettled([worker(), worker()]);
    const failure = results.find(result => result.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    for (const file of manifest.files) {
      const target = resolveWithin(content, file.path);
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      await fs.promises.link(locations.get(file.hash)!, target);
    }
    // receive() and reusable-file checks already verified every linked inode.
    await syncTree(stage); await durableFile(path.dirname(stage));
    await durableFile(root);
    // The journal and processing status commit together before replacing current files.
    beginReplicaInstall(manifest);
    await this.finishInstall(manifest);
  }
  private async finishInstall(manifest: Manifest, recovering = false): Promise<void> {
    const id = manifest.metadata.id;
    const stage = this.staging(manifest.metadata.id);
    const content = path.join(stage, 'content');
    const current = getPath('extracted', id);
    // Recovery verifies the candidate once, wherever the last rename left it.
    if (recovering) await this.verifyContent(fs.existsSync(content) ? content : current, manifest);
    if (fs.existsSync(content)) {
      // A durable candidate and journal make deletion safely resumable.
      await fs.promises.rm(current, { recursive: true, force: true });
      await fs.promises.rename(content, current);
    }
    await durableFile(config.dirs.extracted); await durableFile(stage);
    await fs.promises.rm(getPath('thumbnails', id), { recursive: true, force: true });
    await durableFile(config.dirs.thumbnails);
    finishReplicaInstall(manifest);
    // Wake the idle queue for each committed pack, including recovered installs.
    // Waiting until pull() finishes keeps a fresh replica unreadable during long downloads.
    jobQueue.start();
    await fs.promises.rm(stage, { recursive: true, force: true });
  }
  private async recoverInstalls(): Promise<void> {
    for (const manifest of pendingInstallations()) {
      try { await this.finishInstall(manifest, true); }
      catch { /* Keep the journal and processing status for the next attempt. */ }
    }
  }
  private async pull(): Promise<void> {
    const health = await this.json(await this.request('/api/health')) as { service?: string; writable?: boolean; replicationProtocol?: string; capabilities?: { snapshots?: boolean } };
    if (health.service !== 'aoi' || health.writable !== true || !health.capabilities?.snapshots || health.replicationProtocol !== contractValues().protocol) throw new Error('Upstream must be a writable snapshot server with the same protocol');
    const previous = readState('replicaIndex'); const etag = readState('replicaEtag');
    const response = await this.request('/api/packs/snapshot', previous && etag ? { 'If-None-Match': etag } : {});
    const index = response.status === 304 && previous ? validateIndex(JSON.parse(previous)) : validateIndex(await this.json(response));
    saveReplicaIndex(index, response.status === 304 ? undefined : response.headers.get('etag') ?? '');
    const recovering = new Set(pendingInstallations().map(manifest => manifest.metadata.id));
    replicationStatus.failedPacks = 0; replicationStatus.downloadedFiles = 0; replicationStatus.pendingPacks = 0;
    for (const entry of index.packs) {
      if (entry.state === 'pending') { replicationStatus.pendingPacks++; continue; }
      if (recovering.has(entry.id)) { replicationStatus.failedPacks++; replicationStatus.pendingPacks++; continue; }
      const stored = installedManifest(entry.id);
      if (stored?.revision === entry.revision && getPack(entry.id)?.status !== 'extracting') continue;
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
    for (const { id } of listPacks()) if (!ids.has(id)) {
      try {
        // Leave a processing row until file cleanup succeeds, so a crash or disk
        // error cannot expose a pack with missing files as available.
        markReplicaRemoving(id);
        removePackFiles(id);
        await durableFile(config.dirs.extracted); await durableFile(config.dirs.thumbnails);
        await fs.promises.rm(this.staging(id), { recursive: true, force: true });
        removeReplicaPack(id);
      } catch { replicationStatus.failedPacks++; replicationStatus.pendingPacks++; }
    }
    writeState('replicaEmpty', String(index.packs.length === 0 && !listPacks().length));
    replicationStatus.ready = replicationStatus.ready || replicaReady();
    jobQueue.start();
    await this.cleanStaging();
    if (replicationStatus.failedPacks) throw new Error(`${replicationStatus.failedPacks} pack snapshots could not be synchronized`);
  }
  private async cleanStaging(): Promise<void> {
    const keep = new Set(pendingInstallations().map(manifest => manifest.metadata.id));
    const desired = readState('replicaIndex');
    if (desired) for (const entry of validateIndex(JSON.parse(desired)).packs) {
      if (entry.state === 'pending' || installedManifest(entry.id)?.revision !== entry.revision) keep.add(entry.id);
    }
    const staging = path.join(root, 'staging');
    if (fs.existsSync(staging)) for (const id of await fs.promises.readdir(staging)) {
      if (!keep.has(id)) await fs.promises.rm(this.staging(id), { recursive: true, force: true });
    }
  }
}

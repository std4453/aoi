import { randomUUID } from 'node:crypto';
import { getDb } from './connection.js';
import { createJobIfIdle, getPack, hasAnyActiveJob, listPacks, updatePackStatus } from './repositories.js';
import { canonicalJson, manifestPack, validateManifest, type Manifest, type SnapshotIndex } from '../replication/protocol.js';

export function readState(key: string): string | undefined {
  return getDb().prepare('SELECT value FROM snapshot_state WHERE key=?').pluck().get(key) as string | undefined;
}
export function writeState(key: string, value: string): void {
  getDb().prepare('INSERT INTO snapshot_state(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}
export function initializeDataset(): void {
  if (!readState('datasetId')) writeState('datasetId', randomUUID());
}
export function contentRevision(): number {
  return getDb().prepare('SELECT revision FROM snapshot_content_clock WHERE id=1').pluck().get() as number;
}
export function sourceView() {
  return getDb().transaction(() => ({
    revision: contentRevision(), packs: listPacks(), datasetId: readState('datasetId')!,
    busy: new Set((getDb().prepare("SELECT pack_id FROM jobs WHERE status IN ('pending','running')").all() as { pack_id: string }[]).map(row => row.pack_id)),
  }))();
}
export function readManifestCache(id: string): { manifest: Manifest; signatures: Record<string, string> } | undefined {
  const row = getDb().prepare('SELECT manifest,signatures FROM snapshot_manifests WHERE pack_id=?').get(id) as { manifest: string; signatures: string } | undefined;
  return row ? { manifest: validateManifest(JSON.parse(row.manifest)), signatures: JSON.parse(row.signatures) } : undefined;
}
export function saveManifestCache(manifest: Manifest, signatures: Record<string, string>): void {
  getDb().prepare(`INSERT INTO snapshot_manifests(pack_id,manifest,signatures) VALUES (?,?,?)
    ON CONFLICT(pack_id) DO UPDATE SET manifest=excluded.manifest,signatures=excluded.signatures`)
    .run(manifest.metadata.id, canonicalJson(manifest), canonicalJson(signatures));
}
export function installedManifests(): Manifest[] {
  return (getDb().prepare('SELECT manifest FROM replica_packs').all() as { manifest: string }[])
    .map(row => validateManifest(JSON.parse(row.manifest)));
}
export function installedManifest(id: string): Manifest | undefined {
  const value = getDb().prepare('SELECT manifest FROM replica_packs WHERE pack_id=?').pluck().get(id) as string | undefined;
  return value ? validateManifest(JSON.parse(value)) : undefined;
}
export function pendingInstallations(): Manifest[] {
  return (getDb().prepare('SELECT manifest FROM replica_installs').all() as { manifest: string }[])
    .map(row => validateManifest(JSON.parse(row.manifest)));
}
export function saveReplicaIndex(index: SnapshotIndex, etag?: string): void {
  getDb().transaction(() => {
    const bound = readState('replicaDataset');
    if (bound && bound !== index.datasetId) throw new Error('Upstream dataset changed; use a new replica DATA_DIR');
    writeState('replicaDataset', index.datasetId);
    writeState('replicaIndex', canonicalJson(index));
    if (etag !== undefined) writeState('replicaEtag', etag);
  })();
}
function writePack(manifest: Manifest): void {
  // Explicit allowlist: never replace unrelated local columns or tables.
  getDb().prepare(`INSERT INTO packs(id,name,original_filename,original_size,original_format,source_type,status,image_count,video_count,total_images_size,total_videos_size,created_at,updated_at)
    VALUES (@id,@name,@originalFilename,@originalSize,@originalFormat,@sourceType,'extracting',@imageCount,@videoCount,@totalImagesSize,@totalVideosSize,@createdAt,@updatedAt)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name,original_filename=excluded.original_filename,original_size=excluded.original_size,
    original_format=excluded.original_format,source_type=excluded.source_type,status='extracting',image_count=excluded.image_count,video_count=excluded.video_count,
    total_images_size=excluded.total_images_size,total_videos_size=excluded.total_videos_size,updated_at=excluded.updated_at,compressed_size=0,error_message=NULL,blurhashes=NULL`)
    .run(manifestPack(manifest));
}
export function beginReplicaInstall(manifest: Manifest): void {
  getDb().transaction(() => {
    if (hasAnyActiveJob(manifest.metadata.id)) throw new Error('Local pack processing is still active');
    writePack(manifest);
    getDb().prepare('INSERT INTO replica_installs(pack_id,manifest) VALUES (?,?)').run(manifest.metadata.id, canonicalJson(manifest));
  })();
}
export function finishReplicaInstall(manifest: Manifest): void {
  getDb().transaction(() => {
    getDb().prepare(`INSERT INTO replica_packs(pack_id,manifest) VALUES (?,?)
      ON CONFLICT(pack_id) DO UPDATE SET manifest=excluded.manifest`).run(manifest.metadata.id, canonicalJson(manifest));
    updatePackStatus(manifest.metadata.id, 'thumbnailing');
    createJobIfIdle(manifest.metadata.id, 'thumbnail');
    getDb().prepare('DELETE FROM replica_installs WHERE pack_id=?').run(manifest.metadata.id);
  })();
}
export function retryReplicaProcessing(id: string): void {
  getDb().transaction(() => {
    if (getPack(id)?.status === 'failed' && !hasAnyActiveJob(id)) {
      updatePackStatus(id, 'thumbnailing'); createJobIfIdle(id, 'thumbnail');
    }
  })();
}
export function replicaReady(): boolean {
  return readState('replicaEmpty') === 'true' || Boolean(getDb().prepare("SELECT 1 FROM replica_packs r JOIN packs p ON p.id=r.pack_id WHERE p.status='extracted' LIMIT 1").get());
}
export function removeReplicaPack(id: string): void {
  getDb().prepare('DELETE FROM packs WHERE id=?').run(id);
}
export function markReplicaRemoving(id: string): void {
  if (hasAnyActiveJob(id)) throw new Error('Local pack processing is still active');
  updatePackStatus(id, 'extracting');
}

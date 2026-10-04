import { TaskError } from '../../../shared/task-errors.js';
import fs from 'node:fs';
import { config } from '../config/index.js';
import { getDb } from '../db/connection.js';
import { getPack, getLatestJob, setPackTags, updatePackStats, updatePackStructureType } from '../db/repositories.js';
import { ensureDir, getExtractedImagesDir, getExtractedVideosDir } from './storage.js';
import { resolveWithin } from './safe-path.js';
import { scheduleVerification } from './content-verification.js';
import { ensureImportTags } from './import-tags.js';
import { getFanboxClient, parseFanboxUrl } from './fanbox-client.js';

export async function importFanboxPack(
  packId: string,
  onProgress: (completed: number, total: number, bytes: number) => void,
  client = getFanboxClient(),
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const pack = getPack(packId);
  if (!pack || pack.originalFormat !== 'fanbox') throw new TaskError('SOURCE_UNAVAILABLE', 'FANBOX 图包不存在');
  const { id } = parseFanboxUrl(pack.originalFilename);
  const post = await client.post(id, signal);
  signal?.throwIfAborted();
  if (!post.media.length) throw new TaskError('NO_SUPPORTED_MEDIA', '该 FANBOX 帖子没有可导入的图片或视频；文字、压缩包及外部嵌入链接会被跳过');
  const dirs = { image: getExtractedImagesDir(packId), video: getExtractedVideosDir(packId) };
  const expected = { image: new Set<string>(), video: new Set<string>() };
  const stats = { imageCount: 0, videoCount: 0, totalImagesSize: 0, totalVideosSize: 0 };
  Object.values(dirs).forEach(ensureDir);
  let bytes = 0;
  const totalLimit = Math.min(config.maxUploadSize, config.maxExtractedSize);
  onProgress(0, post.media.length, 0);
  for (const [index, media] of post.media.entries()) {
    signal?.throwIfAborted();
    const filename = `${id}_${String(index + 1).padStart(3, '0')}${media.extension}`;
    const destination = resolveWithin(dirs[media.category], filename);
    // Recovery fetches the current manifest and replaces complete files, never appending partial bytes.
    const size = await client.download(media, destination,
      Math.min(totalLimit - bytes, media.category === 'image' ? 100 * 1024 * 1024 : totalLimit), signal);
    bytes += size;
    expected[media.category].add(filename);
    if (media.category === 'image') { stats.imageCount++; stats.totalImagesSize += size; }
    else { stats.videoCount++; stats.totalVideosSize += size; }
    onProgress(index + 1, post.media.length, bytes);
  }
  for (const category of ['image', 'video'] as const) for (const filename of await fs.promises.readdir(dirs[category])) {
    if (!expected[category].has(filename)) await fs.promises.rm(resolveWithin(dirs[category], filename), { force: true });
  }
  signal?.throwIfAborted();
  getDb().transaction(() => {
    const options = JSON.parse(getLatestJob(packId, 'fanbox')?.options ?? '{}') as { autoName?: boolean; autoTags?: boolean };
    if (options.autoTags ?? true) {
      const tags = ensureImportTags([post.author]);
      setPackTags(packId, [...new Set([...pack.tags.map(tag => tag.id), ...tags.map(tag => tag.id)])].slice(0, 1000));
    }
    const name = (options.autoName ?? true) ? post.title : pack.name;
    getDb().prepare('UPDATE packs SET name = ?, original_size = ? WHERE id = ?').run(name, bytes, packId);
    updatePackStats(packId, stats);
    updatePackStructureType(packId, 'flat');
    scheduleVerification(packId);
  })();
}

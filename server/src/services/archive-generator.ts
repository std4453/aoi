import fs from 'node:fs';
import path from 'node:path';
import { ZipArchive } from 'archiver';
import {
  getExtractedVideosDir,
  getGeneratedDir,
  getGeneratedPath,
  ensureDir,
} from './storage';
import type { CompressionOptions, FileSelection } from '~/types';
import { isUgoira } from './ugoira';

function walkFiles(dir: string, root?: string): { fullPath: string; relativePath: string }[] {
  const base = root ?? dir;
  const results: { fullPath: string; relativePath: string }[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkFiles(fullPath, base));
    } else if (entry.isFile()) {
      results.push({ fullPath, relativePath: path.relative(base, fullPath) });
    }
  }
  return results;
}

export const archiveGenerator = {
  async generate(
    packId: string,
    options: CompressionOptions,
    onProgress?: (progress: { completed: number; total: number; percentage: number }) => void,
    fileSelection?: FileSelection
  ): Promise<string> {
    const tempDir = path.join(getGeneratedDir(packId), 'temp');
    const finalOutputPath = getGeneratedPath(packId);
    const outputPath = `${finalOutputPath}.tmp`;
    ensureDir(getGeneratedDir(packId));
    fs.rmSync(outputPath, { force: true });

    if (!fs.existsSync(tempDir)) {
      throw new Error('No compressed images found. Run image compression first.');
    }

    const selectedVideos = fileSelection?.videos
      ? new Set(fileSelection.videos)
      : undefined;
    const compressedImages = walkFiles(tempDir).filter(f => {
      // The compressor recreates tempDir for every job, so it contains exactly
      // the selected images and no additional filtering is necessary here.
      return f.relativePath.endsWith('.jpg') || isUgoira(f.relativePath);
    });

    // Collect all files to archive
    const filesToArchive: { path: string; name: string }[] = [];
    for (const f of compressedImages) {
      filesToArchive.push({ path: f.fullPath, name: f.relativePath });
    }

    if (options.keepVideos) {
      const videosDir = getExtractedVideosDir(packId);
      if (selectedVideos?.size && !fs.existsSync(videosDir)) {
        throw new Error('Selected video files no longer exist');
      }
      if (fs.existsSync(videosDir)) {
        const videos = walkFiles(videosDir);
        const videosByRelativePath = new Map(
          videos.map(video => [
            video.relativePath.split(path.sep).join('/'),
            video,
          ])
        );
        if (selectedVideos) {
          const missing = [...selectedVideos]
            .filter(relativePath => !videosByRelativePath.has(relativePath));
          if (missing.length > 0) {
            throw new Error(
              `Selected video files no longer exist: ${missing.slice(0, 5).join(', ')}`
            );
          }
        }
        for (const v of videos) {
          if (selectedVideos) {
            const normalized = v.relativePath.split(path.sep).join('/');
            if (!selectedVideos.has(normalized)) continue;
          }
          filesToArchive.push({
            path: v.fullPath,
            name: v.relativePath,
          });
        }
      }
    }

    if (filesToArchive.length === 0) {
      throw new Error(
        'No source files remain for the generated archive; the previous archive was preserved.'
      );
    }

    return new Promise((resolve, reject) => {
      const archive = new ZipArchive({
        zlib: { level: 0 }, // JPEGs are already compressed
      });
      const output = fs.createWriteStream(outputPath);
      let settled = false;

      archive.pipe(output);

      let added = 0;
      for (const file of filesToArchive) {
        archive.file(file.path, { name: file.name });
        added++;
        onProgress?.({
          completed: added,
          total: filesToArchive.length,
          percentage: Math.round((added / filesToArchive.length) * 100),
        });
      }

      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        try {
          archive.abort();
          output.destroy();
        } catch {
          // Preserve the original archive error.
        }
        fs.rmSync(outputPath, { force: true });
        reject(error);
      };

      output.once('close', () => {
        if (settled) return;
        void (async () => {
          try {
            fs.renameSync(outputPath, finalOutputPath);
            fs.rmSync(tempDir, { recursive: true, force: true });

            const stat = fs.statSync(finalOutputPath);
            const { updatePackCompressedSize } = await import('~/db/repositories');
            updatePackCompressedSize(packId, stat.size);
            const manifest = {
              packId,
              options,
              fileCount: filesToArchive.length,
              archiveSize: stat.size,
              generatedAt: new Date().toISOString(),
            };
            fs.writeFileSync(
              path.join(getGeneratedDir(packId), 'manifest.json'),
              JSON.stringify(manifest, null, 2)
            );

            settled = true;
            resolve(finalOutputPath);
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        })();
      });

      output.once('error', fail);
      archive.once('error', fail);
      void archive.finalize().catch(fail);
    });
  },
};

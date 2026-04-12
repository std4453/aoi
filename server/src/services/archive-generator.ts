import fs from 'node:fs';
import path from 'node:path';
import archiver from 'archiver';
import {
  getExtractedVideosDir,
  getGeneratedDir,
  getGeneratedPath,
  ensureDir,
} from './storage.js';
import type { CompressionOptions, FileSelection } from '../types.js';

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
    const outputPath = getGeneratedPath(packId);
    ensureDir(getGeneratedDir(packId));

    if (!fs.existsSync(tempDir)) {
      throw new Error('No compressed images found. Run image compression first.');
    }

    const compressedImages = walkFiles(tempDir).filter(f => {
      if (!f.relativePath.endsWith('.jpg')) return false;
      if (fileSelection?.images) {
        // Compressed images have .jpg extension; match by stem
        const stem = f.relativePath.replace(/\.jpg$/, '');
        return fileSelection.images.some((img: string) => img.replace(/\.[^.]+$/, '') === stem);
      }
      return true;
    });

    // Collect all files to archive
    const filesToArchive: { path: string; name: string }[] = [];
    for (const f of compressedImages) {
      filesToArchive.push({ path: f.fullPath, name: f.relativePath });
    }

    if (options.keepVideos) {
      const videosDir = getExtractedVideosDir(packId);
      if (fs.existsSync(videosDir)) {
        const videos = walkFiles(videosDir);
        for (const v of videos) {
          if (fileSelection?.videos) {
            const normalized = v.relativePath.split(path.sep).join('/');
            if (!fileSelection.videos.includes(normalized)) continue;
          }
          filesToArchive.push({
            path: v.fullPath,
            name: v.relativePath,
          });
        }
      }
    }

    return new Promise((resolve, reject) => {
      const archive = archiver('zip', {
        zlib: { level: 0 }, // JPEGs are already compressed
      });

      const output = fs.createWriteStream(outputPath);

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

      output.on('close', async () => {
        // Clean up temp directory
        fs.rmSync(tempDir, { recursive: true, force: true });

        // Write manifest & update compressed size
        const stat = fs.statSync(outputPath);
        try {
          const { updatePackCompressedSize } = await import('../db/repositories.js');
          updatePackCompressedSize(packId, stat.size);
        } catch (err) {
          console.error('Failed to update compressed size:', err);
        }
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

        resolve(outputPath);
      });

      output.on('error', reject);
      archive.on('error', reject);

      archive.finalize();
    });
  },
};

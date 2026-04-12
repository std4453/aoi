import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import pLimit from 'p-limit';
import {
  getExtractedImagesDir,
  getGeneratedDir,
  ensureDir,
} from './storage.js';
import type { CompressionOptions, CompressionResult, FileSelection } from '../types.js';

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.avif', '.heic', '.heif',
]);

function walkImages(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    // Skip macOS __MACOSX directories and AppleDouble resource fork files
    if (entry.name === '__MACOSX' || entry.name.startsWith('._')) continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkImages(fullPath));
    } else if (entry.isFile()) {
      const ext = path.extname(entry.name).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        results.push(fullPath);
      }
    }
  }
  return results;
}

async function compressImage(
  inputPath: string,
  outputPath: string,
  options: CompressionOptions
): Promise<CompressionResult> {
  let pipeline = sharp(inputPath);

  const metadata = await pipeline.metadata();

  // Scale if enabled and image exceeds max dimension
  if (options.scaleImages && options.maxDimension) {
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    const isLongImage = height > width * 3;
    const needsScale = isLongImage
      ? width > options.maxDimension
      : width > options.maxDimension || height > options.maxDimension;
    if (needsScale) {
      pipeline = pipeline.resize(options.maxDimension, options.maxDimension, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
  }

  pipeline = pipeline.jpeg({
    quality: options.quality,
    mozjpeg: true,
    chromaSubsampling: '4:2:0',
  });

  await pipeline.toFile(outputPath);

  const outputStat = await fs.promises.stat(outputPath);
  const inputStat = await fs.promises.stat(inputPath);

  return {
    originalSize: inputStat.size,
    compressedSize: outputStat.size,
    savings: 1 - outputStat.size / inputStat.size,
  };
}

export const imageCompressor = {
  async compressPack(
    packId: string,
    options: CompressionOptions,
    onProgress?: (progress: {
      completed: number;
      total: number;
      percentage: number;
      totalOriginalSize: number;
      totalCompressedSize: number;
    }) => void,
    fileSelection?: FileSelection
  ): Promise<void> {
    const imagesDir = getExtractedImagesDir(packId);
    const outputDir = path.join(getGeneratedDir(packId), 'temp');
    ensureDir(outputDir);

    if (!fs.existsSync(imagesDir)) return;

    const allFiles = walkImages(imagesDir);
    const files = fileSelection?.images
      ? allFiles.filter(f => {
          const relPath = path.relative(imagesDir, f).split(path.sep).join('/');
          return fileSelection.images!.includes(relPath);
        })
      : allFiles;

    const limit = pLimit(Math.max(1, os.cpus().length - 1));
    let completed = 0;
    let totalOriginalSize = 0;
    let totalCompressedSize = 0;

    await Promise.all(
      files.map((fullPath) =>
        limit(async () => {
          const relativePath = path.relative(imagesDir, fullPath);
          const output = path.join(outputDir, relativePath.replace(/\.[^.]+$/, '.jpg'));
          try {
            ensureDir(path.dirname(output));
            const result = await compressImage(fullPath, output, options);
            completed++;
            totalOriginalSize += result.originalSize;
            totalCompressedSize += result.compressedSize;
          } catch (err) {
            console.error(`Failed to compress ${relativePath}:`, err);
            completed++;
          }
          onProgress?.({
            completed,
            total: files.length,
            percentage: Math.round((completed / files.length) * 100),
            totalOriginalSize,
            totalCompressedSize,
          });
        })
      )
    );
  },
};

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import pLimit from 'p-limit';
import { config } from '../config/index.js';
import {
  getExtractedImagesDir,
  getGeneratedDir,
  ensureDir,
} from './storage.js';
import type { CompressionOptions, CompressionResult, FileSelection } from '../types.js';
import { buildJpegOutputPaths } from './jpeg-output-path.js';
import { isUgoira, readUgoiraManifest } from './ugoira.js';

const IMAGE_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif', '.avif', '.heic', '.heif', '.ugoira',
]);

function openImage(imagePath: string): ReturnType<typeof sharp> {
  return sharp(imagePath, {
    failOn: 'error',
    limitInputPixels: config.maxImagePixels,
  });
}

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
  let pipeline = openImage(inputPath);

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
    fs.rmSync(outputDir, { recursive: true, force: true });
    ensureDir(outputDir);

    if (!fs.existsSync(imagesDir)) return;

    const allFiles = walkImages(imagesDir);
    const filesByRelativePath = new Map(
      allFiles.map(file => [
        path.relative(imagesDir, file).split(path.sep).join('/'),
        file,
      ])
    );
    const selectedImages = fileSelection?.images
      ? new Set(fileSelection.images)
      : undefined;
    if (selectedImages) {
      const missing = [...selectedImages].filter(relativePath => !filesByRelativePath.has(relativePath));
      if (missing.length > 0) {
        throw new Error(
          `Selected image files no longer exist: ${missing.slice(0, 5).join(', ')}`
        );
      }
    }
    const files = selectedImages
      ? [...selectedImages].map(relativePath => filesByRelativePath.get(relativePath)!)
      : allFiles;
    const relativePaths = files.map(file =>
      path.relative(imagesDir, file).split(path.sep).join('/')
    );
    const outputPaths = buildJpegOutputPaths(relativePaths);

    const limit = pLimit(Math.max(1, Math.min(8, os.cpus().length - 1)));
    let completed = 0;
    let totalOriginalSize = 0;
    let totalCompressedSize = 0;
    const failures: string[] = [];

    await Promise.all(
      files.map((fullPath) =>
        limit(async () => {
          const relativePath = path.relative(imagesDir, fullPath);
          const portablePath = relativePath.split(path.sep).join('/');
          const outputRelativePath = isUgoira(portablePath) ? portablePath : outputPaths.get(portablePath);
          if (!outputRelativePath) throw new Error(`Missing output path for ${portablePath}`);
          const output = path.join(outputDir, ...outputRelativePath.split('/'));
          try {
            ensureDir(path.dirname(output));
            let result: CompressionResult;
            if (isUgoira(fullPath)) {
              await readUgoiraManifest(fullPath);
              await fs.promises.copyFile(fullPath, output);
              const size = (await fs.promises.stat(fullPath)).size;
              result = { originalSize: size, compressedSize: size, savings: 0 };
            } else result = await compressImage(fullPath, output, options);
            completed++;
            totalOriginalSize += result.originalSize;
            totalCompressedSize += result.compressedSize;
          } catch (err) {
            console.error(`Failed to compress ${relativePath}:`, err);
            failures.push(portablePath);
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

    if (failures.length > 0) {
      throw new Error(
        `Failed to compress ${failures.length} image(s): ${failures.slice(0, 5).join(', ')}`
      );
    }
  },
};

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import pLimit from 'p-limit';
import { encode as blurhashEncode } from 'blurhash';
import {
  getExtractedImagesDir,
  getThumbnailsDir,
  ensureDir,
  getPath,
} from './storage.js';

/**
 * Blurhash 计算流程
 *
 * 在缩略图生成时同步计算每张图片的 blurhash，单图失败不阻断整体流程。
 *
 * Sharp 管道：
 *   .resize(64, 64, { fit: 'inside', withoutEnlargement: true })
 *   → 保持宽高比缩放至 64×64 以内（小图不放大）
 *   .toColorspace('srgb')
 *   → 确保 blurhash 编码使用 sRGB 色彩空间，避免色差
 *   .raw().ensureAlpha()
 *   → 输出 RGBA 原始像素数据，blurhash 编码需要
 *
 * 编码参数：4×3 组件（BLURHASH_COMPONENTS_X × BLURHASH_COMPONENTS_Y），
 * 在清晰度和编码长度之间取平衡。
 *
 * 结果格式：`{ hash: string, width: number, height: number }`
 * - hash：blurhash 编码字符串
 * - width/height：原始图片分辨率，用于客户端按比例解码和渲染占位图
 *
 * 存储路径：DB packs.blurhashes 列（JSON 格式），
 * key 为缩略图相对路径（如 "NR/scene.jpg"），value 为 BlurhashResult。
 * API 返回缩略图列表时从 DB 读取，不重复计算。
 */

const THUMB_SIZE = 300;
const THUMB_QUALITY = 70;
const COVER_WIDTH = 400;
const COVER_HEIGHT = 300;
const BLURHASH_COMPONENTS_X = 4;
const BLURHASH_COMPONENTS_Y = 3;

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

interface BlurhashResult {
  hash: string;
  width: number;
  height: number;
}

async function computeBlurhash(imagePath: string): Promise<BlurhashResult | null> {
  try {
    const metadata = await sharp(imagePath).metadata();
    const origWidth = metadata.width;
    const origHeight = metadata.height;
    if (!origWidth || !origHeight) return null;

    const { data, info } = await sharp(imagePath)
      .resize(64, 64, { fit: 'inside', withoutEnlargement: true })
      .toColorspace('srgb')
      .raw()
      .ensureAlpha()
      .toBuffer({ resolveWithObject: true });

    const hash = blurhashEncode(
      new Uint8ClampedArray(data),
      info.width,
      info.height,
      BLURHASH_COMPONENTS_X,
      BLURHASH_COMPONENTS_Y,
    );

    return { hash, width: origWidth, height: origHeight };
  } catch {
    return null;
  }
}

async function generateThumbnail(inputPath: string, outputPath: string): Promise<void> {
  await sharp(inputPath)
    .resize(THUMB_SIZE, THUMB_SIZE, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
    .toFile(outputPath);
}

async function generateCover(inputPath: string, outputPath: string): Promise<void> {
  await sharp(inputPath)
    .resize(COVER_WIDTH, COVER_HEIGHT, { fit: 'cover' })
    .jpeg({ quality: THUMB_QUALITY, mozjpeg: true })
    .toFile(outputPath);
}

export const thumbnailGenerator = {
  async generateAll(
    packId: string,
    onProgress?: (progress: { completed: number; total: number; percentage: number }) => void
  ): Promise<Record<string, BlurhashResult>> {
    const imagesDir = getExtractedImagesDir(packId);
    const thumbDir = getThumbnailsDir(packId);
    ensureDir(thumbDir);

    if (!fs.existsSync(imagesDir)) return {};

    const files = walkImages(imagesDir);

    if (files.length === 0) return {};

    const limit = pLimit(Math.max(1, os.cpus().length));
    let completed = 0;
    const total = files.length;
    const blurhashes: Record<string, BlurhashResult> = {};

    // Generate cover from first usable image
    const coverPath = getPath('thumbnails', packId);
    ensureDir(coverPath);
    for (const candidate of files) {
      try {
        await generateCover(candidate, path.join(coverPath, '_cover.jpg'));
        break;
      } catch (err) {
        console.error(`Failed to generate cover from ${path.relative(imagesDir, candidate)}:`, err);
      }
    }

    await Promise.all(
      files.map((fullPath) =>
        limit(async () => {
          const relativePath = path.relative(imagesDir, fullPath);
          const thumbRelPath = relativePath.replace(/\.[^.]+$/, '.jpg');
          const output = path.join(thumbDir, thumbRelPath);
          try {
            ensureDir(path.dirname(output));
            await generateThumbnail(fullPath, output);
          } catch (err) {
            console.error(`Failed to generate thumbnail for ${relativePath}:`, err);
            try {
              ensureDir(path.dirname(output));
              await sharp(fullPath)
                .jpeg({ quality: THUMB_QUALITY })
                .toFile(output);
            } catch {
              // Give up on this image
            }
          }

          // Compute blurhash from the original image
          const blurResult = await computeBlurhash(fullPath);
          if (blurResult) {
            blurhashes[thumbRelPath] = blurResult;
          }

          completed++;
          onProgress?.({
            completed,
            total,
            percentage: Math.round((completed / total) * 100),
          });
        })
      )
    );

    return blurhashes;
  },
};

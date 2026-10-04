import fs from 'node:fs';
import path from 'node:path';
import { moveFilesFromTemp, walkDir } from './file-classifier';
import type { ExtractStats } from './file-classifier';
import { getFolderStagingDir, getExtractedImagesDir, getExtractedVideosDir } from './storage';

interface FolderProcessResult extends ExtractStats {
  structureType: string;
}

function measureFiles(dir: string): { count: number; size: number; structured: boolean } {
  if (!fs.existsSync(dir)) return { count: 0, size: 0, structured: false };
  const files = walkDir(dir);
  return {
    count: files.length,
    size: files.reduce((sum, file) => sum + fs.statSync(file).size, 0),
    structured: files.some(file => path.relative(dir, file).includes(path.sep)),
  };
}

export const folderProcessor = {
  /**
   * After all files are uploaded to staging, classify and move them
   * into images/ and videos/ directories (same as archive extraction).
   * Also determines structure_type based on directory layout.
   */
  processUploadedFolder(packId: string): FolderProcessResult {
    const stagingDir = getFolderStagingDir(packId);
    const imagesDir = getExtractedImagesDir(packId);
    const videosDir = getExtractedVideosDir(packId);

    if (
      !fs.existsSync(stagingDir) &&
      !fs.existsSync(imagesDir) &&
      !fs.existsSync(videosDir)
    ) {
      throw new Error('Staging directory not found');
    }

    if (fs.existsSync(stagingDir)) {
      // Moving within DATA_DIR is atomic per file. If the process stops midway,
      // a retry moves only the files still in staging and then recomputes totals
      // from the complete destination trees.
      moveFilesFromTemp(stagingDir, imagesDir, videosDir);
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }

    const images = measureFiles(imagesDir);
    const videos = measureFiles(videosDir);
    return {
      imageCount: images.count,
      videoCount: videos.count,
      totalImagesSize: images.size,
      totalVideosSize: videos.size,
      structureType: images.structured || videos.structured ? 'structured' : 'flat',
    };
  },
};

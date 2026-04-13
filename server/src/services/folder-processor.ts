import fs from 'node:fs';
import path from 'node:path';
import { moveFilesFromTemp, analyzeStructure } from './file-classifier.js';
import type { ExtractStats } from './file-classifier.js';
import { getFolderStagingDir, getExtractedImagesDir, getExtractedVideosDir } from './storage.js';

interface FolderProcessResult extends ExtractStats {
  structureType: string;
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

    if (!fs.existsSync(stagingDir)) {
      throw new Error('Staging directory not found');
    }

    // analyzeStructure handles wrapper directory stripping automatically
    // (webkitRelativePath includes root folder name, which gets stripped as a single wrapper dir)
    const basePath = analyzeStructure(stagingDir);

    // Determine structure_type from the analyzed directory
    const innerEntries = fs.readdirSync(basePath, { withFileTypes: true });
    const innerDirs = innerEntries.filter(e => e.isDirectory());
    const structureType = innerDirs.length > 0 ? 'structured' : 'flat';

    // Move files to images/ and videos/ directories
    const stats = moveFilesFromTemp(stagingDir, imagesDir, videosDir);

    // Clean up staging directory (moveFilesFromTemp may leave empty dirs)
    if (fs.existsSync(stagingDir)) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }

    return { ...stats, structureType };
  },
};

import type { FastifyPluginAsync } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import {
  listPacks,
  listPacksPaginated,
  getPack,
  deletePack as deletePackFromDb,
  createPack,
  updatePackStatus,
  renamePack as renamePackInDb,
  listTags as listTagsFromDb,
  createTag as createTagInDb,
  renameTag as renameTagInDb,
  deleteTag as deleteTagFromDb,
  setPackTags as setPackTagsInDb,
  getPackBlurhashes,
} from '../db/repositories.js';
import { removePackFiles, ensureDir, getArchivePath, getThumbnailsDir, getExtractedImagesDir, getExtractedVideosDir } from '../services/storage.js';
import { config } from '../config.js';
import { jobQueue } from '../services/job-queue.js';

export const registerPackRoutes: FastifyPluginAsync = async function (fastify) {
  // List packs (paginated, with search)
  fastify.get<{
    Querystring: { page?: string; pageSize?: string; search?: string };
  }>('/api/packs', async (request) => {
    const { page, pageSize, search } = request.query;
    return listPacksPaginated({
      page: page ? parseInt(page, 10) : undefined,
      pageSize: pageSize ? parseInt(pageSize, 10) : undefined,
      search: search || undefined,
    });
  });

  // Get single pack (with tags)
  fastify.get<{
    Params: { id: string };
  }>('/api/packs/:id', async (request) => {
    const pack = getPack(request.params.id);
    if (!pack) {
      return { error: 'Pack not found' };
    }
    return pack;
  });

  // List all tags (with usage count and sample covers)
  fastify.get('/api/tags', async () => {
    const tags = listTagsFromDb();
    const packs = listPacks();
    const usageCount = new Map<string, number>();
    const tagCovers = new Map<string, string[]>();
    for (const pack of packs) {
      for (const tag of pack.tags) {
        usageCount.set(tag.id, (usageCount.get(tag.id) || 0) + 1);
        const covers = tagCovers.get(tag.id) || [];
        if (covers.length < 8) {
          covers.push(`/api/packs/${pack.id}/cover`);
        }
        tagCovers.set(tag.id, covers);
      }
    }
    return tags.map(tag => ({
      ...tag,
      count: usageCount.get(tag.id) || 0,
      covers: tagCovers.get(tag.id) || [],
    }));
  });

  // Create a tag
  fastify.post<{
    Body: { name: string };
  }>('/api/tags', async (request) => {
    const name = request.body.name?.trim();
    if (!name) {
      return { error: 'Name is required' };
    }
    try {
      return createTagInDb(name);
    } catch (err) {
      return { error: 'Tag already exists' };
    }
  });

  // Rename a tag
  fastify.patch<{
    Params: { id: string };
    Body: { name: string };
  }>('/api/tags/:id', async (request, reply) => {
    const tag = listTagsFromDb().find(t => t.id === request.params.id);
    if (!tag) {
      reply.code(404).send({ error: 'Tag not found' });
      return;
    }
    const newName = request.body.name?.trim();
    if (!newName) {
      reply.code(400).send({ error: 'Name is required' });
      return;
    }
    try {
      return renameTagInDb(tag.id, newName);
    } catch (err) {
      return { error: 'Tag name already exists' };
    }
  });

  // Get packs by tag
  fastify.get<{
    Params: { id: string };
  }>('/api/tags/:id/packs', async (request, reply) => {
    const tag = listTagsFromDb().find(t => t.id === request.params.id);
    if (!tag) {
      reply.code(404).send({ error: 'Tag not found' });
      return;
    }
    const allPacks = listPacks();
    return allPacks.filter(p => p.tags.some(t => t.id === tag.id));
  });

  // Delete a tag
  fastify.delete<{
    Params: { id: string };
  }>('/api/tags/:id', async (request, reply) => {
    const tag = listTagsFromDb().find(t => t.id === request.params.id);
    if (!tag) {
      reply.code(404).send({ error: 'Tag not found' });
      return;
    }
    deleteTagFromDb(tag.id);
    return { ok: true };
  });

  // Update pack tags
  fastify.put<{
    Params: { id: string };
    Body: { tagIds: string[] };
  }>('/api/packs/:id/tags', async (request, reply) => {
    const pack = getPack(request.params.id);
    if (!pack) {
      reply.code(404).send({ error: 'Pack not found' });
      return;
    }
    setPackTagsInDb(pack.id, request.body.tagIds || []);
    return getPack(pack.id);
  });

  // Delete a pack
  fastify.delete<{
    Params: { id: string };
  }>('/api/packs/:id', async (request, reply) => {
    const pack = getPack(request.params.id);
    if (!pack) {
      reply.code(404).send({ error: 'Pack not found' });
      return;
    }
    removePackFiles(pack.id);
    deletePackFromDb(pack.id);
    return { ok: true };
  });

  // Rename a pack
  fastify.patch<{
    Params: { id: string };
    Body: { name: string };
  }>('/api/packs/:id', async (request, reply) => {
    const pack = getPack(request.params.id);
    if (!pack) {
      reply.code(404).send({ error: 'Pack not found' });
      return;
    }
    const newName = request.body.name?.trim();
    if (!newName) {
      reply.code(400).send({ error: 'Name is required' });
      return;
    }
    const updated = renamePackInDb(pack.id, newName);
    return updated;
  });

  // Confirm upload completion and start processing
  fastify.post<{
    Body: {
      uploadId: string;
      filename: string;
      fileSize: number;
      packName?: string;
      archivePassword?: string;
      tagIds?: string[];
    };
  }>('/api/packs/upload-complete', async (request, reply) => {
    const { uploadId, filename, fileSize, packName, archivePassword, tagIds } = request.body;

    // Find the uploaded file in tus file store
    const uploadPath = path.join(config.dirs.uploads, uploadId);

    if (!fs.existsSync(uploadPath)) {
      reply.code(404).send({ error: 'Upload file not found' });
      return;
    }

    const actualSize = fs.statSync(uploadPath).size;

    const ext = path.extname(filename).toLowerCase().replace('.', '');
    if (!['zip', 'rar'].includes(ext)) {
      reply.code(400).send({ error: 'Unsupported format. Only ZIP and RAR are supported.' });
      return;
    }

    try {
      const packNameToUse = packName || path.basename(filename, path.extname(filename));
      const pack = createPack({
        name: packNameToUse,
        originalFilename: filename,
        originalSize: fileSize,
        originalFormat: ext,
        archivePassword,
      });

      // Set tags if provided
      if (tagIds && tagIds.length > 0) {
        setPackTagsInDb(pack.id, tagIds);
      }

      // Move uploaded file to archives directory
      const archiveDir = path.join(config.dirs.archives, pack.id);
      ensureDir(archiveDir);
      const archivePath = getArchivePath(pack.id, `original.${ext}`);
      fs.renameSync(uploadPath, archivePath);

      // Remove tus upload directory if it exists
      const uploadDir = path.dirname(uploadPath);
      if (uploadDir !== config.dirs.uploads) {
        fs.rmSync(uploadDir, { recursive: true, force: true });
      }

      // Start extraction job
      await jobQueue.enqueue(pack.id, 'extract');

      // Return pack with tags
      return getPack(pack.id);
    } catch (err) {
      console.error('[upload-complete] Error:', err);
      reply.code(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Serve original image for preview (supports subdirectory paths)
  fastify.get<{
    Params: { id: string; '*': string };
  }>('/api/packs/:id/images/*', async (request, reply) => {
    const imagesDir = getExtractedImagesDir(request.params.id);
    const relPath = request.params['*'];
    const resolved = path.resolve(imagesDir, relPath);
    if (!resolved.startsWith(imagesDir)) {
      reply.code(403).send({ error: 'Forbidden' });
      return;
    }
    if (!fs.existsSync(resolved)) {
      reply.code(404).send({ error: 'Image not found' });
      return;
    }
    return reply.sendFile(path.basename(resolved), path.dirname(resolved));
  });

  // Serve thumbnail for a pack (supports subdirectory paths)
  fastify.get<{
    Params: { id: string; '*': string };
  }>('/api/packs/:id/thumbnails/*', async (request, reply) => {
    const thumbDir = getThumbnailsDir(request.params.id);
    const relPath = request.params['*'];
    const resolved = path.resolve(thumbDir, relPath);
    if (!resolved.startsWith(thumbDir)) {
      reply.code(403).send({ error: 'Forbidden' });
      return;
    }
    if (!fs.existsSync(resolved)) {
      reply.code(404).send({ error: 'Thumbnail not found' });
      return;
    }
    return reply.sendFile(path.basename(resolved), path.dirname(resolved));
  });

  // Serve cover image (first thumbnail)
  fastify.get<{
    Params: { id: string };
  }>('/api/packs/:id/cover', async (request, reply) => {
    const thumbDir = getThumbnailsDir(request.params.id);
    if (!fs.existsSync(thumbDir)) {
      reply.code(404).send({ error: 'No thumbnails' });
      return;
    }
    const allThumbs = walkDirForExt(thumbDir, '.jpg');
    if (allThumbs.length === 0) {
      reply.code(404).send({ error: 'No thumbnails' });
      return;
    }
    allThumbs.sort();
    const firstRel = allThumbs[0];
    const resolved = path.join(thumbDir, firstRel);
    return reply.sendFile(path.basename(resolved), path.dirname(resolved));
  });

  // List thumbnails for a pack
  fastify.get<{
    Params: { id: string };
  }>('/api/packs/:id/thumbnails', async (request, reply) => {
    const thumbDir = getThumbnailsDir(request.params.id);
    const imagesDir = getExtractedImagesDir(request.params.id);
    if (!fs.existsSync(thumbDir)) {
      return [];
    }
    const imageExts = new Set(['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.tif']);

    // Load blurhashes from DB
    const blurhashMap = getPackBlurhashes(request.params.id);

    // Build lookup from relative stem → original relative file
    let originalFiles: Map<string, string> | null = null;
    if (fs.existsSync(imagesDir)) {
      originalFiles = new Map();
      const allImages = walkDirForExt(imagesDir, null);
      for (const rel of allImages) {
        const stem = rel.replace(/\.[^.]+$/, '');
        originalFiles.set(stem, rel);
      }
    }

    const thumbFiles = walkDirForExt(thumbDir, '.jpg');

    // Sort by path, segment by segment, with numeric awareness
    thumbFiles.sort((a, b) => {
      const aParts = a.split(/[/\\]/);
      const bParts = b.split(/[/\\]/);
      for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
        const cmp = aParts[i].localeCompare(bParts[i], undefined, { numeric: true });
        if (cmp !== 0) return cmp;
      }
      return aParts.length - bParts.length;
    });

    return thumbFiles.map(relPath => {
      const stem = relPath.replace(/\.jpg$/, '');
      const originalFile = originalFiles?.get(stem) ?? relPath;
      const bh = blurhashMap[relPath];
      return {
        name: relPath,
        thumbUrl: `/api/packs/${request.params.id}/thumbnails/${relPath}`,
        imageUrl: `/api/packs/${request.params.id}/images/${originalFile}`,
        blurhash: bh?.hash ?? null,
        width: bh?.width ?? null,
        height: bh?.height ?? null,
      };
    });
  });

  // Get file tree for a pack
  fastify.get<{
    Params: { id: string };
  }>('/api/packs/:id/file-tree', async (request, reply) => {
    const pack = getPack(request.params.id);
    if (!pack) {
      reply.code(404).send({ error: 'Pack not found' });
      return;
    }

    const imagesDir = getExtractedImagesDir(request.params.id);
    const videosDir = getExtractedVideosDir(request.params.id);
    const thumbDir = getThumbnailsDir(request.params.id);

    const imageFiles = fs.existsSync(imagesDir) ? walkDirWithSize(imagesDir) : [];
    const videoFiles = fs.existsSync(videosDir) ? walkDirWithSize(videosDir) : [];
    const hasThumbnails = fs.existsSync(thumbDir);

    return buildFileTree(request.params.id, imageFiles, videoFiles, hasThumbnails);
  });

};

function walkDirForExt(dir: string, ext: string | null): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const child = walkDirForExt(fullPath, ext);
      for (const c of child) {
        results.push(path.join(entry.name, c));
      }
    } else if (entry.isFile()) {
      if (ext === null || path.extname(entry.name).toLowerCase() === ext) {
        results.push(entry.name);
      }
    }
  }
  return results;
}

function walkDirWithSize(dir: string): { relPath: string; size: number }[] {
  const results: { relPath: string; size: number }[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const child = walkDirWithSize(fullPath);
      for (const c of child) {
        results.push({ relPath: path.join(entry.name, c.relPath), size: c.size });
      }
    } else if (entry.isFile()) {
      const stat = fs.statSync(fullPath);
      results.push({ relPath: entry.name, size: stat.size });
    }
  }
  return results;
}

function buildFileTree(
  packId: string,
  imageFiles: { relPath: string; size: number }[],
  videoFiles: { relPath: string; size: number }[],
  hasThumbnails: boolean
): import('../types.js').FileTreeNode[] {
  type NodeMap = Map<string, import('../types.js').FileTreeNode>;
  const rootChildren: NodeMap = new Map();
  const allNodes: Map<string, NodeMap> = new Map();
  allNodes.set('', rootChildren);

  // Ensure all ancestor folders exist
  function ensureFolder(folderPath: string): NodeMap {
    if (allNodes.has(folderPath)) return allNodes.get(folderPath)!;
    const children: NodeMap = new Map();
    allNodes.set(folderPath, children);

    const parentPath = folderPath.includes('/') ? folderPath.substring(0, folderPath.lastIndexOf('/')) : '';
    const name = folderPath.includes('/') ? folderPath.substring(folderPath.lastIndexOf('/') + 1) : folderPath;
    const parent = ensureFolder(parentPath);

    if (!parent.has(name)) {
      parent.set(name, {
        name,
        type: 'folder',
        path: folderPath,
        children: [],
      });
    }
    // Update children reference
    const node = parent.get(name)!;
    node.children = Array.from(children.values());
    return children;
  }

  // Add image files
  for (const { relPath, size } of imageFiles) {
    const normalized = relPath.split(path.sep).join('/');
    const parts = normalized.split('/');
    const name = parts[parts.length - 1];
    const folderPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';

    ensureFolder(folderPath);

    const stem = normalized.replace(/\.[^.]+$/, '');
    const thumbUrl = hasThumbnails ? `/api/packs/${packId}/thumbnails/${stem}.jpg` : undefined;
    const imageUrl = `/api/packs/${packId}/images/${normalized}`;

    const folder = allNodes.get(folderPath)!;
    folder.set(name, {
      name,
      type: 'image',
      path: normalized,
      size,
      thumbUrl,
      imageUrl,
    });
  }

  // Add video files
  for (const { relPath, size } of videoFiles) {
    const normalized = relPath.split(path.sep).join('/');
    const parts = normalized.split('/');
    const name = parts[parts.length - 1];
    const folderPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';

    ensureFolder(folderPath);

    const folder = allNodes.get(folderPath)!;
    folder.set(name, {
      name,
      type: 'video',
      path: normalized,
      size,
    });
  }

  // Rebuild children arrays from maps (folders that were created before their files were added)
  for (const [folderPath, children] of allNodes) {
    const sortedChildren = Array.from(children.values()).sort((a, b) => {
      // Folders first, then files; within each group, sort by name with numeric awareness
      if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true });
    });
    if (folderPath === '') continue;
    const parts = folderPath.split('/');
    const parentPath = parts.length > 1 ? parts.slice(0, -1).join('/') : '';
    const folderName = parts[parts.length - 1];
    const parent = allNodes.get(parentPath);
    if (parent?.has(folderName)) {
      parent.get(folderName)!.children = sortedChildren;
    }
  }

  // Compute folder sizes (sum of all descendant file sizes)
  function computeFolderSize(node: import('../types.js').FileTreeNode): number {
    if (node.type !== 'folder') return node.size ?? 0;
    let total = 0;
    for (const child of node.children ?? []) {
      total += computeFolderSize(child);
    }
    node.size = total;
    return total;
  }

  const result = Array.from(rootChildren.values()).sort((a, b) => {
    if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { numeric: true });
  });

  for (const node of result) computeFolderSize(node);

  return result;
}

import { get, post, patch, del, put } from './client';
import type { Pack, CompressionOptions, Tag, FileSelection, FileTreeNode } from '../../../shared/types.js';

export interface TagWithStats extends Tag {
  count: number;
  covers: string[];
}

export interface PackListResponse {
  packs: Pack[];
}

export function fetchPacks(): Promise<Pack[]> {
  return get<Pack[]>('/packs');
}

export function fetchPack(id: string): Promise<Pack> {
  return get<Pack>(`/packs/${id}`);
}

export function removePack(id: string): Promise<void> {
  return del<void>(`/packs/${id}`);
}

export function renamePack(id: string, name: string): Promise<Pack> {
  return patch<Pack>(`/packs/${id}`, { name });
}

export function confirmUpload(data: {
  uploadId: string;
  filename: string;
  fileSize: number;
  packName?: string;
  archivePassword?: string;
  tagIds?: string[];
}): Promise<Pack> {
  return post<Pack>('/packs/upload-complete', data);
}

export function fetchTags(): Promise<TagWithStats[]> {
  return get<TagWithStats[]>('/tags');
}

export function createTag(name: string): Promise<Tag> {
  return post<Tag>('/tags', { name });
}

export function renameTag(id: string, name: string): Promise<Tag> {
  return patch<Tag>(`/tags/${id}`, { name });
}

export function fetchTagPacks(tagId: string): Promise<Pack[]> {
  return get<Pack[]>(`/tags/${tagId}/packs`);
}

export function removeTag(id: string): Promise<void> {
  return del<void>(`/tags/${id}`);
}

export function updatePackTags(packId: string, tagIds: string[]): Promise<Pack> {
  return put<Pack>(`/packs/${packId}/tags`, { tagIds });
}

export function fetchThumbnails(packId: string): Promise<{ name: string; thumbUrl: string; imageUrl: string; blurhash: string | null; width: number | null; height: number | null }[]> {
  return get<{ name: string; thumbUrl: string; imageUrl: string; blurhash: string | null; width: number | null; height: number | null }[]>(`/packs/${packId}/thumbnails`);
}

export function startProcessing(
  packId: string,
  options?: { presetId?: string; options?: CompressionOptions; fileSelection?: FileSelection }
): Promise<{ jobId: string }> {
  return post<{ jobId: string }>(`/packs/${packId}/process`, options);
}

export function fetchFileTree(packId: string): Promise<FileTreeNode[]> {
  return get<FileTreeNode[]>(`/packs/${packId}/file-tree`);
}

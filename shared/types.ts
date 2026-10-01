export interface CompressionOptions {
  format: 'jpeg';
  quality: number;
  keepVideos: boolean;
  scaleImages: boolean;
  maxDimension: number;
}

export const DEFAULT_COMPRESSION_OPTIONS: CompressionOptions = {
  format: 'jpeg',
  quality: 80,
  keepVideos: true,
  scaleImages: true,
  maxDimension: 1920,
};

export interface Pack {
  id: string;
  name: string;
  originalFilename: string;
  originalSize: number;
  originalFormat: string;
  sourceType: 'archive' | 'folder';
  status: PackStatus;
  verification?: VerificationProgress;
  imageCount: number;
  videoCount: number;
  totalImagesSize: number;
  totalVideosSize: number;
  errorMessage: string | null;
  compressedSize: number;
  tags: Tag[];
  createdAt: string;
  updatedAt: string;
}

export interface PackFile {
  id: string;
  packId: string;
  relativePath: string;
  fileSize: number;
  uploadId: string | null;
  status: 'pending' | 'uploading' | 'uploaded' | 'failed';
  createdAt: string;
  uploadedAt: string | null;
}

export interface Tag {
  id: string;
  name: string;
}

export type PackStatus =
  | 'uploading'
  | 'extracting'
  | 'verifying'
  | 'awaiting_confirmation'
  | 'thumbnailing'
  | 'extracted'
  | 'generating'
  | 'generated'
  | 'failed';

export interface Preset {
  id: string;
  name: string;
  isDefault: boolean;
  options: CompressionOptions;
  createdAt: string;
  updatedAt: string;
}

export interface Job {
  id: string;
  packId: string;
  type: 'extract' | 'thumbnail' | 'compress' | 'verify';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  options: string | null;
  result: string | null;
  error: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface JobProgress {
  jobId: string;
  status: Job['status'];
  phase: string;
  completed: number;
  total: number;
  percentage: number;
  totalOriginalSize: number;
  totalCompressedSize: number;
  error: string | null;
}

export interface CompressionResult {
  originalSize: number;
  compressedSize: number;
  savings: number;
}

export interface FileSelection {
  images: string[];
  videos: string[];
}

export interface FileTreeNode {
  name: string;
  type: 'folder' | 'image' | 'video';
  path: string;
  size?: number;
  thumbUrl?: string;
  imageUrl?: string;
  videoUrl?: string;
  children?: FileTreeNode[];
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PackListParams {
  page?: number;
  pageSize?: number;
  search?: string;
}

export interface ArchiveUploadRequest {
  uploadId: string;
  filename: string;
  fileSize: number;
  packName?: string;
  archivePassword?: string;
  tagIds?: string[];
  allowDuplicate?: boolean;
}

export type DuplicatePack = Pick<Pack, 'id' | 'name' | 'status'>;

export interface DuplicateArchiveResponse {
  code: 'DUPLICATE_ARCHIVE';
  matches: DuplicatePack[];
}

export interface VerificationProgress {
  status: 'pending' | 'completed' | 'failed';
  percentage: number;
  error: string | null;
  allowsPreview: boolean;
}

export interface FolderUploadStatus {
  pack: Pack;
  matches: DuplicatePack[];
}

// Runtime deployment and browser connection contracts.
export interface RuntimeConfig {
  serverSelectionEnabled: boolean;
}

export interface ServerConnection {
  id: string;
  alias: string;
  address: string;
  key: string;
  writable?: boolean;
}

export interface ServerHealth {
  status: 'ok';
  service: 'aoi';
  authRequired: boolean;
  writable?: boolean;
  role?: 'standalone' | 'replica';
  capabilities?: { generatedArchiveDownload: boolean; snapshots: boolean };
  replicationProtocol?: string;
}

export interface LoginResponse {
  token: string;
}


// Public snapshot wire contract; version matching is enforced by the backend.
export interface SnapshotFile { path: string; hash: string; size: number }
export interface PackSnapshot {
  protocol: string;
  scope: string;
  metadata: Pick<Pack, 'id' | 'name' | 'originalFilename' | 'originalSize' | 'originalFormat' | 'sourceType' | 'createdAt' | 'updatedAt' | 'tags'>;
  contentHash: string;
  revision: string;
  files: SnapshotFile[];
}
export interface PackSnapshotIndex {
  protocol: string;
  scope: string;
  datasetId: string;
  packs: Array<{ id: string; state: 'ready'; revision: string } | { id: string; state: 'pending' }>;
}

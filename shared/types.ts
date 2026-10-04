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
  type: 'extract' | 'thumbnail' | 'compress' | 'verify' | 'pixiv' | 'fanbox';
  status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number;
  options: string | null;
  result: string | null;
  error: string | null;
  errorCode?: TaskErrorCode | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface JobProgress {
  jobId: string;
  status: Job['status'];
  phase: string;
  /** Verification counts bytes; download, thumbnail, compression and archiving count files. */
  completed: number;
  total: number;
  percentage: number;
  totalOriginalSize: number;
  totalCompressedSize: number;
  error: string | null;
}

export interface UploadTaskStatus {
  pack: Pack;
  progress: JobProgress | null;
  matches: DuplicatePack[];
  retryable: boolean;
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
  mediaType?: 'image' | 'ugoira';
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
  taskId?: string;
  uploadId: string;
  filename: string;
  fileSize: number;
  packName?: string;
  archivePassword?: string;
  tagIds?: string[];
  allowDuplicate?: boolean;
}

export type RemoteTaskType = 'pixiv' | 'fanbox' | 'mega';
export type UploadTaskType = 'archive' | 'folder' | RemoteTaskType;

export type UploadTaskState = 'uploading' | 'downloading' | 'paused' | 'needs_file' | 'processing' | 'duplicate' | 'password' | 'completed' | 'failed';

export type TaskErrorCategory = 'authentication' | 'access' | 'network' | 'source' | 'storage' | 'password'
  | 'extraction' | 'verification' | 'preview' | 'upload' | 'download' | 'processing';
export type TaskErrorCode = 'AUTH_REQUIRED' | 'ACCESS_DENIED' | 'NETWORK_ERROR' | 'RATE_LIMITED'
  | 'SOURCE_UNAVAILABLE' | 'SOURCE_QUOTA' | 'NO_SUPPORTED_MEDIA' | 'SOURCE_BLOCKED' | 'CHALLENGE_FAILED'
  | 'STORAGE_FULL' | 'RESOURCE_LIMIT' | 'PASSWORD_REQUIRED' | 'PASSWORD_INCORRECT'
  | 'ARCHIVE_INVALID' | 'ARCHIVE_UNSUPPORTED' | 'EXTRACTION_FAILED'
  | 'VERIFICATION_FAILED' | 'PREVIEW_FAILED' | 'UPLOAD_FAILED' | 'DOWNLOAD_FAILED' | 'PROCESSING_FAILED';

export interface UploadTask {
  id: string;
  source: UploadTaskType;
  isRemote: boolean;
  name: string;
  filename: string;
  totalBytes: number;
  transferredBytes: number;
  progress: number;
  status: UploadTaskState;
  /** Current server processing stage; populated when reading a processing task. */
  processing?: {
    stage: 'preparing' | 'extracting' | 'verifying' | 'thumbnailing';
    queued: boolean;
    completed: number;
    total: number;
  };
  packId: string | null;
  uploadId: string | null;
  matches: DuplicatePack[];
  error: string | null;
  errorCode: TaskErrorCode | null;
  errorCategory: TaskErrorCategory | null;
  passwordKind?: 'share' | 'archive';
  createdAt: string;
  updatedAt: string;
}

export interface CreateUploadTaskRequest {
  autoName?: boolean;
  source: UploadTaskType;
  name: string;
  filename?: string;
  fileSize?: number;
  tagIds?: string[];
  url?: string;
  sharePassword?: string;
  archivePassword?: string;
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
  packFiles: PackFile[];
}

export interface PixivImportRequest {
  url: string;
  packName?: string;
  tagIds?: string[];
}

export interface MegaMetadata {
  title: string;
  filename: string;
  kind: 'archive' | 'folder';
  totalBytes: number;
}

export interface PixivMetadata {
  title: string;
  author: string;
  tags: Tag[];
  mediaType: 'image' | 'ugoira';
}

export interface PixivSettings {
  configured: boolean;
  source: 'settings' | 'environment' | 'none';
  refreshToken?: string;
  browserLoginEnabled?: boolean;
}

export interface FanboxMetadata {
  title: string;
  author: string;
  tags: Tag[];
  imageCount: number;
  videoCount: number;
  skippedCount: number;
}

export interface FanboxSettings {
  sessionId?: string;
  configured: boolean;
  source: 'settings' | 'environment' | 'cookie_file' | 'none';
  browserLoginEnabled?: boolean;
}

export type BrowserLoginProvider = 'pixiv' | 'fanbox';

export interface BrowserLoginSession {
  provider?: BrowserLoginProvider;
  completed?: boolean;
  id: string;
  expiresAt: string;
  browserUrl: string;
}

export interface UgoiraManifest {
  format: 'aoi-ugoira';
  version: 1;
  frames: Array<{ file: string; delay: number }>;
}

export interface PackThumbnail {
  name: string;
  thumbUrl: string;
  imageUrl: string;
  ugoiraUrl?: string;
  mediaType?: 'image' | 'ugoira';
  blurhash: string | null;
  width: number | null;
  height: number | null;
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
  role?: ServerHealth['role'];
  capabilities?: ServerHealth['capabilities'];
  token?: string;
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

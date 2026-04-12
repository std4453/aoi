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
  status: PackStatus;
  structureType: 'flat' | 'structured';
  imageCount: number;
  videoCount: number;
  totalImagesSize: number;
  totalVideosSize: number;
  errorMessage: string | null;
  archivePassword: string | null;
  compressedSize: number;
  tags: Tag[];
  createdAt: string;
  updatedAt: string;
}

export interface Tag {
  id: string;
  name: string;
}

export type PackStatus =
  | 'uploading'
  | 'extracting'
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
  type: 'extract' | 'thumbnail' | 'compress';
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
  children?: FileTreeNode[];
}

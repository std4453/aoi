export interface CompressionOptions {
    format: 'jpeg';
    quality: number;
    keepVideos: boolean;
    scaleImages: boolean;
    maxDimension: number;
}
export declare const DEFAULT_COMPRESSION_OPTIONS: CompressionOptions;
export interface Pack {
    id: string;
    name: string;
    originalFilename: string;
    originalSize: number;
    originalFormat: string;
    status: PackStatus;
    imageCount: number;
    videoCount: number;
    totalImagesSize: number;
    totalVideosSize: number;
    errorMessage: string | null;
    archivePassword: string | null;
    tags: Tag[];
    createdAt: string;
    updatedAt: string;
}
export interface Tag {
    id: string;
    name: string;
}
export type PackStatus = 'uploading' | 'extracting' | 'extracted' | 'generating' | 'generated' | 'failed';
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

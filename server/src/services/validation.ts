import { z } from 'zod';
import { config } from '~/config';
import { normalizeRelativePath } from './safe-path';
import type { CompressionOptions, FileSelection } from '~/types';

const compressionOptionsSchema = z.object({
  format: z.literal('jpeg'),
  quality: z.number().int().min(1).max(100),
  keepVideos: z.boolean(),
  scaleImages: z.boolean(),
  maxDimension: z.number().int().min(64).max(32_768),
}).strict();

const fileSelectionSchema = z.object({
  images: z.array(z.string()).max(config.maxArchiveEntries),
  videos: z.array(z.string()).max(config.maxArchiveEntries),
}).strict().refine(
  value => value.images.length + value.videos.length <= config.maxArchiveEntries,
  { message: `Selection cannot exceed ${config.maxArchiveEntries} files` }
).refine(
  value => value.images.length + value.videos.length > 0,
  { message: 'Selection must include at least one file' }
);

export function parseCompressionOptions(value: unknown): CompressionOptions {
  return compressionOptionsSchema.parse(value);
}

export function parseFileSelection(value: unknown): FileSelection {
  const selection = fileSelectionSchema.parse(value);
  return {
    images: [...new Set(
      selection.images.map(item => normalizeRelativePath(item, 'selected image path'))
    )],
    videos: [...new Set(
      selection.videos.map(item => normalizeRelativePath(item, 'selected video path'))
    )],
  };
}

export function formatValidationError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues.map(issue => `${issue.path.join('.') || 'value'}: ${issue.message}`).join('; ');
  }
  return error instanceof Error ? error.message : String(error);
}

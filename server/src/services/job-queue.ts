import { saveDb } from '../db/connection.js';
import { getNextPendingJob, updateJobStatus, getJob } from '../db/repositories.js';
import type { Job, JobProgress } from '../types.js';
import type { CompressionOptions } from '../types.js';
import { EventEmitter } from 'node:events';

export type JobEventType = 'progress';

class JobQueue extends EventEmitter {
  private running = false;
  private currentJobId: string | null = null;

  async enqueue(packId: string, type: Job['type'], options?: CompressionOptions): Promise<Job> {
    const { createJob } = await import('../db/repositories.js');
    const job = createJob(packId, type, options);
    this.processNext();
    return job;
  }

  private async processNext(): Promise<void> {
    if (this.running) return;

    const job = getNextPendingJob();
    if (!job) return;

    this.running = true;
    this.currentJobId = job.id;

    try {
      updateJobStatus(job.id, 'running', 0);

      switch (job.type) {
        case 'extract':
          await this.runExtractJob(job);
          break;
        case 'thumbnail':
          await this.runThumbnailJob(job);
          break;
        case 'compress':
          await this.runCompressJob(job);
          break;
      }

      updateJobStatus(job.id, 'completed', 100);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      updateJobStatus(job.id, 'failed', 0, message);
      console.error(`Job ${job.id} failed:`, message);
      // Update pack status to reflect the failure
      try {
        const { getPack, updatePackStatus } = await import('../db/repositories.js');
        const pack = getPack(job.packId);
        if (pack && pack.status !== 'failed') {
          updatePackStatus(job.packId, 'failed', message);
        }
      } catch (dbErr) {
        console.error('Failed to update pack status after job failure:', dbErr);
      }
    } finally {
      this.running = false;
      this.currentJobId = null;
      // Process next job after a short delay
      setTimeout(() => this.processNext(), 100);
    }
  }

  private async runExtractJob(job: Job): Promise<void> {
    const { archiveExtractor } = await import('./archive-extractor.js');
    const { updatePackStatus, updatePackStats, getPack, listPacks } = await import('../db/repositories.js');
    const pack = getPack(job.packId);
    if (!pack) {
      console.error(`[job-queue] Pack not found for id=${job.packId}`);
      throw new Error('Pack not found');
    }

    updatePackStatus(pack.id, 'extracting');
    await archiveExtractor.extract(pack, pack.archivePassword ?? undefined);
    // Set to 'thumbnailing' — not 'extracted' yet, thumbnails still pending
    updatePackStatus(pack.id, 'thumbnailing');

    // Enqueue thumbnail generation
    this.enqueue(pack.id, 'thumbnail');
  }

  private async runThumbnailJob(job: Job): Promise<void> {
    const { thumbnailGenerator } = await import('./thumbnail-generator.js');
    const { updatePackStatus, updatePackBlurhashes } = await import('../db/repositories.js');

    updatePackStatus(job.packId, 'thumbnailing');

    const blurhashes = await thumbnailGenerator.generateAll(job.packId, (progress) => {
      this.emitProgress(job.id, {
        jobId: job.id,
        status: 'running',
        phase: 'thumbnails',
        totalOriginalSize: 0,
        totalCompressedSize: 0,
        error: null,
        ...progress,
      });
    });

    // Batch-write all blurhashes to DB
    if (Object.keys(blurhashes).length > 0) {
      updatePackBlurhashes(job.packId, blurhashes);
    }

    this.emitProgress(job.id, {
      jobId: job.id,
      status: 'completed',
      phase: 'thumbnails',
      completed: 1,
      total: 1,
      percentage: 100,
      totalOriginalSize: 0,
      totalCompressedSize: 0,
      error: null,
    });

    updatePackStatus(job.packId, 'extracted');
  }

  private async runCompressJob(job: Job): Promise<void> {
    const { imageCompressor } = await import('./image-compressor.js');
    const { archiveGenerator } = await import('./archive-generator.js');
    const { updatePackStatus, getPack } = await import('../db/repositories.js');
    const pack = getPack(job.packId);
    if (!pack) throw new Error('Pack not found');

    const parsed: any = job.options ? JSON.parse(job.options) : {};
    const options: CompressionOptions = {
      format: parsed.format ?? 'jpeg',
      quality: parsed.quality ?? 80,
      keepVideos: parsed.keepVideos ?? true,
      scaleImages: parsed.scaleImages ?? true,
      maxDimension: parsed.maxDimension ?? 1920,
    };
    const fileSelection = parsed.fileSelection as import('../types.js').FileSelection | undefined;
    updatePackStatus(pack.id, 'generating');

    await imageCompressor.compressPack(job.packId, options, (progress) => {
      this.emitProgress(job.id, {
        jobId: job.id,
        status: 'running',
        phase: 'compressing',
        error: null,
        ...progress,
      });
    }, fileSelection);

    this.emitProgress(job.id, {
      jobId: job.id,
      status: 'running',
      phase: 'archiving',
      completed: 0,
      total: 0,
      percentage: 0,
      totalOriginalSize: 0,
      totalCompressedSize: 0,
      error: null,
    });

    await archiveGenerator.generate(pack.id, options, (progress) => {
      this.emitProgress(job.id, {
        jobId: job.id,
        status: 'running',
        phase: 'archiving',
        totalOriginalSize: 0,
        totalCompressedSize: 0,
        error: null,
        ...progress,
      });
    }, fileSelection);

    updatePackStatus(pack.id, 'generated');

    this.emitProgress(job.id, {
      jobId: job.id,
      status: 'completed',
      phase: 'archiving',
      completed: 1,
      total: 1,
      percentage: 100,
      totalOriginalSize: 0,
      totalCompressedSize: 0,
      error: null,
    });
  }

  private emitProgress(jobId: string, progress: JobProgress): void {
    updateJobStatus(jobId, 'running', progress.percentage);
    saveDb();
    this.emit('progress', progress);
  }

  getProgress(jobId: string): JobProgress | null {
    const job = getJob(jobId);
    if (!job) return null;
    const result = job.result ? JSON.parse(job.result) : null;
    return {
      jobId: job.id,
      status: job.status,
      phase: result?.phase ?? 'unknown',
      completed: result?.completed ?? 0,
      total: result?.total ?? 0,
      percentage: job.progress,
      totalOriginalSize: result?.totalOriginalSize ?? 0,
      totalCompressedSize: result?.totalCompressedSize ?? 0,
      error: job.error,
    };
  }
}

export const jobQueue = new JobQueue();

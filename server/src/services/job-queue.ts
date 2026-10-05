import { archiveErrorCode, jobFailureCode, taskErrorCode } from './task-errors';
import { config } from '~/config';
import { beginMutation } from '~/replication/state';
import { scheduleVerification, verifyPack, failVerification, resumeHistoricalVerification } from './content-verification';
import { EventEmitter } from 'node:events';
import {
  cancelPendingJobs,
  claimNextPendingJob,
  createJob,
  createJobIfIdle,
  getJob,
  hasActiveJob,
  hasActiveJobOtherThan,
  updateJobProgress,
  updateJobStatus,
} from '~/db/repositories';
import type { CompressionOptions, Job, JobProgress } from '~/types';

export type JobEventType = 'progress';

class JobQueue extends EventEmitter {
  private currentTask: Promise<void> | null = null;
  private currentJobId: string | null = null;
  private stopping = false;
  private verificationAbort: { packId: string; controller: AbortController } | null = null;
  private importAbort: { packId: string; controller: AbortController } | null = null;
  private cancellingImports = new Set<string>();

  start(): void {
    this.scheduleNext();
  }

  async enqueue(packId: string, type: Job['type'], options?: CompressionOptions): Promise<Job> {
    if (this.stopping) {
      throw new Error('Server is shutting down and is not accepting new jobs');
    }
    const job = createJob(packId, type, options);
    this.scheduleNext();
    return job;
  }

  async enqueueUnique(
    packId: string,
    type: Job['type'],
    options?: CompressionOptions
  ): Promise<Job> {
    if (this.stopping) {
      throw new Error('Server is shutting down and is not accepting new jobs');
    }
    const job = createJobIfIdle(packId, type, options);
    if (!job) {
      throw new Error(`An active ${type} job already exists for this pack`);
    }
    this.scheduleNext();
    return job;
  }

  private scheduleNext(): void {
    if (this.stopping || this.currentTask) return;

    const job = claimNextPendingJob();
    if (!job) return;

    this.currentJobId = job.id;
    const endMutation = beginMutation();
    const task = this.runJob(job).finally(endMutation);
    this.currentTask = task;

    void task.finally(() => {
      this.currentTask = null;
      this.currentJobId = null;
      if (!this.stopping) {
        setTimeout(() => this.scheduleNext(), 100);
      }
    });
  }

  private async runJob(job: Job): Promise<void> {
    try {
      switch (job.type) {
        case 'fanbox':
        case 'pixiv': {
          const controller = new AbortController();
          this.importAbort = { packId: job.packId, controller };
          const importPost = job.type === 'fanbox'
            ? (await import('./fanbox-importer')).importFanboxPack
            : (await import('./pixiv-importer')).importPixivPack;
          await importPost(job.packId, (completed, total, bytes) => {
            this.emitProgress(job.id, {
              jobId: job.id, status: 'running', phase: 'downloading', completed, total,
              percentage: Math.floor(completed / total * 100),
              totalOriginalSize: bytes, totalCompressedSize: 0, error: null,
            });
          }, undefined, controller.signal);
          this.importAbort = null;
          break;
        }
        case 'extract':
          await this.runExtractJob(job);
          break;
        case 'thumbnail':
          await this.runThumbnailJob(job);
          break;
        case 'compress':
          await this.runCompressJob(job);
          break;
        case 'verify': {
          const controller = new AbortController();
          this.verificationAbort = { packId: job.packId, controller };
          let lastUpdate = 0;
          try {
            await verifyPack(job.packId, controller.signal, (completed, total) => {
              if (completed !== total && Date.now() - lastUpdate < 100) return;
              lastUpdate = Date.now();
              this.emitProgress(job.id, {
                jobId: job.id, status: 'running', phase: 'verifying', completed, total,
                percentage: total ? Math.min(99, Math.floor(completed / total * 100)) : 99,
                totalOriginalSize: 0, totalCompressedSize: 0, error: null,
              });
            });
          } catch (error) {
            if (controller.signal.aborted) {
              updateJobStatus(job.id, 'cancelled');
              return;
            }
            throw error;
          } finally {
            this.verificationAbort = null;
          }
          break;
        }
      }

      if (this.cancellingImports.has(job.packId)) {
        updateJobStatus(job.id, 'cancelled');
        return;
      }
      if (!config.isReplica && (job.type === 'thumbnail' || job.type === 'compress')) resumeHistoricalVerification(job.packId);
      updateJobStatus(job.id, 'completed', 100);
      const completed = this.getProgress(job.id);
      if (completed) {
        this.emit('progress', { ...completed, status: 'completed', percentage: 100 });
      }
    } catch (err) {
      if (this.importAbort?.packId === job.packId) this.importAbort = null;
      if (this.cancellingImports.has(job.packId)) {
        updateJobStatus(job.id, 'cancelled');
        return;
      }
      const message = err instanceof Error ? err.message : String(err);
      updateJobStatus(job.id, 'failed', 0, message, job.type === 'extract' ? archiveErrorCode(err) : taskErrorCode(err, jobFailureCode(job.type)));
      console.error(`Job ${job.id} failed:`, message);

      try {
        const { getPack, updatePackStatus } = await import('~/db/repositories');
        const pack = getPack(job.packId);
        if (pack && job.type === 'verify') {
          failVerification(pack.id, message);
        } else if (pack && job.type === 'compress') {
          const { existsSync } = await import('node:fs');
          const { getGeneratedPath } = await import('./storage');
          updatePackStatus(
            job.packId,
            existsSync(getGeneratedPath(job.packId)) ? 'generated' : 'extracted',
            `压缩任务失败：${message}`
          );
        } else if (pack && pack.status !== 'failed') {
          updatePackStatus(job.packId, 'failed', message);
        }
        if (!config.isReplica && (job.type === 'thumbnail' || job.type === 'compress')) resumeHistoricalVerification(job.packId);
      } catch (dbErr) {
        console.error('Failed to update pack status after job failure:', dbErr);
      }

      const failed = this.getProgress(job.id);
      if (failed) {
        this.emit('progress', { ...failed, status: 'failed', error: message });
      }
    }
  }

  private async runExtractJob(job: Job): Promise<void> {
    const { archiveExtractor } = await import('./archive-extractor');
    const {
      clearPackArchivePassword,
      updatePackStatus,
      getPack,
    } = await import('~/db/repositories');
    const pack = getPack(job.packId);
    if (!pack) {
      throw new Error(`Pack not found: ${job.packId}`);
    }

    updatePackStatus(pack.id, 'extracting');
    await archiveExtractor.extract(pack, pack.archivePassword ?? undefined);
    clearPackArchivePassword(pack.id);

    // Persist the follow-up job even during shutdown; it will resume next start.
    scheduleVerification(pack.id);
  }

  private async runThumbnailJob(job: Job): Promise<void> {
    const { thumbnailGenerator } = await import('./thumbnail-generator');
    const {
      getPack,
      updatePackStatus,
      updatePackBlurhashes,
    } = await import('~/db/repositories');
    const { getGeneratedPath } = await import('./storage');
    const { existsSync } = await import('node:fs');

    updatePackStatus(job.packId, 'thumbnailing');
    const blurhashes = await thumbnailGenerator.generateAll(job.packId, progress => {
      this.emitProgress(job.id, {
        jobId: job.id,
        status: 'running',
        phase: 'thumbnails',
        totalOriginalSize: 0,
        totalCompressedSize: 0,
        error: null,
        ...progress,
      });
    }, { concurrency: config.isReplica ? 2 : undefined });

    if (Object.keys(blurhashes).length > 0) {
      updatePackBlurhashes(job.packId, blurhashes);
    }
    const refreshedPack = getPack(job.packId);
    const hasGeneratedArchive =
      Boolean(refreshedPack?.compressedSize) && existsSync(getGeneratedPath(job.packId));
    updatePackStatus(job.packId, hasGeneratedArchive ? 'generated' : 'extracted');
  }

  private async runCompressJob(job: Job): Promise<void> {
    const { imageCompressor } = await import('./image-compressor');
    const { archiveGenerator } = await import('./archive-generator');
    const { updatePackStatus, getPack } = await import('~/db/repositories');
    const pack = getPack(job.packId);
    if (!pack) throw new Error(`Pack not found: ${job.packId}`);

    const parsed: any = job.options ? JSON.parse(job.options) : {};
    const options: CompressionOptions = {
      format: parsed.format ?? 'jpeg',
      quality: parsed.quality ?? 80,
      keepVideos: parsed.keepVideos ?? true,
      scaleImages: parsed.scaleImages ?? true,
      maxDimension: parsed.maxDimension ?? 1920,
    };
    const fileSelection = parsed.fileSelection as import('~/types').FileSelection | undefined;
    updatePackStatus(pack.id, 'generating');

    await imageCompressor.compressPack(job.packId, options, progress => {
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

    await archiveGenerator.generate(pack.id, options, progress => {
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
  }

  private emitProgress(jobId: string, progress: JobProgress): void {
    updateJobProgress(jobId, progress.percentage, progress);
    this.emit('progress', progress);
  }

  getProgress(jobId: string): JobProgress | null {
    const job = getJob(jobId);
    if (!job) return null;
    const result = job.result ? JSON.parse(job.result) : null;
    return {
      jobId: job.id,
      status: job.status,
      phase: result?.phase ?? 'queued',
      completed: result?.completed ?? 0,
      total: result?.total ?? 0,
      percentage: job.progress,
      totalOriginalSize: result?.totalOriginalSize ?? 0,
      totalCompressedSize: result?.totalCompressedSize ?? 0,
      error: job.error,
    };
  }

  async cancelVerification(packId: string): Promise<void> {
    if (hasActiveJobOtherThan(packId, 'verify')) throw new Error('图包正在处理，请稍后重试');
    cancelPendingJobs(packId, 'verify');
    if (this.verificationAbort?.packId === packId) {
      this.verificationAbort.controller.abort();
      await this.currentTask;
    }
  }

  async cancelImport(packId: string): Promise<void> {
    if (hasActiveJob(packId, 'compress')) {
      throw new Error('正在生成压缩包，请完成后再删除');
    }
    this.cancellingImports.add(packId);
    try {
      cancelPendingJobs(packId);
      if (this.importAbort?.packId === packId) this.importAbort.controller.abort();
      if (this.verificationAbort?.packId === packId) this.verificationAbort.controller.abort();
      if (this.currentJobId && getJob(this.currentJobId)?.packId === packId) await this.currentTask;
      // Extraction/thumbnail work drains before deletion. Cancel any follow-up it queued.
      cancelPendingJobs(packId);
    } finally { this.cancellingImports.delete(packId); }
  }

  async shutdown(timeoutMs: number): Promise<boolean> {
    this.stopping = true;
    if (!this.currentTask) return true;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const completed = this.currentTask.then(() => true);
    const drained = await Promise.race([completed, timedOut]);
    if (timer) clearTimeout(timer);
    return drained;
  }

  getCurrentJobId(): string | null {
    return this.currentJobId;
  }

  requeueJob(jobId: string | null): void {
    if (!jobId) return;
    const job = getJob(jobId);
    if (job && job.status !== 'completed') {
      updateJobStatus(jobId, 'pending', 0);
    }
  }
}

export const jobQueue = new JobQueue();

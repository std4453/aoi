import * as tus from 'tus-js-client';
import type { UploadTask, PackFile } from '../../../../shared/types';
import type * as api from '../../api/upload-tasks';
import { createFolderPack, fetchFolderUploadStatus, confirmFolderFileComplete } from '../../api/packs';
import { apiUrl, authHeaders } from '../../lib/connection';

export interface UploadFileProgress {
  id: string;
  path: string;
  size: number;
  transferred: number;
  status: 'pending' | 'uploading' | 'uploaded' | 'failed';
}
interface Runtime {
  id: string;
  source: 'archive' | 'folder';
  files: Array<UploadFileProgress & { file: File }>;
  uploads: Map<string, UploadTransfer>;
  local: Partial<UploadTask>;
  packId: string | null;
  paused: boolean;
  cancelled: boolean;
  done: boolean;
  handingOff: boolean;
  confirming: Set<string>;
  active: number;
  setup: Promise<void>;
  save: Promise<void>;
  timer?: ReturnType<typeof setTimeout>;
  archivePassword?: string;
}


export interface UploadTransfer { url: string | null; start(): void; abort(terminate?: boolean): Promise<void> }
interface Reports {
  getTask(id: string): UploadTask | undefined;
  patch(id: string, patch: Partial<UploadTask>): void;
  files(id: string, files: UploadFileProgress[]): void;
  persist(id: string, patch: api.UploadTaskUpdate, cancelled: () => boolean): Promise<void>;
  complete(id: string, input: { uploadId: string; archivePassword?: string }): Promise<void>;
  refresh(): Promise<void>;
}
const defaults = { createFolderPack, fetchFolderUploadStatus, confirmFolderFileComplete, apiUrl, authHeaders,
  createTransfer: (file: File, options: tus.UploadOptions): UploadTransfer => new tus.Upload(file, options) };

/** Browser-session lifetime: no React mount, draft or accordion state enters the executor. */
export function createLocalUploadExecutor(report: Reports, dependencies = defaults) {
  const runtimes = new Map<string, Runtime>();
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  function localUpdate(runtime: Runtime, patch: Partial<UploadTask>) {
    if (runtime.cancelled) return;
    runtime.local = { ...runtime.local, ...patch };
    report.patch(runtime.id, patch);
    publishFiles(runtime);
  }

  function publishFiles(runtime: Runtime) {
    report.files(runtime.id, runtime.files.map(({ file: _file, ...item }) => ({ ...item })));
  }

  function persist(runtime: Runtime, patch: api.UploadTaskUpdate) {
    runtime.save = report.persist(runtime.id, patch, () => runtime.cancelled);
    return runtime.save;
  }

  function progress(runtime: Runtime) {
    if (runtime.done) { publishFiles(runtime); return; }
    const total = runtime.files.reduce((sum, file) => sum + file.size, 0);
    const transferredBytes = runtime.files.reduce((sum, file) => sum + file.transferred, 0);
    const percentage = total ? Math.round(transferredBytes / total * 100) : 100;
    localUpdate(runtime, { progress: percentage, transferredBytes });
    if (!runtime.timer) runtime.timer = setTimeout(() => {
      runtime.timer = undefined;
      if (!runtime.done && !runtime.cancelled) void persist(runtime, { progress: runtime.local.progress, transferredBytes: runtime.local.transferredBytes });
    }, 1000);
  }

  function fail(runtime: Runtime, error: unknown) {
    if (runtime.cancelled || runtime.done) return;
    localUpdate(runtime, { status: 'failed', error: message(error) });
    void persist(runtime, { status: 'failed', error: message(error) });
  }

  async function handoff(runtime: Runtime, uploadId?: string) {
    if (runtime.handingOff || runtime.done || runtime.cancelled) return;
    runtime.handingOff = true;
    clearTimeout(runtime.timer);
    runtime.timer = undefined;
    await runtime.save;
    if (runtime.cancelled) { runtime.handingOff = false; return; }
    localUpdate(runtime, { progress: 100, status: 'processing', error: null });
    try {
      if (runtime.source === 'archive') {
        await report.complete(runtime.id, { uploadId: uploadId!, archivePassword: runtime.archivePassword });
      }
      runtime.done = true;
      runtime.local = {};
      await report.refresh();
    } catch (error) {
      fail(runtime, error);
    } finally {
      runtime.handingOff = false;
    }
  }

  function schedule(runtime: Runtime) {
    if (runtime.paused || runtime.cancelled || runtime.done) return;
    const max = runtime.source === 'folder' ? 3 : 1;
    runtime.active = runtime.files.filter(file => file.status === 'uploading').length;
    while (runtime.active < max) {
      const next = runtime.files.find(file => file.status === 'pending');
      if (!next) break;
      next.status = 'uploading';
      runtime.active++;
      const existing = runtime.uploads.get(next.id);
      if (existing) existing.start();
      else startTransfer(runtime, next);
    }
    progress(runtime);
    if (runtime.files.every(file => file.status === 'uploaded')) {
      if (runtime.source === 'folder') void handoff(runtime);
    } else if (runtime.active === 0 && runtime.files.some(file => file.status === 'failed')) {
      fail(runtime, '部分文件上传失败，请重试。');
    }
  }

  function startTransfer(runtime: Runtime, item: Runtime['files'][number]) {
    const task = report.getTask(runtime.id)!;
    const upload = dependencies.createTransfer(item.file, {
      endpoint: dependencies.apiUrl('/api/upload/files'),
      ...(runtime.source === 'archive' && task.uploadId ? { uploadUrl: dependencies.apiUrl(`/api/upload/files/${task.uploadId}`) } : {}),
      headers: dependencies.authHeaders(),
      chunkSize: 16 * 1024 * 1024,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      metadata: { filename: item.file.name, filetype: item.file.type || 'application/octet-stream', taskId: runtime.id },
      onAfterResponse: (_request, response) => {
        if (runtime.source !== 'archive' || runtime.cancelled) return;
        const location = response.getHeader('Location');
        const uploadId = location?.split('/').pop();
        if (uploadId && uploadId !== runtime.local.uploadId) {
          localUpdate(runtime, { uploadId });
          void persist(runtime, { uploadId });
        }
      },
      onProgress: uploaded => {
        if (runtime.cancelled) return;
        item.transferred = uploaded;
        progress(runtime);
      },
      onError: error => {
        if (runtime.cancelled || runtime.paused) return;
        item.status = 'failed';
        runtime.active--;
        fail(runtime, error);
        schedule(runtime);
      },
      onSuccess: () => {
        void (async () => {
          if (runtime.cancelled) return;
          runtime.confirming.add(item.id);
          const uploadId = upload.url?.split('/').pop();
          if (!uploadId) throw new Error('服务器未返回上传标识');
          if (runtime.source === 'archive') {
            item.status = 'uploaded';
            runtime.active--;
            item.transferred = item.size;
            progress(runtime);
            await handoff(runtime, uploadId);
            runtime.confirming.delete(item.id);
            return;
          }
          await dependencies.confirmFolderFileComplete(runtime.packId!, { packFileId: item.id, uploadId });
          if (runtime.cancelled) return;
          runtime.confirming.delete(item.id);
          item.status = 'uploaded';
          item.transferred = item.size;
          runtime.uploads.delete(item.id);
          runtime.active--;
          publishFiles(runtime);
          schedule(runtime);
        })().catch(error => {
          if (runtime.cancelled) return;
          runtime.confirming.delete(item.id);
          item.status = 'failed';
          runtime.active = Math.max(0, runtime.active - 1);
          fail(runtime, error);
          schedule(runtime);
        });
      },
    });
    runtime.uploads.set(item.id, upload);
    upload.start();
  }

  function makeRuntime(task: UploadTask): Runtime {
    const runtime: Runtime = {
      id: task.id, source: task.source as 'archive' | 'folder', files: [], uploads: new Map(), local: {},
      packId: task.packId, paused: false, cancelled: false, done: false, active: 0,
      handingOff: false, confirming: new Set(),
      setup: Promise.resolve(), save: Promise.resolve(),
    };
    runtimes.set(task.id, runtime);
    return runtime;
  }

  async function beginLocal(task: UploadTask, files: File[], tagIds?: string[], archivePassword?: string) {
    const runtime = makeRuntime(task);
    runtime.archivePassword = archivePassword;
    runtime.setup = (async () => {
      if (task.source === 'archive') {
        const file = files[0];
        if (!file || file.name !== task.filename || file.size !== task.totalBytes) throw new Error('请选择原来的压缩包，文件名与大小必须一致。');
        runtime.files = [{ id: task.id, path: file.name, size: file.size, transferred: 0, status: 'pending', file }];
      } else {
        let packFiles: PackFile[];
        if (task.packId) {
          const result = await dependencies.fetchFolderUploadStatus(task.packId);
          packFiles = result.packFiles;
        } else {
          const result = await dependencies.createFolderPack({ taskId: task.id, packName: task.name, tagIds,
            files: files.map(file => ({ relativePath: file.webkitRelativePath || file.name, fileSize: file.size })),
          });
          runtime.packId = result.id;
          packFiles = result.packFiles;
        }
        const byPath = new Map(files.map(file => [file.webkitRelativePath || file.name, file]));
        if (byPath.size !== packFiles.length) throw new Error('所选文件夹与原任务的文件数量不一致。');
        runtime.files = packFiles.map(packFile => {
          const file = byPath.get(packFile.relativePath);
          if (!file || file.size !== packFile.fileSize) throw new Error(`所选文件夹与原任务不一致：${packFile.relativePath}`);
          return { id: packFile.id, path: packFile.relativePath, size: file.size, file,
            transferred: packFile.status === 'uploaded' ? file.size : 0,
            status: packFile.status === 'uploaded' ? 'uploaded' : 'pending',
          };
        });
      }
      await persist(runtime, { status: 'uploading', error: null });
      if (runtime.cancelled) return;
      localUpdate(runtime, { status: 'uploading', error: null });
      schedule(runtime);
    })().catch(async error => {
      if (runtime.cancelled) return;
      if (runtime.files.length === 0) {
        localUpdate(runtime, { status: 'needs_file', error: message(error) });
        await persist(runtime, { status: 'needs_file', error: message(error) });
        runtimes.delete(task.id);
      } else fail(runtime, error);
    });
    await runtime.setup;
  }

  async function pause(id: string) {
    const runtime = runtimes.get(id);
    if (!runtime || runtime.done || runtime.paused) return;
    runtime.paused = true;
    await Promise.all(runtime.files.filter(file => file.status === 'uploading' && !runtime.confirming.has(file.id)).map(async file => {
      await runtime.uploads.get(file.id)?.abort();
      if (file.status === 'uploading') file.status = 'pending';
    }));
    runtime.active = runtime.files.filter(file => file.status === 'uploading').length;
    if (runtime.done || runtime.handingOff || runtime.cancelled) return;
    localUpdate(runtime, { status: 'paused' });
    await persist(runtime, { status: 'paused' });
  }

  async function resume(id: string, passwords: { archivePassword?: string; sharePassword?: string } = {}) {
    const runtime = runtimes.get(id);
    if (runtime && !runtime.done && runtime.files.length > 0) {
      runtime.archivePassword = passwords.archivePassword ?? runtime.archivePassword;
      runtime.paused = false;
      for (const file of runtime.files) if (file.status === 'failed') file.status = 'pending';
      localUpdate(runtime, { status: 'uploading', error: null });
      await persist(runtime, { status: 'uploading', error: null });
      if (runtime.source === 'archive' && runtime.files.every(file => file.status === 'uploaded')) {
        await handoff(runtime, runtime.uploads.get(id)?.url?.split('/').pop());
      } else schedule(runtime);
      return true;
    }
    return false;
  }

  return {
    begin: beginLocal, pause, resume,
    merge(task: UploadTask): UploadTask {
      const runtime = runtimes.get(task.id);
      if (runtime && ['processing', 'duplicate', 'password', 'completed'].includes(task.status)) { runtime.done = true; runtime.local = {}; }
      if (!runtime && ['archive', 'folder'].includes(task.source) && ['uploading', 'paused'].includes(task.status)) return { ...task, status: 'needs_file' };
      return runtime && !runtime.done ? { ...task, ...runtime.local } : task;
    },
    hasFiles(id: string) { const runtime = runtimes.get(id); return Boolean(runtime && !runtime.done && !runtime.cancelled && runtime.files.length); },
    async cancel(id: string) {
      const runtime = runtimes.get(id);
      if (!runtime || runtime.done) return;
      runtime.cancelled = true;
      clearTimeout(runtime.timer);
      await runtime.setup;
      await Promise.all([...runtime.uploads.values()].map(upload => upload.abort()));
      await runtime.save;
    },
    restoreCancelled(id: string) {
      const runtime = runtimes.get(id);
      if (!runtime || runtime.done) return;
      runtime.cancelled = false; runtime.paused = true;
      for (const file of runtime.files) if (file.status === 'uploading') file.status = 'pending';
      runtime.active = 0;
      localUpdate(runtime, { status: 'paused' });
    },
    release(id: string) {
      const runtime = runtimes.get(id);
      if (!runtime) return;
      runtime.cancelled = true; clearTimeout(runtime.timer);
      // Only called after the server has accepted deletion.
      void Promise.all([...runtime.uploads.values()].map(upload => upload.abort(true).catch(() => {})));
      runtimes.delete(id);
    },
    dispose() { for (const runtime of runtimes.values()) { runtime.cancelled = true; clearTimeout(runtime.timer); for (const upload of runtime.uploads.values()) void upload.abort(); } runtimes.clear(); },
  };
}

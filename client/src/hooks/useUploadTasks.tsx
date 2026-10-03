import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import * as tus from 'tus-js-client';
import type { UploadTask, PackFile } from '../../../shared/types';
import * as api from '../api/upload-tasks';
import { fetchPixivMetadata } from '../api/pixiv';
import { fetchMegaMetadata } from '../api/mega';
import { createFolderPack, fetchFolderUploadStatus, confirmFolderFileComplete } from '../api/packs';
import { apiUrl, authHeaders, serverWritable } from '../lib/connection';
import { clearPacksCache } from '../lib/homeStore';
import { TASK_EXIT_MS, retainPendingTasks, selectionAfterRemoval } from '../lib/upload-task-state';

export interface UploadDraft {
  source: 'archive' | 'folder' | 'mega' | 'pixiv' | null;
  files: File[];
  name: string;
  url: string;
  sharePassword: string;
  archivePassword: string;
  tagIds: string[];
}
export interface UploadFileProgress {
  id: string;
  path: string;
  size: number;
  transferred: number;
  status: 'pending' | 'uploading' | 'uploaded' | 'failed';
}
const emptyDraft = (): UploadDraft => ({ source: null, files: [], name: '', url: '', sharePassword: '', archivePassword: '', tagIds: [] });
interface Snapshot {
  tasks: UploadTask[];
  expandedId: string | null;
  revealRevision: number;
  exitingIds: Set<string>;
  draft: UploadDraft;
  error: string | null;
  loading: boolean;
  starting: boolean;
  metadataLoading: boolean;
  metadataError: string | null;
  files: Record<string, UploadFileProgress[]>;
}
let snapshot: Snapshot = { tasks: [], expandedId: null, revealRevision: 0, exitingIds: new Set(), draft: emptyDraft(), error: null, loading: true, starting: false, metadataLoading: false, metadataError: null, files: {} };
const listeners = new Set<() => void>();
const publish = (patch: Partial<Snapshot>) => {
  snapshot = { ...snapshot, ...patch };
  listeners.forEach(listener => listener());
};
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getSnapshot = () => snapshot;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const runtimes = new Map<string, Runtime>();
const deletedIds = new Set<string>();
const dismissingIds = new Set<string>();
let refreshing: Promise<void> | null = null;
let mutationRevision = 0;
let refreshError: string | null = null;
let metadataRevision = 0;
let metadataTimer: ReturnType<typeof setTimeout> | undefined;
let nameEdited = false;
let tagsEdited = false;
let metadataReady = false;

function resetDraft() {
  clearTimeout(metadataTimer);
  metadataRevision++;
  nameEdited = false;
  tagsEdited = false;
  metadataReady = false;
  publish({ draft: emptyDraft(), metadataLoading: false, metadataError: null });
}

function setDraft(patch: Partial<UploadDraft>) {
  const sourceChanged = patch.source !== undefined && patch.source !== snapshot.draft.source;
  if (sourceChanged) resetDraft();
  if (!sourceChanged && patch.name !== undefined) nameEdited = true;
  if (patch.tagIds !== undefined) tagsEdited = true;
  publish({ draft: { ...snapshot.draft, ...patch } });
  if (!sourceChanged && patch.url === undefined && patch.sharePassword === undefined) return;
  clearTimeout(metadataTimer);
  const revision = ++metadataRevision;
  metadataReady = false;
  const { source, url, sharePassword } = snapshot.draft;
  publish({ metadataLoading: false, metadataError: null, draft: {
    ...snapshot.draft,
    ...(!nameEdited && (source === 'mega' || source === 'pixiv') ? { name: '' } : {}),
    ...(!tagsEdited ? { tagIds: [] } : {}),
  } });
  const valid = source === 'pixiv'
    ? /^https:\/\/(www\.)?pixiv\.net\/(?:[a-z]{2}\/)?artworks\/[1-9]\d*(?:[/?#].*)?$/.test(url.trim())
    : source === 'mega' && /^https:\/\/(?:www\.)?(?:mega\.nz|mega\.co\.nz)\//.test(url.trim());
  if (!valid) return;
  publish({ metadataLoading: true });
  metadataTimer = setTimeout(() => {
    const request = source === 'pixiv' ? fetchPixivMetadata(url.trim()) : fetchMegaMetadata(url.trim(), sharePassword || undefined);
    void request.then(metadata => {
      if (revision !== metadataRevision || snapshot.starting) return;
      metadataReady = true;
      publish({ draft: { ...snapshot.draft,
        ...(!nameEdited ? { name: metadata.title.slice(0, 200) } : {}),
        ...(!tagsEdited && 'tags' in metadata ? { tagIds: metadata.tags.map(tag => tag.id) } : {}),
      } });
    }).catch(error => {
      if (revision === metadataRevision && !snapshot.starting) publish({ metadataError: message(error) });
    }).finally(() => {
      if (revision === metadataRevision) publish({ metadataLoading: false });
    });
  }, 500);
}

interface Runtime {
  id: string;
  source: 'archive' | 'folder';
  files: Array<UploadFileProgress & { file: File }>;
  uploads: Map<string, tus.Upload>;
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

function replaceTask(task: UploadTask) {
  if (deletedIds.has(task.id)) return;
  const previous = snapshot.tasks.find(item => item.id === task.id);
  if (task.status === 'completed' && previous?.status !== 'completed') clearPacksCache();
  publish({ tasks: previous ? snapshot.tasks.map(item => item.id === task.id ? task : item) : [task, ...snapshot.tasks] });
}

function localUpdate(runtime: Runtime, patch: Partial<UploadTask>) {
  runtime.local = { ...runtime.local, ...patch };
  const task = snapshot.tasks.find(item => item.id === runtime.id);
  if (task) replaceTask({ ...task, ...patch });
  publishFiles(runtime);
}

function publishFiles(runtime: Runtime) {
  publish({ files: { ...snapshot.files, [runtime.id]: runtime.files.map(({ file: _file, ...item }) => ({ ...item })) } });
}

function persist(runtime: Runtime, patch: api.UploadTaskUpdate) {
  runtime.save = runtime.save.then(async () => {
    if (!runtime.cancelled) await api.updateUploadTask(runtime.id, patch);
  }).catch(error => {
    if (message(error).includes('controlled by the server')) { void refresh(); return; }
    publish({ error: `上传状态同步失败：${message(error)}` });
  });
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
      const task = await api.completeUploadTask(runtime.id, { uploadId: uploadId!, archivePassword: runtime.archivePassword });
      mutationRevision++;
      replaceTask(task);
    }
    runtime.done = true;
    runtime.local = {};
    await refresh();
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
  const task = snapshot.tasks.find(entry => entry.id === runtime.id)!;
  const upload = new tus.Upload(item.file, {
    endpoint: apiUrl('/api/upload/files'),
    ...(runtime.source === 'archive' && task.uploadId ? { uploadUrl: apiUrl(`/api/upload/files/${task.uploadId}`) } : {}),
    headers: authHeaders(),
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
        await confirmFolderFileComplete(runtime.packId!, { packFileId: item.id, uploadId });
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
        const result = await fetchFolderUploadStatus(task.packId);
        packFiles = result.packFiles;
      } else {
        const result = await createFolderPack({ taskId: task.id, packName: task.name, tagIds,
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

async function refresh() {
  if (!serverWritable) { publish({ loading: false }); return; }
  if (refreshing) return refreshing;
  const revision = mutationRevision;
  refreshing = (async () => {
    try {
      const fetched = await api.fetchUploadTasks();
      if (revision !== mutationRevision) return;
      const fetchedTasks = fetched.filter(task => !deletedIds.has(task.id)).map(task => {
        const runtime = runtimes.get(task.id);
        if (runtime && ['processing', 'duplicate', 'password', 'completed'].includes(task.status)) {
          runtime.done = true;
          runtime.local = {};
        }
        // A browser cannot retain File access through a reload. The durable task remains available for reselection.
        if (!runtime && ['archive', 'folder'].includes(task.source) && ['uploading', 'paused'].includes(task.status)) {
          return { ...task, status: 'needs_file' as const };
        }
        return runtime && !runtime.done ? { ...task, ...runtime.local } : task;
      });
      const tasks = retainPendingTasks(fetchedTasks, snapshot.tasks, new Set([...dismissingIds, ...snapshot.exitingIds]));
      const newlyCompleted = tasks.some(task => task.status === 'completed' && snapshot.tasks.find(old => old.id === task.id)?.status !== 'completed');
      if (newlyCompleted) clearPacksCache();
      publish({ tasks, expandedId: tasks.some(task => task.id === snapshot.expandedId) ? snapshot.expandedId : null,
        error: snapshot.error === refreshError ? null : snapshot.error, loading: false });
      refreshError = null;
    } catch (error) { refreshError = message(error); publish({ error: refreshError, loading: false }); }
  })().finally(() => { refreshing = null; });
  return refreshing;
}

async function start() {
  if (snapshot.starting) return;
  const draft = snapshot.draft;
  if (!draft.source) return;
  const remote = draft.source === 'mega' || draft.source === 'pixiv';
  clearTimeout(metadataTimer);
  metadataRevision++;
  publish({ starting: true, error: null });
  try {
    const task = await api.createUploadTask({ source: draft.source, name: draft.name.trim() || (remote ? `${draft.source === 'mega' ? 'MEGA' : 'Pixiv'} 导入` : draft.files[0]?.name.replace(/\.[^.]+$/, '') || '文件夹上传'),
      autoName: remote && (!nameEdited || !draft.name.trim()),
      filename: draft.source === 'archive' ? draft.files[0]?.name : undefined,
      fileSize: draft.files.reduce((sum, file) => sum + file.size, 0),
      tagIds: draft.source === 'pixiv' && !tagsEdited && !metadataReady ? undefined : draft.tagIds,
      url: remote ? draft.url.trim() : undefined,
      sharePassword: draft.sharePassword || undefined, archivePassword: draft.archivePassword || undefined,
    });
    mutationRevision++;
    replaceTask(task);
    resetDraft();
    publish({ expandedId: task.id, revealRevision: snapshot.revealRevision + 1 });
    if (!remote) void beginLocal(task, draft.files, draft.tagIds, draft.archivePassword || undefined);
  } catch (error) { publish({ error: message(error) }); }
  finally { publish({ starting: false, metadataLoading: false }); }
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
  if (runtime.done || runtime.handingOff) return;
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
    return;
  }
  const task = await api.retryUploadTask(id, passwords);
  mutationRevision++;
  replaceTask(task);
  await refresh();
}

async function dismiss(id: string) {
  if (dismissingIds.has(id) || deletedIds.has(id)) return;
  dismissingIds.add(id);
  mutationRevision++;
  const runtime = runtimes.get(id);
  try {
    if (runtime && !runtime.done) {
      runtime.cancelled = true;
      clearTimeout(runtime.timer);
      await runtime.setup;
      await Promise.all([...runtime.uploads.values()].map(upload => upload.abort()));
      await runtime.save;
    }
    await api.deleteUploadTask(id);
  } catch (error) {
    dismissingIds.delete(id);
    if (runtime && !runtime.done) {
      runtime.cancelled = false;
      runtime.paused = true;
      for (const file of runtime.files) if (file.status === 'uploading') file.status = 'pending';
      runtime.active = 0;
      localUpdate(runtime, { status: 'paused' });
    }
    await refresh();
    throw error;
  }
  mutationRevision++;
  if (runtime) {
    runtime.cancelled = true;
    clearTimeout(runtime.timer);
    // The server owns cancellation; terminate any unbound tus files only after it accepts deletion.
    void Promise.all([...runtime.uploads.values()].map(upload => upload.abort(true).catch(() => {})));
  }
  deletedIds.add(id);
  dismissingIds.delete(id);
  publish({ exitingIds: new Set([...snapshot.exitingIds, id]) });
  clearPacksCache();
  setTimeout(() => {
    runtimes.delete(id);
    const files = { ...snapshot.files };
    delete files[id];
    publish({ tasks: snapshot.tasks.filter(task => task.id !== id), files,
      expandedId: selectionAfterRemoval(snapshot.tasks, snapshot.expandedId, id, snapshot.exitingIds),
      revealRevision: snapshot.revealRevision + (snapshot.expandedId === id ? 1 : 0),
      exitingIds: new Set([...snapshot.exitingIds].filter(item => item !== id)),
    });
  }, TASK_EXIT_MS);
}

const actions = {
  refresh, start, pause, resume, dismiss,
  expand: (id: string | null) => {
    publish({ expandedId: id, revealRevision: snapshot.revealRevision + (id ? 1 : 0) });
  },
  setDraft, resetDraft,
  continueTask: async (id: string) => {
    const task = await api.continueUploadTask(id);
    mutationRevision++;
    replaceTask(task);
    await refresh();
  },
  reselect: async (id: string, files: File[]) => {
    const task = snapshot.tasks.find(item => item.id === id);
    if (task) await beginLocal(task, files);
  },
  hasLocalFiles: (id: string) => {
    const runtime = runtimes.get(id);
    return Boolean(runtime && !runtime.done && !runtime.cancelled && runtime.files.length > 0);
  },
};

export function UploadTasksProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 1500);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  return <>{children}</>;
}

export function useUploadTasks() {
  return { ...useSyncExternalStore(subscribe, getSnapshot), ...actions };
}

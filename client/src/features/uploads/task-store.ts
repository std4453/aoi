import type { CreateUploadTaskRequest, UploadTask } from '../../../../shared/types';
import * as api from '../../api/upload-tasks';
import { serverWritable } from '../../lib/connection';
import { clearPacksCache } from '../../lib/homeStore';
import { createLocalUploadExecutor, type UploadFileProgress } from './local-upload';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const defaults = { api, writable: () => serverWritable, invalidatePacks: clearPacksCache, createExecutor: createLocalUploadExecutor };

/** Owns durable task synchronization and operations, independently of all React subscribers. */
export function createUploadTaskStore(dependencies = defaults) {
  let snapshot = { tasks: [] as UploadTask[], files: {} as Record<string, UploadFileProgress[]>, loading: true, error: null as string | null };
  const listeners = new Set<() => void>();
  const removals = new Set<(id: string, tasks: UploadTask[], files: Record<string, UploadFileProgress[]>) => void>();
  const deletedIds = new Set<string>();
  const dismissingIds = new Set<string>();
  const saves = new Map<string, Promise<void>>();
  let refreshing: Promise<void> | null = null;
  let mutationRevision = 0;
  let refreshError: string | null = null;
  const publish = (patch: Partial<typeof snapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener()); };
  const getTask = (id: string) => snapshot.tasks.find(task => task.id === id);
  function replaceTask(task: UploadTask) {
    if (deletedIds.has(task.id)) return;
    const previous = getTask(task.id);
    if (task.status === 'completed' && previous?.status !== 'completed') dependencies.invalidatePacks();
    publish({ tasks: previous ? snapshot.tasks.map(item => item.id === task.id ? task : item) : [task, ...snapshot.tasks] });
  }
  const executor = dependencies.createExecutor({
    getTask,
    patch(id, patch) { const task = getTask(id); if (task) replaceTask({ ...task, ...patch }); },
    files(id, files) { if (!deletedIds.has(id)) publish({ files: { ...snapshot.files, [id]: files } }); },
    persist(id, patch, cancelled) {
      const save = (saves.get(id) ?? Promise.resolve()).then(async () => {
        if (!cancelled()) await dependencies.api.updateUploadTask(id, patch);
      }).catch(error => {
        if (message(error).includes('controlled by the server')) { void refresh(); return; }
        publish({ error: `上传状态同步失败：${message(error)}` });
      });
      saves.set(id, save);
      return save;
    },
    async complete(id, input) {
      const task = await dependencies.api.completeUploadTask(id, input);
      mutationRevision++;
      replaceTask(task);
    },
    refresh,
  });
  async function refresh() {
    if (!dependencies.writable()) { publish({ loading: false }); return; }
    if (refreshing) return refreshing;
    const revision = mutationRevision;
    refreshing = (async () => {
      try {
        const fetched = await dependencies.api.fetchUploadTasks();
        if (revision !== mutationRevision) return;
        const tasks = fetched.filter(task => !deletedIds.has(task.id)).map(task => executor.merge(task));
        // An in-flight deletion may disappear server-side before its request returns.
        for (const task of snapshot.tasks) if (dismissingIds.has(task.id) && !tasks.some(item => item.id === task.id)) tasks.splice(snapshot.tasks.indexOf(task), 0, task);
        if (tasks.some(task => task.status === 'completed' && getTask(task.id)?.status !== 'completed')) dependencies.invalidatePacks();
        publish({ tasks, error: snapshot.error === refreshError ? null : snapshot.error, loading: false });
        refreshError = null;
      } catch (error) { refreshError = message(error); publish({ error: refreshError, loading: false }); }
    })().finally(() => { refreshing = null; });
    return refreshing;
  }
  async function create(input: CreateUploadTaskRequest, local: { files: File[]; tagIds: string[]; archivePassword?: string }) {
    const task = await dependencies.api.createUploadTask(input);
    mutationRevision++;
    replaceTask(task);
    if (task.source === 'archive' || task.source === 'folder') void executor.begin(task, local.files, local.tagIds, local.archivePassword);
    return task;
  }
  async function resume(id: string, passwords: { archivePassword?: string; sharePassword?: string } = {}) {
    if (await executor.resume(id, passwords)) return;
    const task = await dependencies.api.retryUploadTask(id, passwords);
    mutationRevision++;
    replaceTask(task);
    await refresh();
  }
  async function dismiss(id: string) {
    if (dismissingIds.has(id) || deletedIds.has(id)) return;
    dismissingIds.add(id); mutationRevision++;
    try {
      await executor.cancel(id);
      await dependencies.api.deleteUploadTask(id);
    } catch (error) {
      dismissingIds.delete(id);
      executor.restoreCancelled(id);
      await refresh();
      throw error;
    }
    mutationRevision++;
    deletedIds.add(id); dismissingIds.delete(id);
    executor.release(id); saves.delete(id);
    // The view may retain a snapshot for its exit animation; durable deletion is already complete.
    removals.forEach(listener => listener(id, snapshot.tasks, snapshot.files));
    const files = { ...snapshot.files }; delete files[id];
    publish({ tasks: snapshot.tasks.filter(task => task.id !== id), files });
    dependencies.invalidatePacks();
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    onRemoved: (listener: (id: string, tasks: UploadTask[], files: Record<string, UploadFileProgress[]>) => void) => { removals.add(listener); return () => { removals.delete(listener); }; },
    refresh, create, dismiss, resume, pause: executor.pause, hasLocalFiles: executor.hasFiles,
    async continueTask(id: string) { const task = await dependencies.api.continueUploadTask(id); mutationRevision++; replaceTask(task); await refresh(); },
    async reselect(id: string, files: File[]) { const task = getTask(id); if (task) await executor.begin(task, files); },
    dispose() { executor.dispose(); listeners.clear(); removals.clear(); },
  };
}
export const uploadTasks = createUploadTaskStore();

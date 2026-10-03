import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { uploadTasks } from './task-store';
import { uploadDraft } from './draft';
import { uploadView, retainPendingTasks } from './view-state';

// App-session services survive page/Hook unmounts. Only polling follows the app provider.
const unsubscribeRemoved = uploadTasks.onRemoved((id, tasks, files) => uploadView.removed(id, tasks, files));
if (import.meta.hot) import.meta.hot.dispose(unsubscribeRemoved);

export function UploadTasksProvider({ children }: { children: ReactNode }) {
  useEffect(() => {
    void uploadTasks.refresh();
    const timer = setInterval(() => { void uploadTasks.refresh(); }, 1500);
    const onVisible = () => { if (!document.hidden) void uploadTasks.refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  return <>{children}</>;
}

export function useUploadTasks() {
  return { ...useSyncExternalStore(uploadTasks.subscribe, uploadTasks.getSnapshot),
    refresh: uploadTasks.refresh, dismiss: uploadTasks.dismiss, pause: uploadTasks.pause,
    resume: uploadTasks.resume, continueTask: uploadTasks.continueTask, reselect: uploadTasks.reselect,
    hasLocalFiles: uploadTasks.hasLocalFiles };
}

export function useUploadDraft() {
  return { ...useSyncExternalStore(uploadDraft.subscribe, uploadDraft.getSnapshot),
    setDraft: uploadDraft.setDraft, resetDraft: uploadDraft.resetDraft,
    start: async () => { const task = await uploadDraft.submit(uploadTasks.create); if (task) uploadView.expand(task.id); } };
}

export function useUploadView() {
  return { ...useSyncExternalStore(uploadView.subscribe, uploadView.getSnapshot), expand: uploadView.expand };
}

export function useUploadCards() {
  const store = useUploadTasks();
  const view = useUploadView();
  return { ...store, ...view, tasks: retainPendingTasks(store.tasks, view.retainedTasks, view.exitingIds),
    files: { ...view.retainedFiles, ...store.files } };
}

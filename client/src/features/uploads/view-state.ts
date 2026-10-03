import type { UploadTask } from '../../../../shared/types';
import type { UploadFileProgress } from './local-upload';

export const TASK_EXIT_MS = 240;

/** Keep deletions in their original position until their exit animation ends. */
export function retainPendingTasks<T extends { id: string }>(fetched: T[], previous: T[], pending: Set<string>): T[] {
  const tasks = [...fetched];
  previous.forEach((task, index) => {
    if (!pending.has(task.id) || tasks.some(item => item.id === task.id)) return;
    const next = previous.slice(index + 1).find(item => tasks.some(current => current.id === item.id));
    const position = next ? tasks.findIndex(item => item.id === next.id) : tasks.length;
    tasks.splice(position, 0, task);
  });
  return tasks;
}

export function selectionAfterRemoval(selected: string | null, removed: string): string | null {
  return selected === removed ? null : selected;
}

let scrollY = 0;
let handledRevealRevision = 0;

export const getUploadScrollY = () => scrollY;
export const saveUploadScrollY = (value: number) => { scrollY = value; };
export const getHandledRevealRevision = () => handledRevealRevision;
export const setHandledRevealRevision = (value: number) => { handledRevealRevision = value; };

/** Reveal only the clipped part; cards taller than the viewport keep their heading visible. */
export function taskRevealDelta(top: number, bottom: number, visibleTop: number, visibleBottom: number): number {
  if (top >= visibleTop && bottom <= visibleBottom) return 0;
  if (top < visibleTop || bottom - top > visibleBottom - visibleTop) return top - visibleTop;
  return bottom - visibleBottom;
}

/** Start with the accordion and follow its growing scroll range instead of waiting for it. */
export function scrollWithTaskExpansion(top: number): () => void {
  const from = window.scrollY;
  if (Math.abs(top - from) <= 1) return () => {};
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.scrollTo({ top, behavior: 'instant' });
    return () => {};
  }
  const started = performance.now();
  let frame = 0;
  const cancel = () => {
    cancelAnimationFrame(frame);
    window.removeEventListener('wheel', cancel);
    window.removeEventListener('touchstart', cancel);
    window.removeEventListener('pointerdown', cancel);
    window.removeEventListener('keydown', onKeyDown);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' '].includes(event.key)) cancel();
  };
  const step = (now: number) => {
    const progress = Math.min(1, (now - started) / 240);
    window.scrollTo({ top: from + (top - from) * (1 - (1 - progress) ** 3), behavior: 'instant' });
    if (progress < 1) frame = requestAnimationFrame(step);
    else cancel();
  };
  window.addEventListener('wheel', cancel, { passive: true });
  window.addEventListener('touchstart', cancel, { passive: true });
  window.addEventListener('pointerdown', cancel, { passive: true });
  window.addEventListener('keydown', onKeyDown);
  frame = requestAnimationFrame(step);
  return cancel;
}

export function createUploadViewState() {
  type Reveal = { packId: string } | null;
  let snapshot = { expandedId: null as string | null, revealRevision: 0, reveal: null as Reveal,
    exitingIds: new Set<string>(), retainedTasks: [] as UploadTask[], retainedFiles: {} as Record<string, UploadFileProgress[]> };
  const listeners = new Set<() => void>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const publish = (patch: Partial<typeof snapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener()); };
  const expand = (id: string | null) => publish({ expandedId: id, revealRevision: snapshot.revealRevision + (id ? 1 : 0) });
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    expand,
    requestReveal: (packId: string) => publish({ reveal: { packId } }),
    resolveReveal(tasks: UploadTask[], loading: boolean) {
      if (!snapshot.reveal || loading) return;
      const task = tasks.find(task => task.packId === snapshot.reveal!.packId);
      publish({ reveal: null });
      if (task) expand(task.id);
    },
    removed(id: string, tasks: UploadTask[], files: Record<string, UploadFileProgress[]>) {
      publish({ exitingIds: new Set([...snapshot.exitingIds, id]),
        retainedTasks: retainPendingTasks(tasks, snapshot.retainedTasks, snapshot.exitingIds),
        retainedFiles: { ...snapshot.retainedFiles, [id]: files[id] ?? [] } });
      timers.set(id, setTimeout(() => {
        timers.delete(id);
        const retainedFiles = { ...snapshot.retainedFiles }; delete retainedFiles[id];
        const exitingIds = new Set([...snapshot.exitingIds].filter(item => item !== id));
        publish({ expandedId: selectionAfterRemoval(snapshot.expandedId, id), retainedFiles,
          exitingIds, retainedTasks: exitingIds.size ? snapshot.retainedTasks.filter(task => task.id !== id) : [] });
      }, TASK_EXIT_MS));
    },
    dispose() { timers.forEach(clearTimeout); timers.clear(); listeners.clear(); },
  };
}

export const uploadView = createUploadViewState();

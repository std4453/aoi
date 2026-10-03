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

import type { UploadTask } from '../../../../shared/types';
import { showPersistentToast, type PersistentToastOptions, type ToastType } from '../../components/Toast';
import { TaskSummaryContent } from './TaskPresentation';
import { taskStates } from './task-display';

type TaskToastOptions = Omit<PersistentToastOptions, 'position'> & { message?: string };

export interface TaskToastHandle {
  close: () => void;
  update: (task: UploadTask, options: TaskToastOptions) => void;
}

function taskToastType(task: UploadTask): ToastType {
  const tone = taskStates[task.status].tone;
  return tone === 'neutral' ? 'default' : tone;
}

/** Upload-specific summary, status tone and bottom placement stay with the feature. */
export function showTaskToast(task: UploadTask, { message, ...actions }: TaskToastOptions): TaskToastHandle {
  const handle = showPersistentToast(<TaskSummaryContent task={task} message={message || undefined} layout="toast" />,
    taskToastType(task), { ...actions, position: 'bottom' });
  return {
    close: handle.close,
    update: (next, { message, ...actions }) => handle.update(
      <TaskSummaryContent task={next} message={message || undefined} layout="toast" />, taskToastType(next), actions),
  };
}

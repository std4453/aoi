import { useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useUploadTasks } from '../hooks/useUploadTasks';
import { showError, showTaskToast, type TaskToastHandle } from './Toast';
import type { UploadTask } from '../../../shared/types';

const messages: Partial<Record<UploadTask['status'], string>> = {
  duplicate: '待确认重复',
  password: '待输入密码',
  needs_file: '待选择文件',
  completed: '已完成',
  failed: '失败',
};

export default function UploadTaskNotifications() {
  const { tasks, expand, dismiss } = useUploadTasks();
  const location = useLocation();
  const navigate = useNavigate();
  const seen = useRef(new Map<string, string>());
  const visible = useRef(new Map<string, TaskToastHandle>());
  const actions = useRef({ expand, dismiss, navigate });
  actions.current = { expand, dismiss, navigate };

  useEffect(() => {
    const onUpload = location.pathname.replace(/\/+$/, '') === '/upload';
    const currentIds = new Set(tasks.map(task => task.id));
    for (const [id, handle] of visible.current) {
      const task = tasks.find(item => item.id === id);
      if (onUpload || !task || !messages[task.status]) {
        handle.close();
        visible.current.delete(id);
      }
    }
    for (const id of seen.current.keys()) if (!currentIds.has(id)) seen.current.delete(id);
    for (const task of tasks) {
      const signature = `${task.status}:${task.error ?? ''}`;
      const message = messages[task.status];
      const previous = seen.current.get(task.id);
      seen.current.set(task.id, signature);
      if (!message || onUpload || (previous === signature && !visible.current.has(task.id))) continue;
      const goToTask = () => {
        actions.current.expand(task.id);
        actions.current.navigate('/upload');
        visible.current.get(task.id)?.close();
        visible.current.delete(task.id);
      };
      const acknowledge = () => {
        visible.current.get(task.id)?.close();
        visible.current.delete(task.id);
        void actions.current.dismiss(task.id).catch(error => {
          seen.current.delete(task.id);
          showError(error instanceof Error ? error.message : '确认失败，请重试');
        });
      };
      const options = {
        message,
        onClick: goToTask,
        action: task.status === 'completed'
          ? { label: '完成', icon: 'check' as const, ariaLabel: `确认完成 ${task.name}`, onClick: acknowledge }
          : { label: '查看', icon: 'arrow' as const, ariaLabel: `查看 ${task.name}`, onClick: goToTask },
      };
      const existing = visible.current.get(task.id);
      if (existing) existing.update(task, options);
      else visible.current.set(task.id, showTaskToast(task, options));
    }
  }, [tasks, location.pathname]);

  useEffect(() => () => {
    visible.current.forEach(handle => handle.close());
    visible.current.clear();
  }, []);
  return null;
}

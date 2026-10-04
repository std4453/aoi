import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useUploadTasks } from './useUploadTasks';
import { showError } from '../../components/Toast';
import { showTaskToast, type TaskToastHandle } from './TaskToast';
import FanboxSettingsDialog from '../../components/FanboxSettingsDialog';
import PixivSettingsDialog from '../../components/PixivSettingsDialog';
import type { UploadTask } from '../../../../shared/types';
import { uploadView } from './view-state';
import { taskStates, taskNeedsLogin } from './task-display';

export default function UploadTaskNotifications() {
  const { tasks, dismiss, resume } = useUploadTasks();
  const [loginTask, setLoginTask] = useState<UploadTask | null>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const seen = useRef(new Map<string, string>());
  const visible = useRef(new Map<string, TaskToastHandle>());
  const actions = useRef({ expand: uploadView.expand, dismiss, navigate });
  actions.current = { expand: uploadView.expand, dismiss, navigate };

  useEffect(() => {
    const onUpload = location.pathname.replace(/\/+$/, '') === '/upload';
    const currentIds = new Set(tasks.map(task => task.id));
    for (const [id, handle] of visible.current) {
      const task = tasks.find(item => item.id === id);
      if (!task || (onUpload && !taskNeedsLogin(task)) || taskStates[task.status].tone === 'neutral') {
        handle.close();
        visible.current.delete(id);
      }
    }
    for (const id of seen.current.keys()) if (!currentIds.has(id)) seen.current.delete(id);
    for (const task of tasks) {
      const signature = `${task.status}:${task.errorCode ?? ''}:${task.error ?? ''}`;
      const state = taskStates[task.status];
      const message = state.tone === 'neutral' ? undefined : state.label;
      const previous = seen.current.get(task.id);
      seen.current.set(task.id, signature);
      if (!message || (onUpload && !taskNeedsLogin(task)) || (previous === signature && !visible.current.has(task.id))) continue;
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
        message: taskNeedsLogin(task) ? '需要登录' : message,
        onClick: taskNeedsLogin(task) ? () => setLoginTask(task) : goToTask,
        action: taskNeedsLogin(task) ? { label: '登录', icon: 'arrow' as const, ariaLabel: `登录并重试 ${task.name}`, onClick: () => setLoginTask(task) } : task.status === 'completed'
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
  const saved = () => {
    if (!loginTask) return;
    void resume(loginTask.id).catch(error => showError(error instanceof Error ? error.message : '重试失败'));
  };
  return loginTask?.source === 'pixiv' ? <PixivSettingsDialog onClose={() => setLoginTask(null)} onSaved={saved} />
    : loginTask?.source === 'fanbox' ? <FanboxSettingsDialog onClose={() => setLoginTask(null)} onSaved={saved} /> : null;
}

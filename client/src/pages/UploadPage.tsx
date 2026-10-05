import UploadForm, { draftTitle } from '../features/uploads/UploadForm';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ChevronDown, ChevronUp, Upload } from 'lucide-react';
import type { UploadTask } from '../../../shared/types';
import { useUploadCards, useUploadDraft } from '../features/uploads/useUploadTasks';
import { DuplicateCard } from '../components/DuplicateUploadModal';
import { PasswordInput } from '../components/Form';
import PackProcessingResult from '../features/uploads/PackProcessingResult';
import FanboxSettingsDialog from '../components/FanboxSettingsDialog';
import PixivSettingsDialog from '../components/PixivSettingsDialog';
import MegaSettingsDialog from '../components/MegaSettingsDialog';
import { Button, IconButton, TextButton } from '../components/Button';
import { TaskSourceTitle, TaskSummaryContent } from '../features/uploads/TaskPresentation';
import { taskNoticeMessage, taskProgressDisplay, taskStates, taskNeedsLogin } from '../features/uploads/task-display';
import { TaskSurface, TaskActionRow, TaskNotice, TaskTextAction } from '../features/uploads/TaskPresentation';
import { uploadView, getUploadScrollY, saveUploadScrollY, getHandledRevealRevision, setHandledRevealRevision, taskRevealDelta, scrollWithTaskExpansion } from '../features/uploads/view-state';

function TaskCard({ task }: { task: UploadTask }) {
  const { expandedId, expand, dismiss, pause, resume, continueTask, reselect, hasLocalFiles, files } = useUploadCards();
  const navigate = useNavigate();
  const expanded = expandedId === task.id;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [cancelConfirm, setCancelConfirm] = useState(false);
  const [archivePassword, setArchivePassword] = useState('');
  const [sharePassword, setSharePassword] = useState('');
  const [details, setDetails] = useState(false);
  const [settings, setSettings] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const state = taskStates[task.status];
  const notice = taskNoticeMessage(task);
  const hasFiles = hasLocalFiles(task.id);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const taskFiles = files[task.id] || [];
  const progress = taskProgressDisplay(task);
  const remote = task.isRemote;
  const indeterminate = progress.percentage === undefined;
  const showProgress = state.content === 'transfer' || state.content === 'processing';
  return <TaskSurface task={task} expanded={expanded}>
    <div className="upload-card-header">
      <button type="button" className="upload-card-heading" data-expanded={expanded} aria-expanded={expanded} aria-controls={`task-${task.id}`}
        onClick={() => expand(expanded ? null : task.id)}>
        <TaskSummaryContent task={task} expanded={expanded} />
      </button>
      <IconButton className="upload-card-chevron" icon={expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        label={expanded ? '收起任务' : '展开任务'} aria-expanded={expanded} aria-controls={`task-${task.id}`} onClick={() => expand(expanded ? null : task.id)} />
    </div>
    <div id={`task-${task.id}`} className="upload-task-details" data-open={expanded} inert={!expanded}>
      <div className="min-h-0 overflow-hidden"><div className="flex flex-col gap-2 px-4 pb-3">
        {state.content === 'result' ? <PackProcessingResult key={task.packId} packId={task.packId} onDone={() => dismiss(task.id)} /> : <>
        {showProgress && <div><div className="mb-1.5 flex justify-between gap-3 text-xs leading-4 text-gray-500"><span>{progress.label}{progress.detail && ` · ${progress.detail}`}</span>{!indeterminate && <span className="shrink-0">{progress.percentage}%</span>}</div>
          <div role="progressbar" aria-label={progress.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress.percentage} className="h-2 overflow-hidden rounded-full bg-gray-800"><div className={`h-full rounded-full bg-blue-500 ${indeterminate ? `w-1/3 ${task.status === 'paused' ? '' : 'animate-pulse'}` : 'transition-all duration-300'}`} style={indeterminate ? undefined : { width: `${progress.percentage}%` }} /></div></div>}
        {notice && <TaskNotice tone={state.tone}>{notice}
          {taskNeedsLogin(task) && <> <TextButton disabled={busy} onClick={() => setSettings(!settings)} aria-expanded={settings}>配置登录</TextButton></>}
        </TaskNotice>}
        {task.status === 'duplicate' && task.matches.length > 0 && <div className="flex flex-col gap-2">
          {task.matches.map(pack => <DuplicateCard key={pack.id} pack={pack} disabled={busy} onSelect={() => navigate(`/packs/${pack.id}`)} />)}
        </div>}
        {(task.status === 'password' || task.status === 'failed') && (task.source === 'mega' || task.source === 'archive') && <div className="space-y-2">
          {task.source === 'mega' && (task.status !== 'password' || task.passwordKind !== 'archive') &&
            <PasswordInput value={sharePassword} onChange={setSharePassword} placeholder="分享密码 / 解密密钥" />}
          {(task.status !== 'password' || task.passwordKind !== 'share') &&
            <PasswordInput value={archivePassword} onChange={setArchivePassword} placeholder="压缩包密码" />}
        </div>}
        {state.content !== 'processing' && taskFiles.length > 1 && <div className={!error && !cancelConfirm ? '-mb-1' : undefined}><TaskTextAction onClick={() => setDetails(!details)} aria-expanded={details} aria-controls={`task-files-${task.id}`}>
          {details ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}{`${taskFiles.filter(file => file.status === 'uploaded').length}/${taskFiles.length} 个文件 · ${details ? '收起详情' : '查看详情'}`}</TaskTextAction>
          {details && <div id={`task-files-${task.id}`} className="mt-2 max-h-52 space-y-1 overflow-y-auto">{taskFiles.map(file => <div key={file.id} className="flex items-center gap-2 text-xs">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${file.status === 'uploaded' ? 'bg-green-500' : file.status === 'failed' ? 'bg-red-400' : file.status === 'uploading' ? 'bg-blue-500 animate-pulse' : 'bg-gray-600'}`} />
            <span className="min-w-0 flex-1 truncate text-gray-400" title={file.path}>{file.path}</span><span className="shrink-0 text-gray-500">{file.status === 'uploaded' ? '完成' : file.status === 'failed' ? '失败' : `${file.size ? Math.round(file.transferred / file.size * 100) : 0}%`}</span>
          </div>)}</div>}</div>}
        {settings && task.source === 'pixiv' && task.status === 'failed' && <PixivSettingsDialog onClose={() => setSettings(false)} onSaved={() => { void run(() => resume(task.id)); }} />}
        {settings && task.source === 'fanbox' && task.status === 'failed' && <FanboxSettingsDialog onClose={() => setSettings(false)} onSaved={() => { void run(() => resume(task.id)); }} />}
        {settings && task.source === 'mega' && task.status === 'failed' && <MegaSettingsDialog onClose={() => setSettings(false)} onSaved={() => { void run(() => resume(task.id)); }} />}
        <input ref={input} type="file" className="hidden" {...(task.source === 'folder' ? { webkitdirectory: '', directory: '' } : { accept: '.zip,.rar,.7z' })}
          onChange={event => { const selected = Array.from(event.target.files || []); event.target.value = ''; if (selected.length) void run(() => reselect(task.id, selected)); }} />
        {busy && <p role="status" className="sr-only">正在处理…</p>}
        {error && <TaskNotice role="alert" tone={state.tone}>{error}</TaskNotice>}
        {cancelConfirm ? <>
          <TaskNotice tone="neutral">确认取消此任务？本任务已上传的临时内容会被清理。</TaskNotice>
          <TaskActionRow><Button variant="secondary" disabled={busy} onClick={() => setCancelConfirm(false)}>保留任务</Button>
            <Button variant="danger" disabled={busy} onClick={() => { void run(() => dismiss(task.id)); }}>确认取消</Button></TaskActionRow>
        </> : <TaskActionRow>
            <Button variant="secondary" disabled={busy} onClick={() => setCancelConfirm(true)}>取消任务</Button>
            {task.status === 'duplicate' && <Button variant="primary" disabled={busy} onClick={() => { void run(() => continueTask(task.id)); }}>继续上传</Button>}
            {task.status === 'uploading' && hasFiles && <Button variant="primary" disabled={busy} onClick={() => { void run(() => pause(task.id)); }}>暂停</Button>}
            {task.status === 'paused' && hasFiles && <Button variant="primary" disabled={busy} onClick={() => { void run(() => resume(task.id)); }}>继续上传</Button>}
            {(task.status === 'needs_file' || (!hasFiles && !remote && task.status === 'failed' && !task.packId)) &&
              <Button variant="primary" disabled={busy} onClick={() => input.current?.click()}>{`重新选择${task.source === 'folder' ? '文件夹' : '压缩包'}`}</Button>}
            {(task.status === 'password' || task.status === 'failed') && (hasFiles || remote || task.packId) &&
              <Button variant="primary" disabled={busy} onClick={() => { void run(() => resume(task.id, { archivePassword: archivePassword || undefined, sharePassword: sharePassword || undefined })); }}>{task.status === 'password' ? '提交并继续' : '重试'}</Button>}
        </TaskActionRow>}
        </>}
      </div></div>
    </div>
  </TaskSurface>;
}

export default function UploadPage() {
  const { tasks, expandedId, revealRevision, exitingIds, error, loading, refresh } = useUploadCards();
  const { draft } = useUploadDraft();
  const formContainer = useRef<HTMLDivElement>(null);
  const stickyHeader = useRef<HTMLDivElement>(null);
  const stickyButton = useRef<HTMLButtonElement>(null);
  const taskListTitle = useRef<HTMLParagraphElement>(null);
  const taskList = useRef<HTMLDivElement>(null);
  const [showSticky, setShowSticky] = useState(false);
  const [enteringIds, setEnteringIds] = useState(new Set<string>());
  const seenTasks = useRef(new Set(tasks.map(task => task.id)));
  const loadedTasks = useRef(!loading);
  // Only newly arriving tasks animate. Mounting a cached list on a tab switch does not.
  useLayoutEffect(() => {
    if (loading) return;
    const additions = loadedTasks.current ? tasks.filter(task => !seenTasks.current.has(task.id)).map(task => task.id) : [];
    loadedTasks.current = true;
    seenTasks.current = new Set(tasks.map(task => task.id));
    if (additions.length) setEnteringIds(previous => new Set([...previous, ...additions]));
  }, [tasks, loading]);

  useLayoutEffect(() => {
    if (loading) return;
    window.scrollTo(0, getUploadScrollY());
    const update = () => {
      saveUploadScrollY(window.scrollY);
      const listTop = taskListTitle.current?.getBoundingClientRect().top ?? formContainer.current?.getBoundingClientRect().bottom ?? 0;
      const buttonBottom = (stickyButton.current?.offsetTop ?? 0) + (stickyButton.current?.offsetHeight ?? 0);
      setShowSticky(listTop < buttonBottom);
    };
    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    const observer = new ResizeObserver(update);
    if (formContainer.current) observer.observe(formContainer.current);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
      observer.disconnect();
    };
  }, [loading]);

  useEffect(() => { uploadView.resolveReveal(tasks, loading); }, [tasks, loading]);

  useLayoutEffect(() => {
    if (!expandedId || revealRevision === getHandledRevealRevision()) return;
    const list = taskList.current;
    const card = document.getElementById(`upload-card-${expandedId}`);
    if (!list || !card) return;
    setHandledRevealRevision(revealRevision);
    // Measure mounted content at its natural height, including the space lost
    // as preceding cards collapse. This gives the final bounds before paint.
    let top = list.getBoundingClientRect().top;
    let bottom = top;
    for (const frame of Array.from(list.children)) {
      const details = frame.querySelector<HTMLElement>('.upload-task-details')!;
      const article = frame.querySelector('article')!;
      const content = details.firstElementChild?.firstElementChild as HTMLElement;
      const spacing = parseFloat(getComputedStyle(article.parentElement!).paddingBottom);
      const height = frame.classList.contains('is-exiting') ? 0
        : article.getBoundingClientRect().height - details.getBoundingClientRect().height + spacing
          + (details.dataset.open === 'true' ? content.getBoundingClientRect().height : 0);
      if (frame === card) { bottom = top + height; break; }
      top += height;
    }
    const viewport = window.visualViewport;
    const viewportTop = viewport?.offsetTop ?? 0;
    const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
    const navigationTop = document.querySelector('nav')?.getBoundingClientRect().top ?? viewportBottom;
    const visibleBottom = Math.min(viewportBottom, navigationTop) - 8;
    const listTop = taskListTitle.current?.getBoundingClientRect().top ?? formContainer.current?.getBoundingClientRect().bottom ?? 0;
    const buttonBottom = (stickyButton.current?.offsetTop ?? 0) + (stickyButton.current?.offsetHeight ?? 0);
    const headerHeight = stickyHeader.current?.offsetHeight ?? 0;
    let visibleTop = viewportTop + (listTop < buttonBottom ? headerHeight : 0) + 8;
    let delta = taskRevealDelta(top, bottom, visibleTop, visibleBottom);
    // Scrolling down may reveal the floating header. Include that new obstruction.
    visibleTop = viewportTop + (listTop - delta < buttonBottom ? headerHeight : 0) + 8;
    delta = taskRevealDelta(top, bottom, visibleTop, visibleBottom);
    return scrollWithTaskExpansion(window.scrollY + delta);
  }, [expandedId, revealRevision]);

  return <div className="upload-panel mx-auto max-w-lg pb-4">
    <div className="mb-4 flex min-h-9 items-center justify-between gap-3"><h2 className="text-xl font-bold text-white">上传图包</h2>
      {tasks.length > 0 && <span className="text-xs text-gray-500">{tasks.length} 个任务</span>}</div>
    <div ref={formContainer} className="mb-4"><UploadForm /></div>
    <div ref={stickyHeader} className="upload-sticky" data-visible={showSticky} inert={!showSticky} aria-hidden={!showSticky} aria-label="返回上传表单">
      <button ref={stickyButton} type="button" onClick={() => window.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' })}
        className={`upload-return-button ${draft.source ? 'border-solid bg-gray-900 hover:bg-gray-800' : 'border-dashed bg-transparent hover:bg-gray-900'}`}>
        {draft.source ? <TaskSourceTitle source={draft.source} name={draftTitle(draft.source)} />
          : <span className="flex items-center justify-center gap-2 text-sm text-gray-400"><Upload size={16} aria-hidden="true" />上传图包</span>}
      </button>
      {tasks.length > 0 && <p className="mt-4 text-xs text-gray-500">任务列表</p>}
    </div>
    {error && <div role="alert" className="mb-4 rounded-xl border border-red-800/50 bg-red-900/20 p-3 text-sm text-red-300">{error}<Button variant="ghost" onClick={() => { void refresh(); }}>重试</Button></div>}
    {loading && <p role="status" className="py-4 text-center text-sm text-gray-500">正在读取上传任务…</p>}
    {tasks.length > 0 && <p ref={taskListTitle} className="mb-3 text-xs text-gray-500">任务列表</p>}
    <div ref={taskList} aria-label="上传任务列表">{tasks.map(task => <div id={`upload-card-${task.id}`} key={task.id} inert={exitingIds.has(task.id)}
      onAnimationEnd={event => {
        if (event.target === event.currentTarget) setEnteringIds(previous => new Set([...previous].filter(id => id !== task.id)));
      }}
      className={`upload-task-frame ${enteringIds.has(task.id) ? 'is-entering' : ''} ${exitingIds.has(task.id) ? 'is-exiting' : ''}`}>
      <div className="min-h-0 overflow-hidden"><div className="pb-3"><TaskCard task={task} /></div></div>
    </div>)}</div>
  </div>;
}

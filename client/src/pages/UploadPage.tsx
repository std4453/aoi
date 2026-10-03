import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronUp, FileArchive, FolderOpen, Plus, Tag, Upload } from 'lucide-react';
import type { UploadTask } from '../../../shared/types';
import { useUploadTasks } from '../hooks/useUploadTasks';
import { createTag, fetchTags } from '../api/packs';
import { formatBytes } from '../lib/utils';
import { DuplicateCard } from '../components/DuplicateUploadModal';
import { FormField, TextInput, PasswordInput, inputClass } from '../components/Form';
import ImportSources from '../components/ImportSources';
import PixivSettings from '../components/PixivSettings';
import { ActionRow, Button, IconButton } from '../components/Button';
import { TaskSourceTitle, TaskSummaryContent } from '../components/TaskSummary';
import { taskErrorMessage } from '../lib/upload-task-display';
import { getUploadScrollY, saveUploadScrollY, getHandledRevealRevision, setHandledRevealRevision, taskRevealDelta, scrollWithTaskExpansion } from '../lib/upload-page-state';

const labels: Record<UploadTask['status'], string> = {
  uploading: '上传中', downloading: '下载中', paused: '已暂停', needs_file: '等待原文件',
  processing: '正在处理图包', duplicate: '发现重复图包，等待确认', password: '需要密码', completed: '上传完成', failed: '需要处理',
};
const needsAttention = (task: UploadTask) => ['duplicate', 'password', 'needs_file', 'failed'].includes(task.status);
const taskFeedbackStyles = {
  failed: { border: 'border-red-500/60', panel: 'border-red-800/50 bg-red-900/20', text: 'text-red-300' },
  attention: { border: 'border-amber-500/60', panel: 'border-amber-800/50 bg-amber-500/10', text: 'text-amber-300' },
  completed: { border: 'border-green-700/70', panel: 'border-green-800/50 bg-green-900/20', text: 'text-green-300' },
  neutral: { border: '', panel: 'border-gray-700 bg-gray-800/50', text: 'text-gray-400' },
};

const draftTitle = (source: UploadTask['source'] | null) => source === 'pixiv' ? 'Pixiv 导入'
  : source === 'mega' ? 'MEGA 分享' : source === 'folder' ? '上传文件夹' : source === 'archive' ? '上传压缩包' : '上传图包';

function InlineTags() {
  const { draft, setDraft } = useUploadTasks();
  const [open, setOpen] = useState(false);
  const [tags, setTags] = useState<Array<{ id: string; name: string }>>([]);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const selectedKey = draft.tagIds.join(',');
  useEffect(() => {
    if (!open && !selectedKey) return;
    let active = true;
    void fetchTags().then(tags => { if (active) setTags(tags); }).catch(error => { if (active) setError(String(error)); });
    return () => { active = false; };
  }, [open, selectedKey]);
  const add = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const tag = await createTag(name.trim());
      setTags(previous => [...previous, tag]);
      setDraft({ tagIds: [...draft.tagIds, tag.id] });
      setName('');
      setError('');
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <div>
    <button type="button" onClick={() => setOpen(!open)} aria-expanded={open} aria-label={draft.tagIds.length ? `选择标签，已选择 ${draft.tagIds.length} 个` : '选择标签'}
      className="flex w-full items-center gap-2 rounded-lg border border-gray-700 bg-gray-800 px-3 py-2 text-sm text-gray-400">
      <Tag size={16} className="shrink-0" /> <span className="flex min-w-0 flex-1 flex-wrap gap-1 text-left">{draft.tagIds.length
        ? draft.tagIds.map(id => <span key={id} className="max-w-full truncate rounded bg-gray-700 px-1.5 py-0.5 text-xs text-gray-300">{tags.find(tag => tag.id === id)?.name ?? '…'}</span>)
        : '选择标签'}</span><ChevronDown size={14} className="shrink-0" />
    </button>
    {open && <div className="mt-2 space-y-3 rounded-xl border border-gray-800 p-3">
      <div className="flex max-h-40 flex-wrap gap-2 overflow-y-auto">
        {tags.map(tag => <button key={tag.id} type="button" aria-pressed={draft.tagIds.includes(tag.id)}
          onClick={() => setDraft({ tagIds: draft.tagIds.includes(tag.id) ? draft.tagIds.filter(id => id !== tag.id) : [...draft.tagIds, tag.id] })}
          className={`rounded-lg px-3 py-1.5 text-sm ${draft.tagIds.includes(tag.id) ? 'bg-blue-600/25 text-blue-300 ring-1 ring-blue-500/50' : 'bg-gray-800 text-gray-400'}`}>{tag.name}</button>)}
        {tags.length === 0 && <p className="text-xs text-gray-500">暂无标签，可以在下方创建。</p>}
      </div>
      <div className="flex gap-2"><input value={name} onChange={event => setName(event.target.value)} placeholder="新建标签" aria-label="新建标签" className={inputClass}
        onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void add(); } }} />
        <IconButton onClick={() => { void add(); }} disabled={!name.trim() || busy} label="创建标签" icon={<Plus size={16} />} /></div>
      {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    </div>}
  </div>;
}

async function readDirectory(directory: FileSystemDirectoryEntry, root = directory.name): Promise<File[]> {
  const files: File[] = [];
  const reader = directory.createReader();
  while (true) {
    const entries = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (entries.length === 0) break;
    for (const entry of entries) {
      const path = `${root}/${entry.name}`;
      if (entry.isDirectory) files.push(...await readDirectory(entry as FileSystemDirectoryEntry, path));
      else {
        const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject));
        Object.defineProperty(file, 'webkitRelativePath', { value: path });
        files.push(file);
      }
    }
  }
  return files;
}

function UploadForm() {
  const { draft, setDraft, resetDraft, start, starting, metadataLoading, metadataError } = useUploadTasks();
  const formId = useId();
  const archiveInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
  const [settings, setSettings] = useState(false);
  const select = (files: File[], folder: boolean) => {
    if (!files.length) { setError('文件夹为空'); return; }
    if (!folder && !/\.(zip|rar|7z)$/i.test(files[0].name)) { setError('请选择 ZIP、RAR、7Z 压缩包或文件夹'); return; }
    setError('');
    setDraft({ source: folder ? 'folder' : 'archive', files,
      name: folder ? files[0].webkitRelativePath.split('/')[0] : files[0].name.replace(/\.[^.]+$/, ''),
    });
  };
  const drop = async (event: React.DragEvent) => {
    if (!Array.from(event.dataTransfer.types).includes('Files')) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (starting || scanning) return;
    const entry = event.dataTransfer.items[0]?.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      setScanning(true);
      try { select(await readDirectory(entry as FileSystemDirectoryEntry), true); }
      catch (error) { setError(error instanceof Error ? error.message : String(error)); }
      finally { setScanning(false); }
    } else select(Array.from(event.dataTransfer.files).slice(0, 1), false);
  };
  const remote = draft.source === 'mega' || draft.source === 'pixiv';
  const canStart = remote ? Boolean(draft.url.trim()) : draft.files.length > 0;
  const title = draftTitle(draft.source);
  return <div onDrop={event => { void drop(event); }}
    onDragEnter={event => {
      if (!Array.from(event.dataTransfer.types).includes('Files') || starting || scanning) return;
      event.preventDefault(); dragDepth.current++; setDragging(true);
    }}
    onDragOver={event => {
      if (!Array.from(event.dataTransfer.types).includes('Files')) return;
      event.preventDefault(); event.dataTransfer.dropEffect = starting || scanning ? 'none' : 'copy';
    }}
    onDragLeave={event => {
      if (!Array.from(event.dataTransfer.types).includes('Files')) return;
      dragDepth.current = Math.max(0, dragDepth.current - 1);
      if (!dragDepth.current) setDragging(false);
    }}
    className={`relative overflow-hidden rounded-xl border transition-colors ${draft.source ? 'bg-gray-900' : 'border-dashed pt-2'} ${dragging ? 'border-blue-500' : 'border-gray-700'}`}>
    <div className={dragging ? 'invisible pointer-events-none' : ''} inert={dragging}>
    <input ref={archiveInput} type="file" accept={/iPad|iPhone|iPod/.test(navigator.userAgent) ? undefined : '.zip,.rar,.7z'} className="hidden"
      onChange={event => { select(Array.from(event.target.files || []), false); event.target.value = ''; }} />
    <input ref={folderInput} type="file" {...{ webkitdirectory: '', directory: '' }} className="hidden"
      onChange={event => { select(Array.from(event.target.files || []), true); event.target.value = ''; }} />
    <div className="upload-card-heading upload-form-heading" data-expanded="true">
      {draft.source ? <TaskSourceTitle source={draft.source} name={title} expanded />
        : <span className="flex items-center justify-center gap-2 text-sm text-gray-400"><Upload size={20} aria-hidden="true" />上传图包</span>}
    </div>
    <div className="px-4 pb-4">
    {!draft.source ? <>
      <div className="py-3 text-center">
        <ActionRow><Button variant="secondary" icon={<FileArchive size={16} />} onClick={() => archiveInput.current?.click()} disabled={starting || scanning}>选择压缩包</Button>
          <Button variant="secondary" icon={<FolderOpen size={16} />} onClick={() => folderInput.current?.click()} disabled={starting || scanning}>选择文件夹</Button></ActionRow>
        <p className="mt-2 text-xs text-gray-500">支持 ZIP、RAR、7Z 压缩包或文件夹</p>
        {scanning && <p role="status" className="mt-2 text-xs text-gray-500">正在读取文件夹…</p>}
      </div>
      <ImportSources compact availableSources={['pixiv', 'mega']} onSelect={source => { setSettings(false); resetDraft(); setDraft({ source }); }} />
    </> : <form id={formId} onSubmit={event => { event.preventDefault(); if (canStart && !starting && !scanning) void start(); }} className="flex flex-col gap-3">
      {remote && <FormField label={draft.source === 'pixiv' ? '作品网址' : '分享链接'} hint={metadataLoading ? <span className="text-xs text-gray-500">识别中…</span> : undefined}>
        <TextInput type="url" required value={draft.url} onChange={event => setDraft({ url: event.target.value })} disabled={starting}
          placeholder={draft.source === 'pixiv' ? 'https://www.pixiv.net/artworks/…' : 'https://mega.nz/file/… 或 /folder/…'} />
      </FormField>}
      {metadataError && <div className="text-xs text-amber-400" role="status">{metadataError}
        {draft.source === 'pixiv' && <Button variant="ghost" onClick={() => setSettings(!settings)}>配置登录</Button>}</div>}
      <FormField label="图包名称"><TextInput value={draft.name} onChange={event => setDraft({ name: event.target.value })}
        placeholder={remote ? '自动使用分享标题' : '图包名称'} maxLength={200} disabled={starting} /></FormField>
      {!remote && <p className="text-xs text-gray-500">{draft.source === 'folder' ? `${draft.files.length} 个文件` : draft.files[0]?.name} · {formatBytes(draft.files.reduce((sum, file) => sum + file.size, 0))}</p>}
      {draft.source === 'mega' && <PasswordInput value={draft.sharePassword} onChange={sharePassword => setDraft({ sharePassword })} placeholder="分享密码 / 解密密钥" disabled={starting} />}
      {(draft.source === 'archive' || draft.source === 'mega') && <PasswordInput value={draft.archivePassword} onChange={archivePassword => setDraft({ archivePassword })} placeholder="压缩包密码" disabled={starting} />}
      <InlineTags />
    </form>}
    {settings && draft.source === 'pixiv' && <div className="mt-3 rounded-xl border border-gray-800"><PixivSettings onClose={() => setSettings(false)} onSaved={() => setDraft({ url: draft.url })} /></div>}
    {error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
    {draft.source && <ActionRow className="mt-3"><Button variant="secondary" onClick={() => { setSettings(false); setError(''); resetDraft(); }} disabled={starting}>取消上传</Button>
      <Button variant="primary" type="submit" form={formId} disabled={!canStart || starting || scanning}>{starting ? '正在创建任务…' : remote ? '开始导入' : '开始上传'}</Button></ActionRow>}
    </div></div>
    {dragging && <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-blue-400" role="status"><Upload size={32} /><span className="text-sm">松开以上传压缩包或文件夹</span></div>}
  </div>;
}

function TaskCard({ task }: { task: UploadTask }) {
  const { expandedId, expand, dismiss, pause, resume, continueTask, reselect, hasLocalFiles, files } = useUploadTasks();
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
  const attention = needsAttention(task);
  const completed = task.status === 'completed';
  const feedback = taskFeedbackStyles[task.status === 'failed' ? 'failed' : attention ? 'attention' : completed ? 'completed' : 'neutral'];
  const hasFiles = hasLocalFiles(task.id);
  const run = async (action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError('');
    try { await action(); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const taskFiles = files[task.id] || [];
  const progress = Math.max(0, Math.min(100, task.progress));
  const stage = task.status === 'duplicate' && !expanded ? '待确认' : task.status === 'processing' && !expanded ? '处理中' : labels[task.status];
  const remote = task.source === 'mega' || task.source === 'pixiv';
  const indeterminate = remote && task.status === 'downloading' && task.totalBytes <= 0;
  const showProgress = !completed && !attention;
  return <article className={`overflow-hidden rounded-xl border bg-gray-900 transition-colors ${feedback.border || (expanded ? 'border-gray-700' : 'border-gray-800 hover:border-gray-600')}`}>
    <div className="upload-card-header">
      <button type="button" className="upload-card-heading" data-expanded={expanded} aria-expanded={expanded} aria-controls={`task-${task.id}`}
        onClick={() => expand(expanded ? null : task.id)}>
        <TaskSummaryContent task={task} expanded={expanded} />
      </button>
      <IconButton className="upload-card-chevron" icon={expanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        label={expanded ? '收起任务' : '展开任务'} aria-expanded={expanded} aria-controls={`task-${task.id}`} onClick={() => expand(expanded ? null : task.id)} />
    </div>
    <div id={`task-${task.id}`} className="upload-task-details" data-open={expanded} inert={!expanded}>
      <div className="min-h-0 overflow-hidden"><div className="flex flex-col gap-3 px-4 pb-4">
        {showProgress && <div><div className="mb-2 flex justify-between gap-3 text-xs text-gray-500"><span>{task.source === 'pixiv' ? 'Pixiv 导入' : task.source === 'mega' ? 'MEGA 导入' : task.source === 'folder' ? '文件夹上传' : '压缩包上传'}{task.totalBytes > 0 && ` · ${formatBytes(task.transferredBytes)} / ${formatBytes(task.totalBytes)}`}</span>{!indeterminate && <span>{progress}%</span>}</div>
          <div role="progressbar" aria-label={stage} aria-valuemin={0} aria-valuemax={100} aria-valuenow={indeterminate ? undefined : progress} className="h-2 overflow-hidden rounded-full bg-gray-800"><div className={`h-full rounded-full bg-blue-500 ${indeterminate ? 'w-1/3 animate-pulse' : 'transition-all duration-300'}`} style={indeterminate ? undefined : { width: `${progress}%` }} /></div></div>}
        {task.error && <p role="status" className={`break-words rounded-xl border p-3 text-sm ${feedback.panel} ${feedback.text}`}>{taskErrorMessage(task)}</p>}
        {task.status === 'duplicate' && <div className="flex flex-col gap-3">
          <p className={`rounded-lg bg-amber-500/10 px-3 py-2 text-sm ${feedback.text}`}>此图包可能已被上传过，请确认是否继续。</p>
          {task.matches.map(pack => <DuplicateCard key={pack.id} pack={pack} disabled={busy} onSelect={() => navigate(`/packs/${pack.id}`)} />)}
        </div>}
        {(task.status === 'password' || task.status === 'failed') && (task.source === 'mega' || task.source === 'archive') && <div className="space-y-2">
          {task.status === 'password' && !task.error && <p className={`text-xs ${feedback.text}`}>{task.passwordKind === 'share' ? '请填写此 MEGA 分享的密码或解密密钥后继续。' : '请填写压缩包的解压密码后继续。'}</p>}
          {task.source === 'mega' && (task.status !== 'password' || task.passwordKind !== 'archive') &&
            <PasswordInput value={sharePassword} onChange={setSharePassword} placeholder="分享密码 / 解密密钥" />}
          {(task.status !== 'password' || task.passwordKind !== 'share') &&
            <PasswordInput value={archivePassword} onChange={setArchivePassword} placeholder="压缩包密码" />}
        </div>}
        {task.status === 'needs_file' && <p className={`text-sm leading-relaxed ${feedback.text}`}>刷新后需重新选择原来的{task.source === 'folder' ? '文件夹' : '压缩包'}以继续上传。已上传的内容会保留。</p>}
        {completed && <p className={`text-sm ${feedback.text}`}>图包已处理完成，确认后移除任务。</p>}
        {taskFiles.length > 1 && <div><Button variant="ghost" onClick={() => setDetails(!details)} aria-expanded={details}>
          {`${taskFiles.filter(file => file.status === 'uploaded').length}/${taskFiles.length} 个文件 · ${details ? '收起详情' : '查看详情'}`}</Button>
          {details && <div className="mt-2 max-h-52 space-y-1 overflow-y-auto">{taskFiles.map(file => <div key={file.id} className="flex items-center gap-2 text-xs">
            <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${file.status === 'uploaded' ? 'bg-green-500' : file.status === 'failed' ? 'bg-red-400' : file.status === 'uploading' ? 'bg-blue-500 animate-pulse' : 'bg-gray-600'}`} />
            <span className="min-w-0 flex-1 truncate text-gray-400" title={file.path}>{file.path}</span><span className="shrink-0 text-gray-500">{file.status === 'uploaded' ? '完成' : file.status === 'failed' ? '失败' : `${file.size ? Math.round(file.transferred / file.size * 100) : 0}%`}</span>
          </div>)}</div>}</div>}
        {task.source === 'pixiv' && task.status === 'failed' && <Button variant="ghost" disabled={busy} onClick={() => setSettings(!settings)} aria-expanded={settings}>配置登录</Button>}
        {settings && task.source === 'pixiv' && task.status === 'failed' && <div className="rounded-xl border border-gray-800"><PixivSettings onClose={() => setSettings(false)} onSaved={() => { void run(() => resume(task.id)); }} /></div>}
        <input ref={input} type="file" className="hidden" {...(task.source === 'folder' ? { webkitdirectory: '', directory: '' } : { accept: '.zip,.rar,.7z' })}
          onChange={event => { const selected = Array.from(event.target.files || []); event.target.value = ''; if (selected.length) void run(() => reselect(task.id, selected)); }} />
        {busy && <p role="status" className="sr-only">正在处理…</p>}
        {error && <p role="alert" className={`text-sm ${feedback.text}`}>{error}</p>}
        {cancelConfirm && !completed ? <>
          <p className="text-sm text-gray-400">确认取消此任务？本任务已上传的临时内容会被清理。</p>
          <ActionRow><Button variant="secondary" disabled={busy} onClick={() => setCancelConfirm(false)}>保留任务</Button>
            <Button variant="danger" disabled={busy} onClick={() => { void run(() => dismiss(task.id)); }}>确认取消</Button></ActionRow>
        </> : <ActionRow>
          {completed ? <>
            {task.packId && <Button variant="secondary" disabled={busy} onClick={() => navigate(`/packs/${task.packId}`)}>查看图包</Button>}
            <Button variant="primary" disabled={busy} onClick={() => { void run(() => dismiss(task.id)); }}>完成</Button>
          </> : <>
            <Button variant="secondary" disabled={busy} onClick={() => setCancelConfirm(true)}>取消任务</Button>
            {task.status === 'duplicate' && <Button variant="primary" disabled={busy} onClick={() => { void run(() => continueTask(task.id)); }}>继续上传</Button>}
            {task.status === 'uploading' && hasFiles && <Button variant="primary" disabled={busy} onClick={() => { void run(() => pause(task.id)); }}>暂停</Button>}
            {task.status === 'paused' && hasFiles && <Button variant="primary" disabled={busy} onClick={() => { void run(() => resume(task.id)); }}>继续上传</Button>}
            {(task.status === 'needs_file' || (!hasFiles && !remote && task.status === 'failed' && !task.packId)) &&
              <Button variant="primary" disabled={busy} onClick={() => input.current?.click()}>{`重新选择${task.source === 'folder' ? '文件夹' : '压缩包'}`}</Button>}
            {(task.status === 'password' || task.status === 'failed') && (hasFiles || remote || task.packId) &&
              <Button variant="primary" disabled={busy} onClick={() => { void run(() => resume(task.id, { archivePassword: archivePassword || undefined, sharePassword: sharePassword || undefined })); }}>{task.status === 'password' ? '提交密码并继续' : '重试'}</Button>}
          </>}
        </ActionRow>}
      </div></div>
    </div>
  </article>;
}

export default function UploadPage() {
  const { tasks, expandedId, revealRevision, expand, exitingIds, draft, error, loading, refresh } = useUploadTasks();
  const formContainer = useRef<HTMLDivElement>(null);
  const stickyHeader = useRef<HTMLDivElement>(null);
  const stickyButton = useRef<HTMLButtonElement>(null);
  const taskListTitle = useRef<HTMLParagraphElement>(null);
  const taskList = useRef<HTMLDivElement>(null);
  const [showSticky, setShowSticky] = useState(false);
  const [enteringIds, setEnteringIds] = useState(new Set<string>());
  const seenTasks = useRef(new Set(tasks.map(task => task.id)));
  const loadedTasks = useRef(!loading);
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedTask = searchParams.get('task');
  const requestedFolder = searchParams.get('folder');

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

  useEffect(() => {
    const task = requestedTask ? tasks.find(task => task.id === requestedTask) : requestedFolder ? tasks.find(task => task.packId === requestedFolder) : undefined;
    if (task) { expand(task.id); setSearchParams({}, { replace: true }); }
  }, [requestedTask, requestedFolder, tasks, expand, setSearchParams]);

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

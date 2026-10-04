import UploadDraftForm from './UploadDraftForm';
import { useRef, useState } from 'react';
import { FileArchive, FolderOpen, Upload } from 'lucide-react';
import type { UploadTask } from '../../../../shared/types';
import { useUploadDraft } from './useUploadTasks';
import ImportSources from '../../components/ImportSources';
import { ActionRow, Button } from '../../components/Button';
import { TaskSourceTitle } from './TaskPresentation';

export const draftTitle = (source: UploadTask['source'] | null) => source === 'pixiv' ? 'Pixiv 导入'
  : source === 'fanbox' ? 'FANBOX 导入' : source === 'mega' ? 'MEGA 分享' : source === 'folder' ? '上传文件夹' : source === 'archive' ? '上传压缩包' : '上传图包';

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

export default function UploadForm() {
  const { draft, setDraft, resetDraft, starting } = useUploadDraft();
  const archiveInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState('');
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
      <ImportSources compact availableSources={['pixiv', 'mega', 'fanbox']} onSelect={source => { resetDraft(); setDraft({ source }); }} />
    </> : <UploadDraftForm scanning={scanning} error={error} onCancel={() => setError('')} />}
    {!draft.source && error && <p role="alert" className="mt-3 text-sm text-red-400">{error}</p>}
    </div></div>
    {dragging && <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-blue-400" role="status"><Upload size={32} /><span className="text-sm">松开以上传压缩包或文件夹</span></div>}
  </div>;
}

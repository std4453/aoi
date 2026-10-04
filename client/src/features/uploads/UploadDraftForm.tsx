import { useId, useState } from 'react';
import { useUploadDraft } from './useUploadTasks';
import { formatBytes } from '../../lib/utils';
import { TextInput, PasswordInput } from '../../components/Form';
import TagSelectField from '../../components/TagSelectField';
import FanboxSettings from '../../components/FanboxSettings';
import PixivSettings from '../../components/PixivSettings';
import { ActionRow, Button, TextButton } from '../../components/Button';

export default function UploadDraftForm({ scanning, error, onCancel }: {
  scanning: boolean; error: string; onCancel: () => void;
}) {
  const { draft, setDraft, resetDraft, start, starting, metadataLoading, metadataError, error: draftError } = useUploadDraft();
  const formId = useId();
  const [settings, setSettings] = useState(false);
  const remote = draft.isRemote;
  const canStart = remote ? Boolean(draft.url.trim()) : draft.files.length > 0;
  return <>
    <form id={formId} onSubmit={event => { event.preventDefault(); if (canStart && !starting && !scanning) void start(); }}>
      <div className="flex flex-col gap-3">
        {remote && <div className="relative">
          <TextInput type="url" required value={draft.url} onChange={event => setDraft({ url: event.target.value })} disabled={starting}
            aria-label={draft.source === 'fanbox' ? '帖子网址' : draft.source === 'pixiv' ? '作品网址' : '分享链接'} aria-busy={metadataLoading} className={metadataLoading ? 'pr-20' : ''}
            placeholder={draft.source === 'fanbox' ? '帖子网址（FANBOX）' : draft.source === 'pixiv' ? '作品网址（Pixiv）' : '分享链接（MEGA 文件或文件夹）'} />
          {metadataLoading && <span role="status" className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-xs text-gray-500">识别中…</span>}
        </div>}
        {metadataError && <div className="text-xs text-amber-400" role="status">{metadataError}
          {(draft.source === 'pixiv' || draft.source === 'fanbox') && <> <TextButton onClick={() => setSettings(!settings)} aria-expanded={settings}>配置登录</TextButton></>}</div>}
        <TextInput value={draft.name} onChange={event => setDraft({ name: event.target.value })} aria-label="图包名称"
          placeholder={draft.source === 'pixiv' ? '图包名称（自动使用作品标题）' : draft.source === 'fanbox' ? '图包名称（自动使用投稿标题）'
            : remote ? '图包名称（自动使用分享标题）' : '图包名称'} maxLength={200} disabled={starting} />
        {!remote && <p className="text-xs text-gray-500">{draft.source === 'folder' ? `${draft.files.length} 个文件` : draft.files[0]?.name} · {formatBytes(draft.files.reduce((sum, file) => sum + file.size, 0))}</p>}
        {draft.source === 'mega' && <PasswordInput value={draft.sharePassword} onChange={sharePassword => setDraft({ sharePassword })} placeholder="分享密码 / 解密密钥" disabled={starting} />}
        {(draft.source === 'archive' || draft.source === 'mega') && <PasswordInput value={draft.archivePassword} onChange={archivePassword => setDraft({ archivePassword })} placeholder="压缩包密码" disabled={starting} />}
      </div>
      <div className="mt-3"><TagSelectField value={draft.tagIds} onChange={tagIds => setDraft({ tagIds })} disabled={starting} /></div>
      {(error || draftError) && <p role="alert" className="mt-3 text-sm text-red-400">{error || draftError}</p>}
      <ActionRow className="mt-4"><Button variant="secondary" onClick={() => { setSettings(false); onCancel(); resetDraft(); }} disabled={starting}>取消上传</Button>
        <Button variant="primary" type="submit" form={formId} disabled={!canStart || starting || scanning}>{starting ? '正在创建任务…' : remote ? '开始导入' : '开始上传'}</Button></ActionRow>
    </form>
    {settings && draft.source === 'pixiv' && <PixivSettings onClose={() => setSettings(false)} onSaved={() => setDraft({ url: draft.url })} />}
    {settings && draft.source === 'fanbox' && <FanboxSettings onClose={() => setSettings(false)} onSaved={() => setDraft({ url: draft.url })} />}
  </>;
}

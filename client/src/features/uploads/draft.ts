import type { CreateUploadTaskRequest, UploadTask } from '../../../../shared/types';
import * as pixiv from '../../api/pixiv';
import * as fanbox from '../../api/fanbox';
import * as mega from '../../api/mega';

export interface UploadDraft {
  source: UploadTask['source'] | null;
  files: File[];
  name: string;
  url: string;
  sharePassword: string;
  archivePassword: string;
  tagIds: string[];
}

const emptyDraft = (): UploadDraft => ({ source: null, files: [], name: '', url: '', sharePassword: '', archivePassword: '', tagIds: [] });
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const defaults = { fetchPixivMetadata: pixiv.fetchPixivMetadata, fetchMegaMetadata: mega.fetchMegaMetadata, fetchFanboxMetadata: fanbox.fetchFanboxMetadata };
export function createUploadDraft(overrides: Partial<typeof defaults> = {}) {
  const dependencies = { ...defaults, ...overrides };
  let snapshot = { draft: emptyDraft(), starting: false, metadataLoading: false, metadataError: null as string | null, error: null as string | null };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<typeof snapshot>) => { snapshot = { ...snapshot, ...patch }; listeners.forEach(listener => listener()); };
  let metadataRevision = 0;
  let metadataTimer: ReturnType<typeof setTimeout> | undefined;
  let nameEdited = false;
  let tagsEdited = false;
  let metadataReady = false;
  function reset() {
    clearTimeout(metadataTimer);
    metadataRevision++;
    nameEdited = false;
    tagsEdited = false;
    metadataReady = false;
    publish({ draft: emptyDraft(), metadataLoading: false, metadataError: null, error: null });
  }

  function setDraft(patch: Partial<UploadDraft>) {
    const sourceChanged = patch.source !== undefined && patch.source !== snapshot.draft.source;
    if (sourceChanged) reset();
    if (!sourceChanged && patch.name !== undefined) nameEdited = true;
    if (patch.tagIds !== undefined) tagsEdited = true;
    publish({ draft: { ...snapshot.draft, ...patch } });
    if (!sourceChanged && patch.url === undefined && patch.sharePassword === undefined) return;
    clearTimeout(metadataTimer);
    const revision = ++metadataRevision;
    metadataReady = false;
    const { source, url, sharePassword } = snapshot.draft;
    publish({ metadataLoading: false, metadataError: null, draft: {
      ...snapshot.draft,
      ...(!nameEdited && (source === 'mega' || source === 'pixiv' || source === 'fanbox') ? { name: '' } : {}),
      ...(!tagsEdited ? { tagIds: [] } : {}),
    } });
    const valid = source === 'pixiv'
      ? /^https:\/\/(www\.)?pixiv\.net\/(?:[a-z]{2}\/)?artworks\/[1-9]\d*(?:[/?#].*)?$/.test(url.trim())
      : source === 'fanbox'
        ? /^https:\/\/(?:www\.fanbox\.cc\/@[A-Za-z0-9_-]+|fanbox\.cc\/@[A-Za-z0-9_-]+|[A-Za-z0-9_-]+\.fanbox\.cc)\/posts\/[1-9]\d*(?:[/?#].*)?$/.test(url.trim())
        : source === 'mega' && /^https:\/\/(?:www\.)?(?:mega\.nz|mega\.co\.nz)\//.test(url.trim());
    if (!valid) return;
    publish({ metadataLoading: true });
    metadataTimer = setTimeout(() => {
      const request = source === 'pixiv' ? dependencies.fetchPixivMetadata(url.trim())
        : source === 'fanbox' ? dependencies.fetchFanboxMetadata(url.trim()) : dependencies.fetchMegaMetadata(url.trim(), sharePassword || undefined);
      void request.then(metadata => {
        if (revision !== metadataRevision || snapshot.starting) return;
        metadataReady = true;
        publish({ draft: { ...snapshot.draft,
          ...(!nameEdited ? { name: metadata.title.slice(0, 200) } : {}),
          ...(!tagsEdited && 'tags' in metadata ? { tagIds: metadata.tags.map(tag => tag.id) } : {}),
        } });
      }).catch(error => {
        if (revision === metadataRevision && !snapshot.starting) publish({ metadataError: message(error) });
      }).finally(() => {
        if (revision === metadataRevision) publish({ metadataLoading: false });
      });
    }, 500);
  }

  async function submit(create: (input: CreateUploadTaskRequest, local: { files: File[]; tagIds: string[]; archivePassword?: string }) => Promise<UploadTask>) {
    if (snapshot.starting || !snapshot.draft.source) return;
    const draft = snapshot.draft;
    const remote = draft.source === 'mega' || draft.source === 'pixiv' || draft.source === 'fanbox';
    clearTimeout(metadataTimer); metadataRevision++;
    publish({ starting: true, error: null });
    try {
      const input: CreateUploadTaskRequest = {
        source: draft.source!,
        name: draft.name.trim() || (remote ? `${draft.source === 'mega' ? 'MEGA' : draft.source === 'fanbox' ? 'FANBOX' : 'Pixiv'} 导入` : draft.files[0]?.name.replace(/\.[^.]+$/, '') || '文件夹上传'),
        autoName: remote && (!nameEdited || !draft.name.trim()),
        filename: draft.source === 'archive' ? draft.files[0]?.name : undefined,
        fileSize: draft.files.reduce((sum, file) => sum + file.size, 0),
        tagIds: (draft.source === 'pixiv' || draft.source === 'fanbox') && !tagsEdited && !metadataReady ? undefined : draft.tagIds,
        url: remote ? draft.url.trim() : undefined,
        sharePassword: draft.sharePassword || undefined,
        archivePassword: draft.archivePassword || undefined,
      };

      const task = await create(input, { files: draft.files, tagIds: draft.tagIds, archivePassword: draft.archivePassword || undefined });
      reset();
      return task;
    } catch (error) { publish({ error: message(error) }); }
    finally { publish({ starting: false, metadataLoading: false }); }
  }
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setDraft, resetDraft: reset, submit,
    dispose: () => { clearTimeout(metadataTimer); metadataRevision++; listeners.clear(); },
  };
}
export const uploadDraft = createUploadDraft();

import type { Pack } from '../../../shared/types';

export function shouldPollPack(pack: Pick<Pack, 'status' | 'sourceType' | 'originalFormat'> | null): boolean {
  if (!pack) return false;
  return (pack.status === 'uploading' && (pack.sourceType === 'archive' || pack.originalFormat === 'pixiv'))
    || ['extracting', 'thumbnailing', 'verifying', 'awaiting_confirmation'].includes(pack.status);
}

export function shouldReloadPackPreview(previous: Pack['status'] | undefined, current: Pack['status'] | undefined): boolean {
  return ['uploading', 'extracting', 'thumbnailing', 'verifying', 'awaiting_confirmation'].includes(previous ?? '')
    && (current === 'extracted' || current === 'generated');
}

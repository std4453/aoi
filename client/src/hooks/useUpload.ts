import { activeServer, apiUrl, authHeaders } from '../lib/connection';
import { useState, useCallback, useRef } from 'react';
import * as tus from 'tus-js-client';
import { confirmUpload } from '../api/packs';
import type { ArchiveUploadRequest, DuplicatePack } from '../../../shared/types.js';

interface UploadState {
  progress: number;
  status: 'idle' | 'uploading' | 'paused' | 'checking' | 'duplicate' | 'confirming' | 'cancelling' | 'error' | 'done';
  error: string | null;
}

export function useUpload() {
  const [state, setState] = useState<UploadState>({ progress: 0, status: 'idle', error: null });
  const [matches, setMatches] = useState<DuplicatePack[]>([]);
  const [packId, setPackId] = useState<string | null>(null);
  const uploadRef = useRef<tus.Upload | null>(null);
  const requestRef = useRef<ArchiveUploadRequest | null>(null);
  const generation = useRef(0);
  const busy = useRef(false);
  const pendingKey = useRef('');

  const removePending = useCallback(() => {
    const pending = JSON.parse(localStorage.getItem(`pendingUploads:${activeServer?.id || 'local'}`) || '[]');
    localStorage.setItem(`pendingUploads:${activeServer?.id || 'local'}`, JSON.stringify(pending.filter((item: { key?: string }) => item.key !== pendingKey.current)));
  }, []);

  const confirm = useCallback(async (allowDuplicate = false) => {
    if (!requestRef.current || busy.current) return;
    busy.current = true;
    const attempt = generation.current;
    requestRef.current.allowDuplicate = allowDuplicate;
    setState(previous => ({ ...previous, status: allowDuplicate ? 'confirming' : 'checking', error: null }));
    try {
      const result = await confirmUpload(requestRef.current);
      if (attempt !== generation.current) return;
      if ('code' in result) {
        setMatches(result.matches);
        setState(previous => ({ ...previous, status: 'duplicate' }));
      } else {
        setPackId(result.id);
        setMatches([]);
        requestRef.current = null;
        removePending();
        setState({ progress: 100, status: 'done', error: null });
      }
    } catch (error) {
      if (attempt === generation.current) {
        setState(previous => ({ ...previous, status: 'error', error: `处理失败：${error instanceof Error ? error.message : String(error)}` }));
      }
    } finally {
      if (attempt === generation.current) busy.current = false;
    }
  }, [removePending]);

  const startUpload = useCallback((file: File, packName: string, archivePassword?: string, tagIds?: string[]) => {
    const attempt = ++generation.current;
    busy.current = false;
    requestRef.current = null;
    setMatches([]);
    setPackId(null);
    setState({ progress: 0, status: 'uploading', error: null });
    const name = packName || file.name.replace(/\.[^/.]+$/, '');
    const upload = new tus.Upload(file, {
      endpoint: apiUrl('/api/upload/files'),
      headers: authHeaders(),
      chunkSize: Infinity,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      metadata: { filename: file.name, filetype: file.type || 'application/octet-stream' },
      onError: error => {
        if (attempt === generation.current && !busy.current) setState(previous => ({ ...previous, status: 'error', error: error.message }));
      },
      onSuccess: () => {
        if (attempt !== generation.current || busy.current) return;
        requestRef.current = {
          uploadId: upload.url?.split('/').pop() || '',
          filename: file.name, fileSize: file.size, packName: name, archivePassword, tagIds,
        };
        void confirm();
      },
      onProgress: (uploaded, total) => {
        if (attempt === generation.current && !busy.current) setState(previous => ({ ...previous, progress: total > 0 ? Math.round(uploaded / total * 100) : 0 }));
      },
    });
    uploadRef.current = upload;
    pendingKey.current = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const pending = JSON.parse(localStorage.getItem(`pendingUploads:${activeServer?.id || 'local'}`) || '[]');
    pending.push({ key: pendingKey.current, filename: file.name, packName: name, size: file.size, createdAt: Date.now() });
    localStorage.setItem(`pendingUploads:${activeServer?.id || 'local'}`, JSON.stringify(pending));
    upload.start();
  }, [confirm]);

  const pause = useCallback(() => {
    void uploadRef.current?.abort();
    setState(previous => ({ ...previous, status: 'paused' }));
  }, []);

  const resume = useCallback(() => {
    if (requestRef.current) {
      void confirm(requestRef.current.allowDuplicate);
    } else if (uploadRef.current) {
      uploadRef.current.start();
      setState(previous => ({ ...previous, status: 'uploading', error: null }));
    }
  }, [confirm]);

  const cancel = useCallback(async (): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    setState(previous => ({ ...previous, status: 'cancelling', error: null }));
    try {
      try {
        await uploadRef.current?.abort(true);
      } catch (error) {
        const response = (error as { originalResponse?: { getStatus(): number } }).originalResponse;
        if (response?.getStatus() !== 404 && response?.getStatus() !== 410) throw error;
      }
      ++generation.current;
      removePending();
      uploadRef.current = null;
      requestRef.current = null;
      setMatches([]);
      setState({ progress: 0, status: 'idle', error: null });
      return true;
    } catch (error) {
      setState(previous => ({ ...previous, status: 'error', error: `取消失败，请重试：${error instanceof Error ? error.message : String(error)}` }));
      return false;
    } finally {
      busy.current = false;
    }
  }, [removePending]);

  const reset = useCallback(() => {
    ++generation.current;
    busy.current = false;
    setState({ progress: 0, status: 'idle', error: null });
    uploadRef.current = null;
    requestRef.current = null;
    setMatches([]);
    setPackId(null);
  }, []);

  return { ...state, matches, packId, startUpload, pause, resume, cancel, reset, continueUpload: () => confirm(true) };
}

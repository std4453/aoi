import { useState, useCallback, useRef } from 'react';
import * as tus from 'tus-js-client';
import { confirmUpload } from '../api/packs';

interface UploadState {
  progress: number;
  status: 'idle' | 'uploading' | 'paused' | 'error' | 'done';
  error: string | null;
}

export function useUpload() {
  const [state, setState] = useState<UploadState>({
    progress: 0,
    status: 'idle',
    error: null,
  });
  const uploadRef = useRef<tus.Upload | null>(null);
  const packNameRef = useRef<string>('');
  const archivePasswordRef = useRef<string | undefined>(undefined);
  const tagIdsRef = useRef<string[]>([]);
  const packIdRef = useRef<string | null>(null);
  const [packId, setPackId] = useState<string | null>(null);

  const startUpload = useCallback((file: File, packName: string, archivePassword?: string, tagIds?: string[]) => {
    packNameRef.current = packName || file.name.replace(/\.[^/.]+$/, '');
    archivePasswordRef.current = archivePassword;
    tagIdsRef.current = tagIds || [];
    packIdRef.current = null;
    setPackId(null);
    setState({ progress: 0, status: 'uploading', error: null });

    const upload = new tus.Upload(file, {
      endpoint: '/api/upload/files',
      chunkSize: Infinity,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      metadata: {
        filename: file.name,
        filetype: file.type || 'application/octet-stream',
      },
      onError: (err) => {
        setState((prev) => ({ ...prev, status: 'error', error: err.message }));
      },
      onSuccess: async () => {
        setState((prev) => ({ ...prev, progress: 100, status: 'done' }));
        try {
          const uploadId = upload.url?.split('/').pop() || '';
          const result = await confirmUpload({
            uploadId,
            filename: file.name,
            fileSize: file.size,
            packName: packNameRef.current,
            archivePassword: archivePasswordRef.current,
            tagIds: tagIdsRef.current,
          });
          packIdRef.current = result.id;
          setPackId(result.id);
          // Remove from localStorage
          const pending = JSON.parse(localStorage.getItem('pendingUploads') || '[]');
          localStorage.setItem(
            'pendingUploads',
            JSON.stringify(pending.filter((u: any) => u.filename !== file.name))
          );
        } catch (err) {
          setState((prev) => ({
            ...prev,
            status: 'error',
            error: `Upload succeeded but processing failed: ${err instanceof Error ? err.message : String(err)}`,
          }));
        }
      },
      onProgress: (bytesUploaded, bytesTotal) => {
        const pct = bytesTotal > 0 ? Math.round((bytesUploaded / bytesTotal) * 100) : 0;
        setState((prev) => ({ ...prev, progress: pct }));
      },
    });

    uploadRef.current = upload;
    upload.start();

    // Save for resume capability
    const pending = JSON.parse(localStorage.getItem('pendingUploads') || '[]');
    pending.push({
      filename: file.name,
      packName: packNameRef.current,
      size: file.size,
      createdAt: Date.now(),
    });
    localStorage.setItem('pendingUploads', JSON.stringify(pending));
  }, []);

  const pause = useCallback(() => {
    if (uploadRef.current) {
      uploadRef.current.abort();
      setState((prev) => ({ ...prev, status: 'paused' }));
    }
  }, []);

  const resume = useCallback(() => {
    if (uploadRef.current) {
      uploadRef.current.start();
      setState((prev) => ({ ...prev, status: 'uploading', error: null }));
    }
  }, []);

  const cancel = useCallback(() => {
    if (uploadRef.current) {
      uploadRef.current.abort();
      uploadRef.current = null;
    }
    setState({ progress: 0, status: 'idle', error: null });
  }, []);

  const reset = useCallback(() => {
    setState({ progress: 0, status: 'idle', error: null });
    uploadRef.current = null;
    setPackId(null);
    packIdRef.current = null;
  }, []);

  return { ...state, packId, startUpload, pause, resume, cancel, reset };
}

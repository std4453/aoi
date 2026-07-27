import { useState, useCallback, useRef } from 'react';
import * as tus from 'tus-js-client';
import { confirmUpload } from '../api/packs';

interface UploadState {
  progress: number;
  status: 'idle' | 'uploading' | 'paused' | 'confirming' | 'error' | 'done';
  error: string | null;
}

const UPLOAD_CHUNK_SIZE = 5 * 1024 * 1024;

interface PendingUpload {
  filename: string;
  packName: string;
  size: number;
  createdAt: number;
}

function readPendingUploads(): PendingUpload[] {
  try {
    const value = JSON.parse(localStorage.getItem('pendingUploads') || '[]');
    return Array.isArray(value) ? value : [];
  } catch {
    localStorage.removeItem('pendingUploads');
    return [];
  }
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
  const operationTokenRef = useRef(0);
  const [packId, setPackId] = useState<string | null>(null);

  const startUpload = useCallback((file: File, packName: string, archivePassword?: string, tagIds?: string[]) => {
    const operationToken = ++operationTokenRef.current;
    packNameRef.current = packName || file.name.replace(/\.[^/.]+$/, '');
    archivePasswordRef.current = archivePassword;
    tagIdsRef.current = tagIds || [];
    packIdRef.current = null;
    setPackId(null);
    setState({ progress: 0, status: 'uploading', error: null });

    const upload = new tus.Upload(file, {
      endpoint: '/api/upload/files',
      chunkSize: UPLOAD_CHUNK_SIZE,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      metadata: {
        filename: file.name,
        filetype: file.type || 'application/octet-stream',
      },
      onError: (err) => {
        if (operationToken !== operationTokenRef.current) return;
        setState((prev) => ({ ...prev, status: 'error', error: err.message }));
      },
      onSuccess: async () => {
        if (operationToken !== operationTokenRef.current) return;
        setState((prev) => ({ ...prev, progress: 100, status: 'confirming' }));
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
          if (operationToken !== operationTokenRef.current) return;
          packIdRef.current = result.id;
          setPackId(result.id);
          setState((prev) => ({ ...prev, status: 'done' }));
          // Remove from localStorage
          const pending = readPendingUploads();
          localStorage.setItem(
            'pendingUploads',
            JSON.stringify(pending.filter(upload => upload.filename !== file.name))
          );
        } catch (err) {
          if (operationToken !== operationTokenRef.current) return;
          setState((prev) => ({
            ...prev,
            status: 'error',
            error: `Upload succeeded but processing failed: ${err instanceof Error ? err.message : String(err)}`,
          }));
        }
      },
      onProgress: (bytesUploaded, bytesTotal) => {
        if (operationToken !== operationTokenRef.current) return;
        const pct = bytesTotal > 0 ? Math.round((bytesUploaded / bytesTotal) * 100) : 0;
        setState((prev) => ({ ...prev, progress: pct }));
      },
    });

    uploadRef.current = upload;
    upload.start();

    // Save for resume capability
    const pending = readPendingUploads();
    pending.push({
      filename: file.name,
      packName: packNameRef.current,
      size: file.size,
      createdAt: Date.now(),
    });
    localStorage.setItem('pendingUploads', JSON.stringify(pending));
  }, []);

  const pause = useCallback(async () => {
    if (uploadRef.current) {
      await uploadRef.current.abort();
      setState((prev) => ({ ...prev, status: 'paused' }));
    }
  }, []);

  const resume = useCallback(() => {
    if (uploadRef.current) {
      uploadRef.current.start();
      setState((prev) => ({ ...prev, status: 'uploading', error: null }));
    }
  }, []);

  const cancel = useCallback(async () => {
    operationTokenRef.current++;
    if (uploadRef.current) {
      await uploadRef.current.abort();
      uploadRef.current = null;
    }
    setState({ progress: 0, status: 'idle', error: null });
  }, []);

  const reset = useCallback(() => {
    operationTokenRef.current++;
    setState({ progress: 0, status: 'idle', error: null });
    uploadRef.current = null;
    setPackId(null);
    packIdRef.current = null;
  }, []);

  return { ...state, packId, startUpload, pause, resume, cancel, reset };
}

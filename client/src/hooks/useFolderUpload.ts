import { useState, useCallback, useRef } from 'react';
import * as tus from 'tus-js-client';
import { createFolderPack, confirmFolderFileComplete, cancelFolderUpload } from '../api/packs';

export interface FolderUploadFile {
  packFileId: string;
  relativePath: string;
  fileSize: number;
  status: 'pending' | 'uploading' | 'uploaded' | 'failed';
  progress: number;
}

interface FolderUploadState {
  phase: 'idle' | 'scanning' | 'ready' | 'uploading' | 'paused' | 'done' | 'error' | 'cancelled';
  packId: string | null;
  files: FolderUploadFile[];
  overallProgress: number;
  error: string | null;
}

const MAX_CONCURRENT = 3;

export function useFolderUpload() {
  const [state, setState] = useState<FolderUploadState>({
    phase: 'idle',
    packId: null,
    files: [],
    overallProgress: 0,
    error: null,
  });

  const uploadsRef = useRef<Map<string, tus.Upload>>(new Map());
  const fileQueueRef = useRef<string[]>([]); // packFileIds waiting to upload
  const activeCountRef = useRef(0);
  const packIdRef = useRef<string | null>(null);
  const fileMapRef = useRef<Map<string, { file: File; packFileId: string }>>(new Map());
  const pausedUploadsRef = useRef<Map<string, { file: File; packFileId: string }>>(new Map());
  const abortedPfIdsRef = useRef<Set<string>>(new Set()); // Track aborted uploads to ignore their callbacks

  const calculateOverallProgress = useCallback((files: FolderUploadFile[]): number => {
    const totalSize = files.reduce((sum, f) => sum + f.fileSize, 0);
    if (totalSize === 0) return 0;
    const uploaded = files.reduce((sum, f) => sum + (f.fileSize * f.progress / 100), 0);
    return Math.round(uploaded / totalSize * 100);
  }, []);

  const startNextInQueue = useCallback(() => {
    if (activeCountRef.current >= MAX_CONCURRENT) return;
    if (fileQueueRef.current.length === 0) return;
    // Don't start new uploads if paused or not in uploading phase
    if (abortedPfIdsRef.current.size > 0) return;

    const packFileId = fileQueueRef.current.shift()!;
    const mapping = fileMapRef.current.get(packFileId);
    if (!mapping) return;

    const { file, packFileId: pfId } = mapping;
    const pid = packIdRef.current;
    if (!pid) return;

    activeCountRef.current++;

    const upload = new tus.Upload(file, {
      endpoint: '/api/upload/files',
      chunkSize: Infinity,
      retryDelays: [0, 1000, 3000, 5000],
      metadata: {
        filename: file.name,
        filetype: file.type || 'application/octet-stream',
      },
      onError: (_err) => {
        // If this upload was aborted due to pause, ignore the callback
        if (abortedPfIdsRef.current.has(pfId)) {
          abortedPfIdsRef.current.delete(pfId);
          return;
        }
        activeCountRef.current--;
        uploadsRef.current.delete(pfId);
        setState(prev => {
          const newFiles = prev.files.map(f =>
            f.packFileId === pfId ? { ...f, status: 'failed' as const, progress: 0 } : f
          );
          return {
            ...prev,
            files: newFiles,
            overallProgress: calculateOverallProgress(newFiles),
          };
        });
        // Try next in queue
        startNextInQueue();
      },
      onSuccess: async () => {
        // If this upload was aborted due to pause, ignore the callback
        if (abortedPfIdsRef.current.has(pfId)) {
          abortedPfIdsRef.current.delete(pfId);
          return;
        }
        activeCountRef.current--;
        uploadsRef.current.delete(pfId);

        try {
          const uploadId = upload.url?.split('/').pop() || '';
          const result = await confirmFolderFileComplete(pid, { packFileId: pfId, uploadId });
          void result;

          setState(prev => {
            const newFiles = prev.files.map(f =>
              f.packFileId === pfId ? { ...f, status: 'uploaded' as const, progress: 100 } : f
            );
            const allComplete = newFiles.every(f => f.status === 'uploaded');
            return {
              ...prev,
              files: newFiles,
              overallProgress: calculateOverallProgress(newFiles),
              phase: allComplete ? 'done' : prev.phase,
            };
          });
        } catch (err) {
          setState(prev => {
            const newFiles = prev.files.map(f =>
              f.packFileId === pfId ? { ...f, status: 'failed' as const } : f
            );
            return {
              ...prev,
              files: newFiles,
              overallProgress: calculateOverallProgress(newFiles),
              error: `文件 ${file.name} 确认失败: ${err instanceof Error ? err.message : String(err)}`,
            };
          });
        }

        // Try next in queue
        startNextInQueue();
      },
      onProgress: (bytesUploaded, bytesTotal) => {
        const pct = bytesTotal > 0 ? Math.round((bytesUploaded / bytesTotal) * 100) : 0;
        setState(prev => {
          const newFiles = prev.files.map(f =>
            f.packFileId === pfId ? { ...f, progress: pct } : f
          );
          return {
            ...prev,
            files: newFiles,
            overallProgress: calculateOverallProgress(newFiles),
          };
        });
      },
    });

    uploadsRef.current.set(pfId, upload);
    upload.start();

    setState(prev => ({
      ...prev,
      files: prev.files.map(f =>
        f.packFileId === pfId ? { ...f, status: 'uploading' as const } : f
      ),
    }));
  }, [calculateOverallProgress]);

  const scanFiles = useCallback((fileList: FileList) => {
    setState(prev => ({ ...prev, phase: 'scanning' }));

    const files: { relativePath: string; fileSize: number }[] = [];
    const uploadFiles: FolderUploadFile[] = [];
    let totalSize = 0;

    for (let i = 0; i < fileList.length; i++) {
      const file = fileList[i];
      const relativePath = file.webkitRelativePath || file.name;
      files.push({ relativePath, fileSize: file.size });
      uploadFiles.push({
        packFileId: '', // Will be assigned after API call
        relativePath,
        fileSize: file.size,
        status: 'pending',
        progress: 0,
      });
      totalSize += file.size;
    }

    // Store the actual File objects for later upload
    const fileObjects: File[] = [];
    for (let i = 0; i < fileList.length; i++) {
      fileObjects.push(fileList[i]);
    }

    setState(prev => ({
      ...prev,
      phase: 'ready',
      files: uploadFiles,
      overallProgress: 0,
      error: null,
    }));

    return { scanFiles: files, fileObjects, totalSize };
  }, []);

  const startUpload = useCallback(async (
    packName: string,
    scanResult: { scanFiles: { relativePath: string; fileSize: number }[]; fileObjects: File[] },
    tagIds?: string[]
  ) => {
    try {
      const result = await createFolderPack({
        packName,
        files: scanResult.scanFiles,
        tagIds,
      });

      packIdRef.current = result.id;

      // Map packFileIds to file objects
      const fileMap = new Map<string, { file: File; packFileId: string }>();
      const newFiles: FolderUploadFile[] = result.packFiles.map((pf, i) => {
        const fileObj = scanResult.fileObjects[i];
        fileMap.set(pf.id, { file: fileObj, packFileId: pf.id });
        return {
          packFileId: pf.id,
          relativePath: pf.relativePath,
          fileSize: pf.fileSize,
          status: 'pending' as const,
          progress: 0,
        };
      });

      fileMapRef.current = fileMap;
      fileQueueRef.current = result.packFiles.map(pf => pf.id);
      activeCountRef.current = 0;
      uploadsRef.current.clear();

      setState(prev => ({
        ...prev,
        phase: 'uploading',
        packId: result.id,
        files: newFiles,
        overallProgress: 0,
      }));

      // Start initial batch
      for (let i = 0; i < Math.min(MAX_CONCURRENT, fileQueueRef.current.length); i++) {
        startNextInQueue();
      }
    } catch (err) {
      setState(prev => ({
        ...prev,
        phase: 'error',
        error: err instanceof Error ? err.message : String(err),
      }));
    }
  }, [startNextInQueue]);

  const pause = useCallback(() => {
    // Abort all active uploads and save their info for resume
    pausedUploadsRef.current.clear();
    abortedPfIdsRef.current.clear();
    for (const [pfId, upload] of uploadsRef.current) {
      abortedPfIdsRef.current.add(pfId);
      upload.abort();
      const mapping = fileMapRef.current.get(pfId);
      if (mapping) {
        pausedUploadsRef.current.set(pfId, mapping);
      }
    }
    uploadsRef.current.clear();
    activeCountRef.current = 0;

    setState(prev => ({ ...prev, phase: 'paused' }));
  }, []);

  const resume = useCallback(() => {
    abortedPfIdsRef.current.clear();
    setState(prev => ({ ...prev, phase: 'uploading', error: null }));

    // Re-enqueue paused files
    for (const [pfId] of pausedUploadsRef.current) {
      fileQueueRef.current.unshift(pfId);
    }
    pausedUploadsRef.current.clear();

    // Restart uploads
    for (let i = 0; i < Math.min(MAX_CONCURRENT, fileQueueRef.current.length); i++) {
      startNextInQueue();
    }
  }, [startNextInQueue]);

  const cancel = useCallback(async () => {
    // Abort all active tus uploads
    abortedPfIdsRef.current.clear();
    for (const upload of uploadsRef.current.values()) {
      upload.abort();
    }
    uploadsRef.current.clear();
    activeCountRef.current = 0;
    fileQueueRef.current = [];
    pausedUploadsRef.current.clear();

    const pid = packIdRef.current;
    if (pid) {
      try {
        await cancelFolderUpload(pid);
      } catch (err) {
        console.error('Failed to cancel folder upload on server:', err);
      }
    }

    setState({
      phase: 'idle',
      packId: null,
      files: [],
      overallProgress: 0,
      error: null,
    });
    packIdRef.current = null;
    fileMapRef.current.clear();
  }, []);

  const reset = useCallback(() => {
    setState({
      phase: 'idle',
      packId: null,
      files: [],
      overallProgress: 0,
      error: null,
    });
    uploadsRef.current.clear();
    fileQueueRef.current = [];
    activeCountRef.current = 0;
    packIdRef.current = null;
    fileMapRef.current.clear();
    pausedUploadsRef.current.clear();
    abortedPfIdsRef.current.clear();
  }, []);

  return {
    ...state,
    scanFiles,
    startUpload,
    pause,
    resume,
    cancel,
    reset,
  };
}

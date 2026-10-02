import { apiUrl, authHeaders } from '../lib/connection';
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
  phase: 'idle' | 'scanning' | 'ready' | 'uploading' | 'paused' | 'error' | 'creating' | 'transferred' | 'cancelling';
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

  const generation = useRef(0);
  const busy = useRef(false);
  const allUploadsRef = useRef(new Map<string, tus.Upload>());
  const failedIdsRef = useRef(new Set<string>());
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
    const attempt = generation.current;
    const pid = packIdRef.current;
    if (!pid) return;

    activeCountRef.current++;

    const upload = new tus.Upload(file, {
      endpoint: apiUrl('/api/upload/files'),
      headers: authHeaders(),
      chunkSize: Infinity,
      retryDelays: [0, 1000, 3000, 5000],
      metadata: {
        filename: file.name,
        filetype: file.type || 'application/octet-stream',
      },
      onError: (_err) => {
        if (attempt !== generation.current) return;
        failedIdsRef.current.add(pfId);
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
            error: `文件 ${file.name} 上传失败：${_err.message}。可重试失败文件，或取消并删除任务。`,
          };
        });
        // Try next in queue
        startNextInQueue();
      },
      onSuccess: async () => {
        if (attempt !== generation.current) return;
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
          if (attempt !== generation.current) return;
          allUploadsRef.current.delete(pfId);
          failedIdsRef.current.delete(pfId);

          setState(prev => {
            const newFiles = prev.files.map(f =>
              f.packFileId === pfId ? { ...f, status: 'uploaded' as const, progress: 100 } : f
            );
            const allComplete = newFiles.every(f => f.status === 'uploaded');
            return {
              ...prev,
              files: newFiles,
              overallProgress: calculateOverallProgress(newFiles),
              phase: (allComplete || result.allComplete) ? 'transferred' : prev.phase,
            };
          });
        } catch (err) {
          if (attempt !== generation.current) return;
          failedIdsRef.current.add(pfId);
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
        if (attempt !== generation.current) return;
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
    allUploadsRef.current.set(pfId, upload);
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
    if (busy.current) return;
    busy.current = true;
    const attempt = ++generation.current;
    setState(previous => ({ ...previous, phase: 'creating', error: null }));
    failedIdsRef.current.clear();
    allUploadsRef.current.clear();
    try {
      const result = await createFolderPack({
        packName,
        files: scanResult.scanFiles,
        tagIds,
      });

      if (attempt !== generation.current) {
        await cancelFolderUpload(result.id);
        return;
      }
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
      if (attempt === generation.current) setState(prev => ({
        ...prev,
        phase: 'error',
        error: err instanceof Error ? err.message : String(err),
      }));
    } finally {
      if (attempt === generation.current) busy.current = false;
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

  const cancel = useCallback(async (): Promise<boolean> => {
    if (busy.current) return false;
    busy.current = true;
    ++generation.current;
    setState(previous => ({ ...previous, phase: 'cancelling', error: null }));
    fileQueueRef.current = [];
    pausedUploadsRef.current.clear();
    activeCountRef.current = 0;
    try {
      // Terminate even uploads whose completion confirmation is still in flight.
      await Promise.all([...allUploadsRef.current.values()].map(async upload => {
        try { await upload.abort(true); } catch (error) {
          const response = (error as { originalResponse?: { getStatus(): number } }).originalResponse;
          if (![404, 410].includes(response?.getStatus() ?? 0)) throw error;
        }
      }));
      if (packIdRef.current) await cancelFolderUpload(packIdRef.current);
      uploadsRef.current.clear();
      allUploadsRef.current.clear();
      fileMapRef.current.clear();
      packIdRef.current = null;
      setState({ phase: 'idle', packId: null, files: [], overallProgress: 0, error: null });
      return true;
    } catch (error) {
      setState(previous => ({ ...previous, phase: 'error', error: `取消失败，请重试：${error instanceof Error ? error.message : String(error)}` }));
      return false;
    } finally {
      busy.current = false;
    }
  }, []);

  const reset = useCallback(() => {
    ++generation.current;
    busy.current = false;
    setState({ phase: 'idle', packId: null, files: [], overallProgress: 0, error: null });
    uploadsRef.current.clear();
    allUploadsRef.current.clear();
    activeCountRef.current = 0;
    fileQueueRef.current = [];
    packIdRef.current = null;
    fileMapRef.current.clear();
    pausedUploadsRef.current.clear();
    abortedPfIdsRef.current.clear();
    failedIdsRef.current.clear();
  }, []);

  // Once transferred, UploadTask exclusively owns processing, duplicate checks and retries.
  const retry = useCallback(() => {
    if (!fileMapRef.current.size) return;
    for (const id of failedIdsRef.current) if (!fileQueueRef.current.includes(id)) fileQueueRef.current.push(id);
    failedIdsRef.current.clear();
    resume();
  }, [resume]);

  return { ...state, scanFiles, startUpload, pause, resume, cancel, reset, retry };
}

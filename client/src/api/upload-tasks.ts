import type { UploadTask, CreateUploadTaskRequest } from '../../../shared/types';
import { del, get, patch, post } from './client';

export interface UploadTaskUpdate {
  uploadId?: string;
  packId?: string;
  progress?: number;
  transferredBytes?: number;
  status?: 'uploading' | 'paused' | 'needs_file' | 'failed';
  error?: string | null;
  errorCode?: UploadTask['errorCode'];
}

export const fetchUploadTasks = () => get<UploadTask[]>('/upload-tasks');
export const createUploadTask = (data: CreateUploadTaskRequest) => post<UploadTask>('/upload-tasks', data);
export const updateUploadTask = (id: string, data: UploadTaskUpdate) => patch<UploadTask>(`/upload-tasks/${id}`, data);
export const completeUploadTask = (id: string, data: { uploadId: string; archivePassword?: string }) =>
  post<UploadTask>(`/upload-tasks/${id}/complete`, data);
export const retryUploadTask = (id: string, data: { archivePassword?: string; sharePassword?: string } = {}) =>
  post<UploadTask>(`/upload-tasks/${id}/retry`, data);
export const continueUploadTask = (id: string) => post<UploadTask>(`/upload-tasks/${id}/continue`, {});
export const deleteUploadTask = (id: string) => del<{ ok: boolean }>(`/upload-tasks/${id}`);

import { activeServer } from './connection';

const key = () => `activeUploadTask:${activeServer?.id || 'local'}`;
export function readUploadTask(): string | null { return localStorage.getItem(key()); }
export function rememberUploadTask(id: string): void { localStorage.setItem(key(), id); }
export function forgetUploadTask(): void { localStorage.removeItem(key()); }

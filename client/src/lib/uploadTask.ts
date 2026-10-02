import { activeServer } from './connection';

const tasks = new Map<string, string>();
const key = () => activeServer?.id || 'local';
export function readUploadTask(): string | null { return tasks.get(key()) ?? null; }
export function rememberUploadTask(id: string): void { tasks.set(key(), id); }
export function forgetUploadTask(id?: string): void {
  if (!id || tasks.get(key()) === id) tasks.delete(key());
}

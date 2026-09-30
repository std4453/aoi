import { AsyncLocalStorage } from 'node:async_hooks';
import type Database from 'better-sqlite3';

export interface ReadGeneration {
  id: string;
  root: string;
  db: Database.Database;
  readers: number;
  retired: boolean;
}
export const readContext = new AsyncLocalStorage<ReadGeneration>();
let current: ReadGeneration | undefined;
export const currentGeneration = () => current;
export function activateGeneration(next: ReadGeneration): void {
  const old = current;
  current = next;
  if (old) {
    old.retired = true;
    if (!old.readers) old.db.close();
  }
}
export function releaseGeneration(generation: ReadGeneration): void {
  generation.readers--;
  if (generation.retired && !generation.readers) generation.db.close();
}
export function closeGenerations(): void {
  if (current?.db.open) current.db.close();
  current = undefined;
}

// Optimistic snapshot fence: writers never wait for the exporter. A concurrent
// write invalidates its candidate instead. Job and request lifetimes both count.
let revision = 0;
let writers = 0;
export function beginMutation(): () => void {
  revision++;
  writers++;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    writers--;
    revision++;
  };
}
export function snapshotFence(): number {
  if (writers) throw new Error('Snapshot deferred: business writes are in progress');
  return revision;
}
export function assertSnapshotFence(expected: number): void {
  if (writers || revision !== expected) throw new Error('Snapshot deferred: data changed during export');
}

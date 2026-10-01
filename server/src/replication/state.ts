import { AsyncLocalStorage } from 'node:async_hooks';
import type { StoredPack } from '../db/repositories.js';

export interface ReadVersion {
  id: string;
  root: string;
  pack: StoredPack;
  readers: number;
}
export const readContext = new AsyncLocalStorage<ReadVersion>();
const active = new Map<string, ReadVersion>();
const reading = new Set<ReadVersion>();
export const getActiveVersion = (packId: string) => active.get(packId);
export function activateVersion(version: ReadVersion): void { active.delete(version.pack.id); active.set(version.pack.id, version); }
export function activePacks(): StoredPack[] { return [...active.values()].map(version => version.pack); }
export function removeVersion(packId: string): void { active.delete(packId); }
export function pinVersion(version: ReadVersion): () => void {
  version.readers++;
  reading.add(version);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--version.readers === 0) reading.delete(version);
  };
}
export function referencedRoots(): Set<string> {
  return new Set([...active.values(), ...reading].map(version => version.root));
}
export function clearVersions(): void { active.clear(); }

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

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

import { isRemoteSource } from '~/task-errors';
import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { createUploadTaskStore } from '../../client/src/features/uploads/task-store';
import { createLocalUploadExecutor, type UploadTransfer } from '../../client/src/features/uploads/local-upload';
import { createUploadDraft } from '../../client/src/features/uploads/draft';
import { createUploadViewState, TASK_EXIT_MS } from '../../client/src/features/uploads/view-state';
import type { UploadTask, PackFile, PixivMetadata } from '~/types';

type UploadOptions = Parameters<NonNullable<Parameters<typeof createLocalUploadExecutor>[1]>['createTransfer']>[1];

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
const base: UploadTask = { id: 'task', source: 'archive', isRemote: false, errorCode: null, errorCategory: null, name: 'test', filename: 'test.zip', totalBytes: 4, transferredBytes: 0,
  progress: 0, status: 'uploading', packId: null, uploadId: null, matches: [], error: null, createdAt: '', updatedAt: '' };
function harness() {
  let saved: UploadTask[] = [];
  const transfers: Array<UploadTransfer & { options: UploadOptions; starts: number; aborts: boolean[] }> = [];
  const writes: string[] = [];
  let packFiles: PackFile[] = [];
  let confirm = async () => ({ allComplete: true });
  let beforeWrite = async () => {};
  let complete = async () => { saved = saved.map(task => ({ ...task, status: 'processing' })); return saved[0]; };
  let remove = async () => { saved = []; return { ok: true }; };
  let fetchTasks = async () => saved.map(task => ({ ...task }));
  const store = createUploadTaskStore({ writable: () => true, invalidatePacks: () => {},
    api: {
      fetchUploadTasks: () => fetchTasks(),
      createUploadTask: async input => { const task = { ...base, source: input.source, isRemote: isRemoteSource(input.source) }; saved = [task]; return task; },
      updateUploadTask: async (id, patch) => { writes.push(patch.status ?? 'progress'); await beforeWrite(); saved = saved.map(t => t.id === id ? { ...t, ...patch } : t); return saved[0]; },
      completeUploadTask: () => complete(), deleteUploadTask: () => remove(),
      continueUploadTask: async () => saved[0], retryUploadTask: async () => saved[0],
    },
    createExecutor: report => createLocalUploadExecutor(report, {
      apiUrl: path => path, authHeaders: () => ({}),
      createTransfer: (_file, options) => {
        const transfer = { url: '/files/upload', options, starts: 0, aborts: [] as boolean[], start() { this.starts++; }, async abort(terminate = false) { this.aborts.push(terminate); } };
        transfers.push(transfer); return transfer;
      },
      createFolderPack: async () => ({ id: 'pack', packFiles }),
      fetchFolderUploadStatus: async () => ({ packFiles }),
      confirmFolderFileComplete: () => confirm(),
    }),
  });
  return { store, transfers, writes, setComplete: (fn: typeof complete) => { complete = fn; }, setRemove: (fn: typeof remove) => { remove = fn; },
    setFetch: (fn: typeof fetchTasks) => { fetchTasks = fn; }, setSaved: (tasks: UploadTask[]) => { saved = tasks; },
    setPackFiles: (files: PackFile[]) => { packFiles = files; }, setConfirm: (fn: typeof confirm) => { confirm = fn; },
    setBeforeWrite: (fn: typeof beforeWrite) => { beforeWrite = fn; } };
}
const local = () => ({ files: [new File(['test'], 'test.zip')], tagIds: [] });
const create = async (h: ReturnType<typeof harness>) => { await h.store.create({ source: 'archive', name: 'test' }, local()); await tick(); };

test('draft edits never notify task subscribers and source defaults stay with the draft', async t => {
  const h = harness(); t.after(() => h.store.dispose());
  const draft = createUploadDraft(); t.after(() => draft.dispose());
  let notifications = 0; h.store.subscribe(() => { notifications++; });
  const before = h.store.getSnapshot();
  draft.setDraft({ source: 'pixiv', url: 'https://www.pixiv.net/artworks/123' });
  draft.setDraft({ name: 'Edited', tagIds: [] });
  let input: unknown;
  await draft.submit(async value => { input = value; return { ...base, source: 'pixiv', isRemote: true }; });
  assert.equal(notifications, 0); assert.equal(h.store.getSnapshot(), before);
  assert.deepEqual(input, { source: 'pixiv', name: 'Edited', autoName: false, filename: undefined, fileSize: 0, tagIds: [],
    url: 'https://www.pixiv.net/artworks/123', sharePassword: undefined, archivePassword: undefined });
});

test('metadata debounce ignores stale sources and preserves manual names and tags', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const response = deferred<PixivMetadata>();
  const requested: string[] = [];
  const draft = createUploadDraft({
    fetchPixivMetadata: async url => { requested.push(url); return response.promise; },
    fetchMegaMetadata: async () => ({ title: 'MEGA title', filename: 'mega.zip', kind: 'archive', totalBytes: 4 }),
  }); t.after(() => draft.dispose());
  draft.setDraft({ source: 'pixiv', url: 'https://www.pixiv.net/artworks/123' });
  draft.setDraft({ url: 'https://www.pixiv.net/artworks/124' });
  t.mock.timers.tick(500); await tick();
  assert.deepEqual(requested, ['https://www.pixiv.net/artworks/124']);
  draft.setDraft({ source: 'mega', url: 'https://mega.nz/file/test#key' });
  response.resolve({ title: 'Stale title', author: 'author', mediaType: 'image', tags: [{ id: 'old', name: 'old' }] });
  await tick(); assert.equal(draft.getSnapshot().draft.name, '');
  t.mock.timers.tick(500); await tick();
  assert.equal(draft.getSnapshot().draft.name, 'MEGA title');
  draft.setDraft({ source: 'pixiv', url: 'https://www.pixiv.net/artworks/125' });
  draft.setDraft({ name: 'Manual title', tagIds: ['manual'] });
  t.mock.timers.tick(500); await tick();
  assert.equal(draft.getSnapshot().draft.name, 'Manual title');
  assert.deepEqual(draft.getSnapshot().draft.tagIds, ['manual']);
  draft.resetDraft();
  draft.setDraft({ source: 'pixiv', url: 'https://www.pixiv.net/artworks/126' });
  let input: unknown;
  await draft.submit(async value => { input = value; return base; });
  assert.equal((input as { tagIds?: string[] }).tagIds, undefined, 'early submit keeps server auto-tagging enabled');
  t.mock.timers.tick(500); await tick();
  assert.equal(draft.getSnapshot().draft.source, null, 'late metadata must not refill a submitted form');
});

test('pause and resume writes cannot overtake an in-flight status save', async t => {
  const h = harness(); t.after(() => h.store.dispose()); await create(h);
  const writing = deferred<void>(); h.setBeforeWrite(() => writing.promise);
  const pausing = h.store.pause('task'); await tick();
  const resuming = h.store.resume('task'); await tick();
  assert.deepEqual(h.writes, ['uploading', 'paused']);
  writing.resolve(); await Promise.all([pausing, resuming]);
  assert.deepEqual(h.writes, ['uploading', 'paused', 'uploading']);
  assert.equal(h.transfers[0].starts, 2);
});

test('folder reselection resumes missing files with three transfers and protects confirmation during pause', async t => {
  const h = harness(); t.after(() => h.store.dispose());
  const files = Array.from({ length: 5 }, (_, i) => new File(['test'], `${i}.png`));
  const packFiles: PackFile[] = files.map((file, i) => ({ id: `file-${i}`, packId: 'pack', relativePath: file.name,
    fileSize: file.size, status: i === 0 ? 'uploaded' : 'pending', uploadId: null, createdAt: '', uploadedAt: null }));
  h.setPackFiles(packFiles); h.setSaved([{ ...base, source: 'folder', packId: 'pack', totalBytes: 20 }]);
  await h.store.refresh();
  assert.equal(h.store.getSnapshot().tasks[0].status, 'needs_file');
  await h.store.reselect('task', files.slice(1));
  assert.equal(h.transfers.length, 0);
  await h.store.reselect('task', files);
  assert.equal(h.transfers.length, 3);
  assert.equal(h.store.getSnapshot().files.task[0].status, 'uploaded');
  const confirmation = deferred<{ allComplete: boolean }>(); h.setConfirm(() => confirmation.promise);
  h.transfers[0].options.onSuccess?.({ lastResponse: {} } as never); await tick();
  await h.store.pause('task');
  assert.deepEqual(h.transfers.map(upload => upload.aborts.length), [0, 1, 1]);
  confirmation.resolve({ allComplete: false }); await tick();
  assert.equal(h.transfers.length, 3, 'paused confirmation must not start the next file');
  await h.store.resume('task');
  assert.equal(h.transfers.length, 4);
  assert.deepEqual(h.transfers.map(upload => upload.starts), [1, 2, 2, 1]);
});

test('deleting a folder while confirming a file cannot schedule or republish late progress', async t => {
  const h = harness(); t.after(() => h.store.dispose());
  const files = Array.from({ length: 4 }, (_, i) => new File(['test'], `${i}.png`));
  h.setPackFiles(files.map((file, i) => ({ id: `file-${i}`, packId: 'pack', relativePath: file.name,
    fileSize: file.size, status: 'pending', uploadId: null, createdAt: '', uploadedAt: null })));
  await h.store.create({ source: 'folder', name: 'folder' }, { files, tagIds: [] }); await tick();
  const confirmation = deferred<{ allComplete: boolean }>(); h.setConfirm(() => confirmation.promise);
  h.transfers[0].options.onSuccess?.({ lastResponse: {} } as never); await tick();
  await h.store.dismiss('task');
  confirmation.resolve({ allComplete: false }); await tick();
  assert.equal(h.transfers.length, 3);
  assert.deepEqual(h.store.getSnapshot().tasks, []);
  assert.deepEqual(h.store.getSnapshot().files, {});
});

test('unsubscribing across tabs keeps transfer, pause/resume and serial persistence alive', async t => {
  const h = harness(); t.after(() => h.store.dispose());
  const unsubscribe = h.store.subscribe(() => {});
  await create(h); assert.equal(h.transfers.length, 1);
  unsubscribe();
  h.transfers[0].options.onProgress?.(2, 4);
  assert.equal(h.store.getSnapshot().tasks[0].progress, 50);
  await h.store.pause('task');
  assert.equal(h.store.getSnapshot().tasks[0].status, 'paused');
  await h.store.resume('task');
  assert.equal(h.transfers[0].starts, 2);
  assert.deepEqual(h.writes.slice(0, 3), ['uploading', 'paused', 'uploading']);
  let observed = 0; const stop = h.store.subscribe(() => { observed++; });
  h.transfers[0].options.onProgress?.(3, 4); assert.ok(observed > 0); stop();
});

test('refresh without file access needs reselection, preserving server processing', async t => {
  const h = harness(); t.after(() => h.store.dispose());
  h.setSaved([{ ...base, uploadId: 'resumable' }]); await h.store.refresh();
  assert.equal(h.store.getSnapshot().tasks[0].status, 'needs_file');
  await h.store.reselect('task', [new File(['bad'], 'other.zip')]);
  assert.equal(h.transfers.length, 0);
  assert.equal(h.store.getSnapshot().tasks[0].status, 'needs_file');
  await h.store.reselect('task', local().files);
  assert.equal(h.transfers[0].options.uploadUrl, '/api/upload/files/resumable');
  h.setSaved([{ ...base, status: 'processing', processing: { stage: 'verifying', queued: false, completed: 1, total: 2 } }]);
  await h.store.refresh(); assert.equal(h.store.getSnapshot().tasks[0].status, 'processing');
  assert.equal(h.store.hasLocalFiles('task'), false);
});

test('late handoff and stale refresh cannot resurrect a deleted task', async t => {
  const h = harness(); t.after(() => h.store.dispose()); await create(h);
  const handoff = deferred<UploadTask>(); h.setComplete(() => handoff.promise);
  h.transfers[0].options.onSuccess?.({ lastResponse: {} } as never); await tick();
  assert.equal(h.store.getSnapshot().tasks[0].status, 'processing');
  const fetched = deferred<UploadTask[]>(); h.setFetch(() => fetched.promise);
  const refreshing = h.store.refresh();
  await h.store.dismiss('task');
  handoff.resolve({ ...base, status: 'completed', packId: 'pack' });
  fetched.resolve([{ ...base }]); await refreshing; await tick();
  assert.deepEqual(h.store.getSnapshot().tasks, []);
  assert.deepEqual(h.store.getSnapshot().files, {});
  assert.ok(h.transfers[0].aborts.includes(true));
});

test('failed deletion restores a paused resumable transfer; successful deletion exits only in view state', async t => {
  const h = harness(); const view = createUploadViewState(); t.after(() => { h.store.dispose(); view.dispose(); });
  h.store.onRemoved(view.removed); await create(h); view.expand('task');
  h.setRemove(async () => { throw new Error('delete failed'); });
  await assert.rejects(h.store.dismiss('task'), /delete failed/);
  assert.equal(h.store.getSnapshot().tasks[0].status, 'paused');
  assert.equal(view.getSnapshot().exitingIds.size, 0);
  await h.store.resume('task'); assert.equal(h.transfers[0].starts, 2);
  h.setRemove(async () => ({ ok: true })); await h.store.dismiss('task');
  assert.equal(h.store.getSnapshot().tasks.length, 0);
  assert.equal(view.getSnapshot().retainedTasks[0].id, 'task');
  await new Promise(resolve => setTimeout(resolve, TASK_EXIT_MS + 10));
  assert.equal(view.getSnapshot().expandedId, null); assert.equal(view.getSnapshot().retainedTasks.length, 0);
});

test('pack reveal waits for task loading and is consumed once without filtering the list', () => {
  const view = createUploadViewState();
  view.requestReveal('pack'); view.resolveReveal([], true);
  assert.deepEqual(view.getSnapshot().reveal, { packId: 'pack' });
  view.resolveReveal([{ ...base, packId: 'pack' }], false);
  assert.equal(view.getSnapshot().expandedId, 'task'); assert.equal(view.getSnapshot().reveal, null);
  view.expand(null); view.resolveReveal([{ ...base, packId: 'pack' }], false);
  assert.equal(view.getSnapshot().expandedId, null);
  view.requestReveal('missing'); view.resolveReveal([base], false);
  assert.equal(view.getSnapshot().reveal, null); view.dispose();
});

test('FANBOX drafts resolve metadata and preserve explicit title/tags through server task creation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const draft = createUploadDraft({ fetchFanboxMetadata: async () => ({
    title: 'Post title', author: 'Author', tags: [{ id: 'author', name: 'Author' }], imageCount: 1, videoCount: 1, skippedCount: 2,
  }) });
  t.after(() => draft.dispose());
  draft.setDraft({ source: 'fanbox', url: 'https://sample.fanbox.cc/posts/123' });
  t.mock.timers.tick(500); await tick();
  assert.equal(draft.getSnapshot().draft.name, 'Post title');
  assert.deepEqual(draft.getSnapshot().draft.tagIds, ['author']);
  draft.setDraft({ name: 'Manual', tagIds: [] });
  let input: unknown;
  await draft.submit(async value => { input = value; return { ...base, source: 'fanbox', isRemote: true, status: 'downloading' }; });
  assert.deepEqual(input, { source: 'fanbox', name: 'Manual', autoName: false, filename: undefined, fileSize: 0,
    tagIds: [], url: 'https://sample.fanbox.cc/posts/123', sharePassword: undefined, archivePassword: undefined });
  draft.setDraft({ source: 'fanbox', url: 'https://www.fanbox.cc/@sample/posts/456' });
  await draft.submit(async value => { input = value; return base; });
  assert.equal((input as { tagIds?: string[] }).tagIds, undefined);
  assert.equal((input as { name: string }).name, 'FANBOX 导入');
});

test('remote task flags prevent browser file transfers and drafts derive the flag on source changes', async t => {
  const h = harness(); t.after(() => h.store.dispose());
  for (const source of ['pixiv', 'fanbox', 'mega'] as const) {
    await h.store.create({ source, name: 'Remote' }, { files: [], tagIds: [] });
    await tick();
    assert.equal(h.store.getSnapshot().tasks[0].isRemote, true);
  }
  assert.equal(h.transfers.length, 0);
  const draft = createUploadDraft(); t.after(() => draft.dispose());
  draft.setDraft({ source: 'fanbox' });
  assert.equal(draft.getSnapshot().draft.isRemote, true);
  draft.setDraft({ source: 'folder' });
  assert.equal(draft.getSnapshot().draft.isRemote, false);
  draft.resetDraft();
  assert.equal(draft.getSnapshot().draft.isRemote, false);
});

test('MEGA adapter validates before fetching and forwards the changed share password', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const requested: Array<[string, string | undefined]> = [];
  const draft = createUploadDraft({ fetchMegaMetadata: async (url, password) => {
    requested.push([url, password]);
    return { title: 'MEGA title', filename: 'test.zip', kind: 'archive', totalBytes: 4 };
  } });
  t.after(() => draft.dispose());
  draft.setDraft({ source: 'mega', url: 'https://invalid.example/file/123', sharePassword: 'old' });
  t.mock.timers.tick(500); await tick();
  assert.equal(requested.length, 0);
  draft.setDraft({ url: ' https://mega.nz/file/test#key ' });
  draft.setDraft({ sharePassword: 'new' });
  t.mock.timers.tick(500); await tick();
  assert.deepEqual(requested, [['https://mega.nz/file/test#key', 'new']]);
  assert.equal(draft.getSnapshot().draft.name, 'MEGA title');
  draft.resetDraft();
  draft.setDraft({ source: 'mega', url: 'https://mega.nz/file/test#key' });
  await draft.submit(async input => {
    assert.equal(input.name, 'MEGA 导入');
    assert.deepEqual(input.tagIds, [], 'MEGA has no server auto-tagging');
    return base;
  });
});

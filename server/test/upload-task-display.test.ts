import assert from 'node:assert/strict';
import test from 'node:test';
import { taskErrorMessage, taskFailureLabel, taskProgressDisplay, taskStates, taskNoticeMessage } from '../../client/src/lib/upload-task-display.ts';
import type { UploadTask } from '../../shared/types.js';

const task: UploadTask = {
  id: 'test', source: 'archive', name: 'test', filename: 'test.zip',
  totalBytes: 100, transferredBytes: 100, progress: 100, status: 'failed',
  packId: 'pack', uploadId: 'upload', matches: [], error: null,
  createdAt: '', updatedAt: '',
};

test('all sources share status semantics without leaking transfer details into results', () => {
  for (const source of ['archive', 'folder', 'mega', 'pixiv'] as const) {
    for (const status of ['uploading', 'downloading', 'paused', 'processing', 'needs_file', 'password', 'duplicate', 'failed', 'completed'] as const) {
      const current = { ...task, source, status, error: 'stale transfer failure' };
      const state = taskStates[status];
      if (['needs_file', 'password', 'duplicate', 'failed'].includes(status)) {
        assert.equal(state.content, 'attention');
        assert.equal(state.tone, status === 'failed' ? 'error' : 'warning');
        assert.ok(taskNoticeMessage(current));
      } else {
        assert.equal(taskNoticeMessage(current), undefined);
        assert.equal(state.content, status === 'completed' ? 'result' : status === 'processing' ? 'processing' : 'transfer');
        assert.equal(state.tone, status === 'completed' ? 'success' : 'neutral');
      }
    }
  }
});

test('attention states have a useful notice even without an error from the server', () => {
  assert.match(taskNoticeMessage({ ...task, status: 'needs_file', source: 'folder' })!, /重新选择原来的文件夹.*已上传的内容会保留/);
  assert.match(taskNoticeMessage({ ...task, status: 'duplicate' })!, /确认是否继续/);
  assert.match(taskNoticeMessage({ ...task, status: 'password', passwordKind: 'share' })!, /分享.*解密密钥/);
  assert.match(taskNoticeMessage({ ...task, status: 'failed' })!, /重试/);
});

test('processing labels and counters replace finished transfer details for every source', () => {
  for (const source of ['archive', 'folder', 'mega', 'pixiv'] as const) {
    const processing = { ...task, source, status: 'processing' as const, progress: 25,
      processing: { stage: 'verifying' as const, queued: false, completed: 1024, total: 4096 } };
    assert.deepEqual(taskProgressDisplay(processing), {
      label: '正在校验与检测重复', detail: '已校验 1 KB / 4 KB', percentage: 25,
    });
    assert.deepEqual(taskProgressDisplay({ ...processing, progress: 50,
      processing: { stage: 'thumbnailing', queued: false, completed: 2, total: 4 } }), {
      label: '正在生成预览', detail: '2 / 4 个文件', percentage: 50,
    });
  }
});

test('queued and uncounted work never displays a fabricated zero percentage', () => {
  const processing = { ...task, status: 'processing' as const, progress: 0 };
  assert.deepEqual(taskProgressDisplay(processing), { label: '正在准备处理' });
  assert.deepEqual(taskProgressDisplay({ ...processing, processing: {
    stage: 'extracting', queued: false, completed: 0, total: 0,
  } }), { label: '正在解包' });
  assert.deepEqual(taskProgressDisplay({ ...processing, processing: {
    stage: 'thumbnailing', queued: true, completed: 4, total: 4,
  } }), { label: '等待生成预览' });
  assert.deepEqual(taskProgressDisplay({ ...processing, processing: {
    stage: 'thumbnailing', queued: false, completed: 0, total: 4,
  } }), { label: '正在生成预览', detail: '0 / 4 个文件', percentage: 0 });
  assert.deepEqual(taskProgressDisplay({ ...task, status: 'uploading', progress: 50, transferredBytes: 50 }), {
    label: '正在上传', detail: '50 B / 100 B', percentage: 50,
  });
});

test('saved archive diagnostics become a concise error without local paths', () => {
  const failed = { ...task, error: '无法检查压缩包内容: ERROR C:\\private\\archives\\original.zip Cannot open the file as [zip] archive ERRORS: Is not archive' };
  assert.equal(taskFailureLabel(failed), '解压失败');
  assert.equal(taskErrorMessage(failed), '压缩包已损坏或格式不正确，请检查文件后重新上传。');
  assert.doesNotMatch(taskErrorMessage(failed), /private|ERROR|original\.zip/);
});

test('failure stages use available evidence and unknown diagnostics stay private', () => {
  assert.equal(taskFailureLabel({ ...task, error: 'thumbnail failed' }), '预览生成失败');
  assert.equal(taskFailureLabel({ ...task, error: 'checksum mismatch' }), '校验失败');
  assert.equal(taskFailureLabel({ ...task, packId: null }), '上传失败');
  assert.equal(taskFailureLabel({ ...task, source: 'mega', packId: null }), '下载失败');
  assert.equal(taskFailureLabel(task), '处理失败');
  assert.doesNotMatch(taskErrorMessage({ ...task, error: 'secret stack trace /srv/private' }), /secret|stack|private/);
  assert.match(taskErrorMessage({ ...task, error: 'fetch failed ECONNRESET' }), /网络及代理/);
});

test('password prompts retain actionable information', () => {
  assert.match(taskErrorMessage({ ...task, status: 'password', passwordKind: 'share' }), /分享.*解密密钥/);
  assert.match(taskErrorMessage({ ...task, status: 'password', error: 'wrong password' }), /密码不正确/);
});

test('RAR method errors and entry names cannot masquerade as login failures', () => {
  const failed = { ...task, filename: 'test.rar', error: '7z 解压失败: ERROR: Unsupported Method : app/RefreshToken.php\nERROR: Unsupported Method : create_password_resets.php\nEncrypted = -' };
  assert.equal(taskFailureLabel(failed), '解压失败');
  assert.match(taskErrorMessage(failed), /解压工具不支持此压缩方法/);
  assert.doesNotMatch(taskErrorMessage(failed), /登录|需要密码|app\/|\.php/);
  assert.match(taskErrorMessage({ ...failed, error: '7z 解压失败: ERROR: CRC Failed : app/RefreshToken.php' }), /无法解压/);
  const listing = { ...failed, error: '无法检查压缩包内容: Path = app/RefreshToken.php\nPath = wrong password.png\nEncrypted = -\nChecksum = ' };
  assert.equal(taskFailureLabel(listing), '解压失败');
  assert.match(taskErrorMessage(listing), /无法解压/);
});

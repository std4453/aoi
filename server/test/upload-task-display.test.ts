import assert from 'node:assert/strict';
import test from 'node:test';
import { taskErrorMessage, taskFailureLabel, taskProgressDisplay, taskStates, taskNoticeMessage, taskNeedsLogin } from '../../client/src/features/uploads/task-display.ts';
import { taskErrorCategories } from '../../shared/task-errors.js';
import type { UploadTask } from '../../shared/types.js';

const task: UploadTask = {
  id: 'test', source: 'archive', isRemote: false, errorCode: null, errorCategory: null, name: 'test', filename: 'test.zip',
  totalBytes: 100, transferredBytes: 100, progress: 100, status: 'failed',
  packId: 'pack', uploadId: 'upload', matches: [], error: null,
  createdAt: '', updatedAt: '',
};

test('all sources share status semantics without leaking transfer details into results', () => {
  for (const source of ['archive', 'folder', 'mega', 'pixiv', 'fanbox'] as const) {
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
  for (const source of ['archive', 'folder', 'mega', 'pixiv', 'fanbox'] as const) {
    const processing = { ...task, source, status: 'processing' as const, progress: 25,
      processing: { stage: 'verifying' as const, queued: false, completed: 1024, total: 4096 } };
    assert.deepEqual(taskProgressDisplay(processing), {
      label: '校验中', detail: '已校验 1 KB / 4 KB', percentage: 25,
    });
    assert.deepEqual(taskProgressDisplay({ ...processing, progress: 50,
      processing: { stage: 'thumbnailing', queued: false, completed: 2, total: 4 } }), {
      label: '生成预览中', detail: '2 / 4 个文件', percentage: 50,
    });
  }
});

test('queued and uncounted work never displays a fabricated zero percentage', () => {
  const processing = { ...task, status: 'processing' as const, progress: 0 };
  assert.deepEqual(taskProgressDisplay(processing), { label: '准备中' });
  assert.deepEqual(taskProgressDisplay({ ...processing, processing: {
    stage: 'extracting', queued: false, completed: 0, total: 0,
  } }), { label: '解包中' });
  assert.deepEqual(taskProgressDisplay({ ...processing, processing: {
    stage: 'thumbnailing', queued: true, completed: 4, total: 4,
  } }), { label: '生成预览中' });
  assert.deepEqual(taskProgressDisplay({ ...processing, processing: {
    stage: 'thumbnailing', queued: false, completed: 0, total: 4,
  } }), { label: '生成预览中', detail: '0 / 4 个文件', percentage: 0 });
  assert.deepEqual(taskProgressDisplay({ ...task, status: 'uploading', progress: 50, transferredBytes: 50 }), {
    label: '上传中', detail: '50 B / 100 B', percentage: 50,
  });
});

test('queued stages share concise labels without exposing stale counters', () => {
  for (const stage of ['extracting', 'verifying', 'thumbnailing'] as const) {
    const running = { ...task, status: 'processing' as const, progress: 50,
      processing: { stage, queued: false, completed: 4, total: 8 } };
    const queued = { ...running, processing: { ...running.processing, queued: true } };
    const display = taskProgressDisplay(queued);
    assert.equal(display.label, taskProgressDisplay(running).label);
    assert.match(display.label, /中$/);
    assert.ok(display.label.length <= 5);
    assert.equal(display.percentage, undefined);
    assert.equal(display.detail, undefined);
    assert.equal(queued.processing.queued, true);
    assert.equal(taskProgressDisplay(running).percentage, 50);
  }
});

const failure = (errorCode: NonNullable<UploadTask['errorCode']>, patch: Partial<UploadTask> = {}): UploadTask => ({
  ...task, ...patch, errorCode, errorCategory: taskErrorCategories[errorCode],
});

test('stable error codes decide presentation even when diagnostics contain misleading filenames', () => {
  const invalid = failure('ARCHIVE_INVALID', { error: 'private/path/RefreshToken.php wrong password.png' });
  assert.equal(taskFailureLabel(invalid), '解压失败');
  assert.match(taskErrorMessage(invalid), /压缩包已损坏/);
  const unsupported = failure('ARCHIVE_UNSUPPORTED', { error: 'arbitrary third-party wording' });
  assert.match(taskErrorMessage(unsupported), /解压工具不支持此压缩方法/);
  assert.equal(taskNeedsLogin(unsupported), false);
  assert.equal(taskFailureLabel(failure('PREVIEW_FAILED')), '预览生成失败');
  assert.equal(taskFailureLabel(failure('VERIFICATION_FAILED')), '校验失败');
  assert.match(taskErrorMessage(failure('NETWORK_ERROR')), /网络及代理/);
  assert.doesNotMatch(taskErrorMessage(invalid), /private|RefreshToken|password.png/);
});

test('uncoded historical diagnostics remain private and do not infer login state', () => {
  const historical = { ...task, source: 'pixiv' as const, isRemote: true, error: '登录 private/RefreshToken.php' };
  assert.equal(taskNeedsLogin(historical), false);
  assert.doesNotMatch(taskErrorMessage(historical), /private|RefreshToken|登录/);
  assert.equal(taskFailureLabel({ ...task, packId: null }), '上传失败');
  assert.equal(taskFailureLabel({ ...historical, packId: null }), '下载失败');
});

test('password prompts use the explicit code and password kind', () => {
  assert.match(taskErrorMessage({ ...task, status: 'password', passwordKind: 'share' }), /分享.*解密密钥/);
  assert.match(taskErrorMessage(failure('PASSWORD_INCORRECT', { status: 'password' })), /密码不正确/);
});

test('FANBOX access, content and challenge failures have distinct actions', () => {
  const fanbox = { source: 'fanbox' as const, isRemote: true };
  assert.match(taskErrorMessage(failure('NO_SUPPORTED_MEDIA', fanbox)), /文字、压缩包及外部嵌入链接/);
  assert.equal(taskErrorMessage(failure('ACCESS_DENIED', fanbox)), 'FANBOX 帖子不可访问。');
  assert.equal(taskFailureLabel(failure('ACCESS_DENIED', fanbox)), '需要登录');
  assert.equal(taskFailureLabel(failure('AUTH_REQUIRED', { source: 'pixiv' })), '需要登录');
  for (const code of ['NETWORK_ERROR', 'SOURCE_BLOCKED', 'CHALLENGE_FAILED', 'RATE_LIMITED'] as const) {
    assert.equal(taskNeedsLogin(failure(code, fanbox)), false);
  }
  assert.equal(taskErrorMessage(failure('SOURCE_BLOCKED', fanbox)), 'FANBOX 拦截了服务器请求，请稍后重试。');
  assert.equal(taskErrorMessage(failure('CHALLENGE_FAILED', fanbox)), 'FANBOX 验证未完成，请稍后重试。');
});

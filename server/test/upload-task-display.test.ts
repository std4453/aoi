import assert from 'node:assert/strict';
import test from 'node:test';
import { taskErrorMessage, taskFailureLabel } from '../../client/src/lib/upload-task-display.ts';
import type { UploadTask } from '../../shared/types.js';

const task: UploadTask = {
  id: 'test', source: 'archive', name: 'test', filename: 'test.zip',
  totalBytes: 100, transferredBytes: 100, progress: 100, status: 'failed',
  packId: 'pack', uploadId: 'upload', matches: [], error: null,
  createdAt: '', updatedAt: '',
};

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

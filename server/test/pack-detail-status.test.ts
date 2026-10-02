import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldPollPack, shouldReloadPackPreview } from '../../client/src/lib/packStatus.js';
import type { Pack } from '../../shared/types.js';

test('details poll server-side Pixiv downloads through completion or failure', () => {
  const pixiv = { sourceType: 'folder', originalFormat: 'pixiv' } as const;
  for (const status of ['uploading', 'verifying', 'thumbnailing', 'awaiting_confirmation'] as const) {
    assert.equal(shouldPollPack({ ...pixiv, status }), true);
  }
  for (const status of ['extracted', 'generated', 'failed'] as const) {
    assert.equal(shouldPollPack({ ...pixiv, status }), false);
  }
  assert.equal(shouldPollPack({ sourceType: 'archive', originalFormat: 'rar', status: 'uploading' }), true);
  assert.equal(shouldPollPack({ sourceType: 'folder', originalFormat: 'folder', status: 'uploading' }), false);
  assert.equal(shouldPollPack(null), false);
});

test('fast imports reload previews even when polling skips intermediate stages', () => {
  for (const previous of ['uploading', 'extracting', 'verifying', 'thumbnailing', 'awaiting_confirmation'] satisfies Pack['status'][]) {
    assert.equal(shouldReloadPackPreview(previous, 'extracted'), true);
    assert.equal(shouldReloadPackPreview(previous, 'generated'), true);
    assert.equal(shouldReloadPackPreview(previous, 'failed'), false);
  }
  assert.equal(shouldReloadPackPreview(undefined, 'extracted'), false);
  assert.equal(shouldReloadPackPreview('extracted', 'extracted'), false);
});

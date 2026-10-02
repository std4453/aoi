import assert from 'node:assert/strict';
import test from 'node:test';
import { formatJobProgress } from '../../client/src/lib/utils.js';

test('verification progress displays bytes, while file processing displays file counts', () => {
  assert.equal(formatJobProgress({ phase: 'verifying', completed: 2147483648, total: 4294967296 }), '已校验 2.0 GB / 4.0 GB');
  assert.equal(formatJobProgress({ phase: 'verifying', completed: 0, total: 169687195 }), '已校验 0 B / 161.8 MB');
  for (const phase of ['downloading', 'thumbnails', 'compressing', 'archiving']) {
    assert.equal(formatJobProgress({ phase, completed: 20, total: 78 }), '20 / 78 个文件');
  }
  assert.equal(formatJobProgress({ phase: 'verifying', completed: 0, total: 0 }), undefined);
  assert.equal(formatJobProgress(null), undefined);
});

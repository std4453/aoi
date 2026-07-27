import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import {
  normalizeRelativePath,
  resolveWithin,
  validateIdentifier,
} from '../src/services/safe-path.js';

test('normalizes portable nested paths', () => {
  assert.equal(normalizeRelativePath('图集/landscape.jpg'), '图集/landscape.jpg');
  assert.equal(normalizeRelativePath('folder\\nested\\image.png'), 'folder/nested/image.png');
});

test('rejects absolute and traversal paths', () => {
  for (const unsafe of [
    '../packdb.sqlite',
    'folder/../../packdb.sqlite',
    '/etc/passwd',
    'C:\\Windows\\system.ini',
    'folder//image.jpg',
    'folder/./image.jpg',
    'folder/image\nname.jpg',
    `folder/${'x'.repeat(256)}.jpg`,
  ]) {
    assert.throws(
      () => normalizeRelativePath(unsafe),
      /Invalid relative path|must not be absolute|unsafe path segment/
    );
  }
});

test('resolves only descendants of the allowed directory', () => {
  const root = path.resolve('/tmp/aoi-safe-root');
  assert.equal(resolveWithin(root, 'nested/image.jpg'), path.join(root, 'nested/image.jpg'));
  assert.throws(() => resolveWithin(root, '../../../etc/passwd'));
});

test('accepts generated ids and rejects path-like ids', () => {
  assert.equal(validateIdentifier('0d76a450-a8e1-4f14-a37e-b9d814d15c53'), '0d76a450-a8e1-4f14-a37e-b9d814d15c53');
  assert.throws(() => validateIdentifier('../../etc'));
  assert.throws(() => validateIdentifier('contains.dot'));
});

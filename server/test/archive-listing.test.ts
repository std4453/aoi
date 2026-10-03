import assert from 'node:assert/strict';
import test from 'node:test';
import { is7zLinkField } from '../src/services/archive-extractor.js';

test('7-Zip 26 RAR listing permits empty link metadata but still rejects real links', () => {
  // Ordinary RAR5 files include all three empty fields in 7-Zip 26.03.
  const regularEntry = 'Path = photos/image.jpg\nAttributes = A\nSymbolic Link = \nHard Link = \nCopy Link = \n';
  assert.equal(regularEntry.split('\n').some(is7zLinkField), false);
  assert.equal(is7zLinkField('Attributes = A -rw-r--r--'), false);
  for (const metadata of ['Symbolic Link = ../../outside', 'Hard Link = target.jpg',
    'Copy Link = target.jpg', 'Attributes = A_ lrwxrwxrwx', 'Attributes = l---------']) {
    assert.equal(is7zLinkField(metadata), true, metadata);
  }
});

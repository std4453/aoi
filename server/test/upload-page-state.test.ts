import assert from 'node:assert/strict';
import test from 'node:test';
import { taskRevealDelta, saveUploadScrollY, getUploadScrollY, setHandledRevealRevision, getHandledRevealRevision } from '../../client/src/features/uploads/view-state';

test('expanded cards scroll only as far as needed inside the unobscured viewport', () => {
  assert.equal(taskRevealDelta(150, 400, 100, 700), 0, 'fully visible cards stay in place');
  assert.equal(taskRevealDelta(80, 400, 100, 700), -20, 'reveal a heading hidden behind the sticky header');
  assert.equal(taskRevealDelta(500, 800, 100, 700), 100, 'a clipped bottom only scrolls by the missing space');
  assert.equal(taskRevealDelta(200, 950, 100, 700), 100, 'oversized cards align their heading');
  assert.equal(taskRevealDelta(-50, 850, 100, 700), -150, 'oversized cards hidden above scroll upward');
});

test('upload tab state keeps scroll and handled reveals in memory across remounts', () => {
  saveUploadScrollY(431);
  setHandledRevealRevision(7);
  assert.equal(getUploadScrollY(), 431);
  assert.equal(getHandledRevealRevision(), 7);
  saveUploadScrollY(0);
  setHandledRevealRevision(0);
});

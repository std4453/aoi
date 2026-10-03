import assert from 'node:assert/strict';
import test from 'node:test';
import { retainPendingTasks, selectionAfterRemoval } from '../../client/src/features/uploads/view-state.ts';

const tasks = ['first', 'middle', 'last'].map(id => ({ id }));

test('task removal clears only the removed selection without expanding another task', () => {
  assert.equal(selectionAfterRemoval('middle', 'middle'), null);
  assert.equal(selectionAfterRemoval('last', 'last'), null);
  assert.equal(selectionAfterRemoval('first', 'first'), null);
  assert.equal(selectionAfterRemoval(null, 'middle'), null);
  assert.equal(selectionAfterRemoval('first', 'middle'), 'first');
});

test('polling retains deleting cards in place before and during their exit', () => {
  assert.deepEqual(retainPendingTasks([tasks[0], tasks[2]], tasks, new Set(['middle'])), tasks);
  assert.deepEqual(retainPendingTasks([{ id: 'new' }, tasks[2]], tasks, new Set(['first', 'middle'])), [{ id: 'new' }, ...tasks]);
  assert.deepEqual(retainPendingTasks([tasks[0]], tasks, new Set(['middle', 'last'])), tasks);
  assert.deepEqual(retainPendingTasks(tasks, tasks, new Set(['middle'])), tasks);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { retainPendingTasks, selectionAfterRemoval } from '../../client/src/lib/upload-task-state.ts';

const tasks = ['first', 'middle', 'last'].map(id => ({ id }));

test('task removal selects the next remaining task without reopening the upload form', () => {
  assert.equal(selectionAfterRemoval(tasks, 'middle', 'middle', new Set(['middle'])), 'last');
  assert.equal(selectionAfterRemoval(tasks, 'last', 'last', new Set(['last'])), null);
  assert.equal(selectionAfterRemoval(tasks, 'first', 'first', new Set(['first', 'middle'])), 'last');
  assert.equal(selectionAfterRemoval(tasks, null, 'middle', new Set()), null);
  assert.equal(selectionAfterRemoval(tasks, 'first', 'middle', new Set()), 'first');
});

test('polling retains deleting cards in place before and during their exit', () => {
  assert.deepEqual(retainPendingTasks([tasks[0], tasks[2]], tasks, new Set(['middle'])), tasks);
  assert.deepEqual(retainPendingTasks([{ id: 'new' }, tasks[2]], tasks, new Set(['first', 'middle'])), [{ id: 'new' }, ...tasks]);
  assert.deepEqual(retainPendingTasks([tasks[0]], tasks, new Set(['middle', 'last'])), tasks);
  assert.deepEqual(retainPendingTasks(tasks, tasks, new Set(['middle'])), tasks);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import type { Task } from '../../types';
import { dueDay, matchesTaskView, sortActionTasks } from './task-view';

const task = (fields: Partial<Task> = {}): Task => ({ id: 'one', projectId: 'project', title: '任务', description: '', status: 'todo', priority: 'medium', executor: 'self', dueAt: null, sourceLabel: '', dependsOn: [], blockedReason: '', createdAt: '2026-09-01', updatedAt: '2026-09-01', completedAt: null, startAt: null, relatedDocuments: [], ...fields });
test('today includes the entire due date, and overdue excludes closed tasks', () => {
  assert.equal(matchesTaskView(task({ dueAt: '2026-09-05' }), 'today', '2026-09-05'), true);
  assert.equal(matchesTaskView(task({ dueAt: '2026-09-05' }), 'overdue', '2026-09-05'), false);
  for (const status of ['done', 'cancelled'] as const) assert.equal(matchesTaskView(task({ status, dueAt: '2026-09-04' }), 'overdue', '2026-09-05'), false);
  assert.equal(dueDay('invalid'), null);
});
test('waiting includes blocked work and cancelled work remains recoverable', () => {
  assert.equal(matchesTaskView(task({ blockedReason: '等待接口' }), 'waiting'), true);
  assert.equal(matchesTaskView(task({ status: 'cancelled' }), 'cancelled'), true);
  assert.equal(matchesTaskView(task({ status: 'cancelled' }), 'open'), false);
});
test('action sorting respects deadline, priority, and closed status without mutating input', () => {
  const tasks = [task({ id: 'no-date', priority: 'high' }), task({ id: 'later', dueAt: '2026-09-10' }), task({ id: 'urgent', dueAt: '2026-09-04', priority: 'high' }), task({ id: 'normal', dueAt: '2026-09-04' }), task({ id: 'done', status: 'done', dueAt: '2026-09-01' })];
  assert.deepEqual(sortActionTasks(tasks).map(t => t.id), ['urgent', 'normal', 'later', 'no-date', 'done']);
  assert.equal(tasks[0].id, 'no-date');
});

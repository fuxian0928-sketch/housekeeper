import assert from 'node:assert/strict';
import test from 'node:test';
import { extractTaskBatchSuggestion, validateTaskDrafts } from './task-service.js';

test('从下一步建议回答中提取并去重批量任务', () => {
  const result = extractTaskBatchSuggestion('1. 建立检索测试集：覆盖同义问题\n2. 补充项目摘要：说明风险\n3. 建立检索测试集：重复项', 'p1');
  assert.equal(result?.projectId, 'p1');
  assert.deepEqual(result?.tasks.map((task) => task.title), ['建立检索测试集', '补充项目摘要']);
});

test('批量任务限制数量并规范默认字段', () => {
  const result = validateTaskDrafts([{ title: '任务一' }, { title: '任务二', priority: 'high', executor: 'ai', dependsOn: ['task-1', 'task-1'], blockedReason: '等待接口' }]);
  assert.equal(result[0].priority, 'medium');
  assert.equal(result[1].executor, 'ai');
  assert.deepEqual(result[1].dependsOn, ['task-1']);
  assert.equal(result[1].blockedReason, '等待接口');
  assert.throws(() => validateTaskDrafts([]), /1～50/);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { classifyDocumentVersions } from './project-summary.js';

test('项目总结把旧版本与当前版本分开', () => {
  const documents = [{ id: 'v3', title: '方案 v3' }, { id: 'v2', title: '方案 v2' }, { id: 'other', title: '任务说明' }];
  const result = classifyDocumentVersions(documents, new Set(['v2']));
  assert.deepEqual(result.current.map((item) => item.id), ['v3', 'other']);
  assert.deepEqual(result.historical.map((item) => item.id), ['v2']);
});

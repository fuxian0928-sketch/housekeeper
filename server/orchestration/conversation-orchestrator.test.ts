import { routeWorkIntents } from './intent-router.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { runConversationPlan } from './conversation-orchestrator.js';

test('不需要 RAG 的写操作不会调用向量模型', async () => {
  let embeddingCalled = false;
  const plan = await runConversationPlan({
    message: '创建一个高优先级任务',
    intentRoute: routeWorkIntents('创建一个高优先级任务', 'project-does-not-need-to-exist', []),
    retrievalQuery: '创建一个高优先级任务',
    projectId: 'project-does-not-need-to-exist',
    documentPaths: [],
    embeddingProvider: {
      model: 'test', dimension: 3, version: 'test',
      async embed() { embeddingCalled = true; return [[0, 0, 0]]; }
    }
  });
  assert.equal(plan.intentRoute.requiresRetrieval, false);
  assert.equal(embeddingCalled, false);
  assert.deepEqual(plan.citations, []);
});

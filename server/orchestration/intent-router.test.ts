import assert from 'node:assert/strict';
import test from 'node:test';
import { routeIntents, routeWorkIntents } from './intent-router.js';

test('一级意图先区分工作和聊天', () => {
  const work = routeIntents('你觉得这个产品下一步应该怎么规划？', 'p1', []);
  const chat = routeIntents('哦，你现在说说你对我的印象', 'p1', []);
  assert.equal(work.domain, 'work');
  assert.equal(chat.domain, 'chat');
  assert.equal(chat.requiresRetrieval, false);
  assert.deepEqual(chat.scope.documentPaths, []);
});

test('主动引用文档时始终进入工作意图', () => {
  const route = routeIntents('你怎么看？', 'p1', ['AI秘书/方案.md']);
  assert.equal(route.domain, 'work');
  assert.equal(route.requiresRetrieval, true);
});

test('情绪陪伴进入聊天意图且不召回项目资料', () => {
  const route = routeIntents('今天好累，陪我聊会儿吧', 'p1', []);
  assert.equal(route.domain, 'chat');
  assert.equal(route.intents[0]?.category, 'emotional_companionship');
  assert.equal(route.requiresRetrieval, false);
});

test('项目对话中的普通问题不会因为当前项目而强制触发 RAG', () => {
  for (const message of ['给我讲个笑话', '量子纠缠是什么？', '帮我写一句生日祝福']) {
    const route = routeIntents(message, 'p1', []);
    assert.equal(route.domain, 'chat');
    assert.equal(route.requiresRetrieval, false);
  }
});

test('单纯写操作不做向量检索，明确资料问题才检索', () => {
  const write = routeIntents('创建一个高优先级任务', 'p1', []);
  const read = routeIntents('总结一下这个项目的当前进展', 'p1', []);
  assert.equal(write.domain, 'work');
  assert.equal(write.requiresRetrieval, false);
  assert.equal(read.domain, 'work');
  assert.equal(read.requiresRetrieval, true);
});

test('拆分总结、建议和新建任务三个工作意图', () => {
  const route = routeWorkIntents('先总结项目现状，给我下一步建议，然后新建一个高优先级任务', 'p1', []);
  assert.deepEqual(route.executionOrder, ['summarize', 'project_status_summary', 'recommend_next_steps', 'task_create']);
  assert.equal(route.requiresRetrieval, true);
  assert.equal(route.requiresConfirmation, true);
  assert.equal(route.entities.priority, 'high');
});

test('否定表达不会触发任务写入', () => {
  const route = routeWorkIntents('总结现状，但不要创建任务', 'p1', []);
  assert.equal(route.intents.some((intent) => intent.action === 'task_create'), false);
});

test('文档写入目标不明确时要求澄清', () => {
  const route = routeWorkIntents('帮我修改 Obsidian 文档', 'p1', []);
  assert.equal(route.requiresConfirmation, true);
  assert.match(route.clarification ?? '', /路径/);
});

test('识别历史时间范围和用户指定文档', () => {
  const route = routeWorkIntents('查看之前为什么这样设计', 'p1', ['AI秘书/设计.md']);
  assert.equal(route.scope.timeRange, 'history');
  assert.deepEqual(route.scope.documentPaths, ['AI秘书/设计.md']);
  assert.equal(route.intents.some((intent) => intent.action === 'history_trace'), true);
});

test('识别项目、任务和文档整理的组合写入意图及风险', () => {
  const route = routeWorkIntents('创建项目，然后建立高优先级任务，最后重命名文档 AI秘书/旧方案.md', null, ['AI秘书/旧方案.md']);
  assert.deepEqual(route.executionOrder, ['task_create', 'project_create', 'document_organize']);
  assert.equal(route.entities.priority, 'high');
  assert.equal(route.entities.targetPath, 'AI秘书/旧方案.md');
  assert.equal(route.intents.find((intent) => intent.action === 'document_organize')?.risk, 'high');
  assert.equal(route.requiresConfirmation, true);
});

test('识别记忆治理和撤销控制意图', () => {
  const route = routeWorkIntents('把这条记忆设为失效，然后撤销上一次操作', 'p1', []);
  assert.ok(route.intents.some((intent) => intent.action === 'memory_govern'));
  assert.ok(route.intents.some((intent) => intent.action === 'confirm_or_cancel'));
  assert.equal(route.intents.find((intent) => intent.action === 'confirm_or_cancel')?.risk, 'high');
});

test('识别需要联网补充的外部研究意图', () => {
  const route = routeWorkIntents('联网查一下最近竞品有什么变化', 'project-1', []);
  assert.ok(route.intents.some((intent) => intent.action === 'external_research'));
  assert.equal(route.requiresRetrieval, true);
});

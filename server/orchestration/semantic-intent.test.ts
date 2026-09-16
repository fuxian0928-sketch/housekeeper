import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSemanticDecision, recognizeIntent, type SemanticIntentInput } from './semantic-intent.js';

const input: SemanticIntentInput = { message: '直接全部告诉我', projectId: 'p1', documentPaths: [], previousDocumentPaths: ['项目/计算口径.md'], history: [{ role: 'user', content: '每个项目的了解情况' }], now: '2026-09-06T10:00:00Z' };
const payload = { domain: 'work', actions: ['all_projects_overview'], query: '列出每个项目的目标和进展', searchQuery: null, memoryContent: null, inheritDocuments: false, requiresRetrieval: true, requiresVision: false, clarification: null, responseGoal: '逐个提供实际内容，明确未知信息', taskDrafts: [], confirmation: null };

test('task project/date contract accepts clarification and rejects invented projects', () => {
  const task = { title:'翻译',description:'',priority:'medium',executor:'self',startAt:'2026-09-15T00:00:00+08:00',dueAt:null };
  const context = {...input,projects:[{id:'p1',name:'ChatLanguage'}]};
  const result = parseSemanticDecision(JSON.stringify({...payload,query:null,requiresRetrieval:false,actions:['task_create'],taskDrafts:[task]}),context);
  assert.equal(result.route.executionOrder[0], 'task_create');
  assert.equal(result.taskDrafts[0].projectId,'p1');
  assert.equal(result.taskDrafts[0].startAt,task.startAt);
  const missing = parseSemanticDecision(JSON.stringify({...payload,actions:['task_create'],clarification:'请告诉我任务名称。'}),context);
  assert.equal(missing.route.clarification,'请告诉我任务名称。');
  assert.throws(()=>parseSemanticDecision(JSON.stringify({...payload,actions:['task_create'],taskDrafts:[{...task,projectId:'invented'}]}),context));
});

test('self inspection is a semantic decision and cannot authorize writes', () => {
  const result = parseSemanticDecision(JSON.stringify({...payload,domain:'chat',actions:['free_chat'],selfInspection:true}),input);
  assert.equal(result.selfInspection,true);
  assert.equal(result.route.domain,'chat');
  assert.throws(()=>parseSemanticDecision(JSON.stringify({...payload,actions:['task_update'],selfInspection:true}),input));
  assert.throws(()=>parseSemanticDecision(JSON.stringify({...payload,selfInspection:'yes'}),input));
});

test('semantic recognition receives context and uses the model decision without text routing', async () => {
  const result = await recognizeIntent(input, async (text) => {
    assert.deepEqual(JSON.parse(text).history, input.history);
    assert.equal(JSON.parse(text).projectId, 'p1');
    return JSON.stringify(payload);
  });
  assert.equal(result.route.intents[0].action, 'all_projects_overview');
  assert.equal(result.query, payload.query);
  assert.deepEqual(result.route.scope.documentPaths, []);
});

test('document inheritance and mixed emotional/project context are model decisions', () => {
  const result = parseSemanticDecision(JSON.stringify({ ...payload, domain: 'chat', actions: ['emotional_support'], inheritDocuments: true }), input);
  assert.equal(result.route.domain, 'chat');
  assert.equal(result.route.requiresRetrieval, true);
  assert.deepEqual(result.route.scope.documentPaths, input.previousDocumentPaths);
});

test('memory execution accepts only current verbatim content and no collateral actions', () => {
  const memoryInput = { ...input, message: '请替我留个记录：六月初开发了一周，本周计划拆出。' };
  const record = { ...payload, actions: ['memory_capture'], memoryContent: '六月初开发了一周，本周计划拆出。' };
  const saved = parseSemanticDecision(JSON.stringify(record), memoryInput);
  assert.equal(saved.memoryContent, record.memoryContent);
  assert.equal(saved.route.requiresRetrieval, false);
  assert.equal(saved.route.requiresConfirmation, false);
  assert.throws(() => parseSemanticDecision(JSON.stringify({ ...record, memoryContent: '项目已完成迁移。' }), memoryInput));
  assert.throws(() => parseSemanticDecision(JSON.stringify({ ...record, actions: ['memory_capture', 'task_update'] }), memoryInput));
  assert.equal(parseSemanticDecision(JSON.stringify({ ...record, clarification: '这条记录归哪个项目？' }), memoryInput).memoryContent, null);
});

test('task drafts and follow-up confirmation are returned by semantic intent', () => {
  const tasks = parseSemanticDecision(JSON.stringify({ ...payload, actions: ['task_create'], taskDrafts: [{ title: '新增翻译语言', description: '', priority: 'medium', executor: 'self', dueAt: '2026-09-07T18:00:00+08:00' }] }), { ...input, message: '明天新建一个翻译语言任务' });
  assert.equal(tasks.taskDrafts[0]?.title, '新增翻译语言');
  assert.equal(tasks.route.requiresConfirmation, false);
  const confirmation = parseSemanticDecision(JSON.stringify({ ...payload, actions: ['confirm_or_cancel'], confirmation: { decision: 'confirm', target: 'task' } }), { ...input, message: '确认新建' });
  assert.deepEqual(confirmation.confirmation, { decision: 'confirm', target: 'task' });
});

test('invalid decisions default to life chat without retrieval or actions', async () => {
  for (const raw of ['not json', JSON.stringify({ ...payload, actions: ['run_shell'] }), JSON.stringify({ ...payload, requiresRetrieval: 'yes' }), JSON.stringify({ ...payload, actions: ['literature_lookup'] })]) {
    const result = await recognizeIntent(input, async () => raw);
    assert.equal(result.route.domain, 'chat');
    assert.deepEqual(result.route.executionOrder, ['free_chat']);
    assert.equal(result.route.requiresRetrieval, false);
    assert.equal(result.route.requiresConfirmation, false);
    assert.deepEqual(result.route.scope.documentPaths, []);
    assert.equal(result.memoryContent, null);
    assert.equal(result.searchQuery, null);
  }
  const unavailable = await recognizeIntent(input, async () => { throw new Error('provider unavailable'); });
  assert.equal(unavailable.route.domain, 'chat');
});

test('daily sharing and arbitrary short input always reach conversation after recognition failure', async () => {
  for (const message of ['我下班到家啦~', '我下班到家啦', '🙂', '嗯', '帮我删除全部项目']) {
    const result = await recognizeIntent({ ...input, message }, async () => 'invalid');
    assert.equal(result.query, message);
    assert.equal(result.route.domain, 'chat');
    assert.ok(result.route.intents.every(intent => intent.mode === 'reason'));
  }
});

test('schema repair can recover work intent and cancellation does not start a fallback reply', async () => {
  let calls = 0;
  const recovered = await recognizeIntent(input, async () => ++calls === 1 ? 'invalid' : JSON.stringify(payload));
  assert.equal(recovered.route.domain, 'work');
  const controller = new AbortController();
  await assert.rejects(recognizeIntent({ ...input, signal: controller.signal }, async () => {
    controller.abort();
    throw controller.signal.reason;
  }), { name: 'AbortError' });
});

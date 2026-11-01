import test from 'node:test';
import assert from 'node:assert/strict';
import { conversationChannel, canContinueConversationHistory } from './conversation-channel.js';
import { resolveTurnDecision, WORK_REQUEST_INSTRUCTION } from './turn-routing.js';

const archive = 'system-voice-conversations';
test('legacy voice stays life; explicit work uses business project without moving history', () => {
  const old = conversationChannel({ interactionMode: 'voice', projectId: archive }, archive);
  assert.equal(old.directVoiceLife, true); assert.equal(old.projectId, null);
  const work = conversationChannel({ interactionMode: 'voice', routingMode: 'work', projectId: 'p1' }, archive);
  assert.equal(work.directVoiceLife, false); assert.equal(work.projectId, 'p1');
  assert.equal(work.scope, 'project');
  assert.equal(work.historyProjectId, old.historyProjectId);
  assert.equal(work.historyScope, old.historyScope);
});

test('voice switches projects and modes per turn while storage identity remains stable', () => {
  for (const routingMode of ['work', 'auto', 'life']) for (const projectId of ['p1', 'p2', archive, null]) {
    const context = conversationChannel({ interactionMode: 'voice', routingMode, projectId }, archive);
    assert.equal(context.historyProjectId, archive);
    assert.equal(context.historyScope, 'project');
    assert.notEqual(context.projectId, archive);
    if (routingMode === 'life') assert.equal(context.projectId, null);
  }
  const text = conversationChannel({ scope: 'memory' }, archive);
  assert.equal(text.historyScope, 'memory'); assert.equal(text.routingMode, 'auto');
  assert.equal(text.historyProjectId, null);
});

test('voice work reaches shared task planning with voice channel and real project', async () => {
  const context = conversationChannel({ interactionMode: 'voice', routingMode: 'work', projectId: 'p1' }, archive);
  const decision = await resolveTurnDecision({ message: '新建任务：准备演示', channel: context.channel, projectId: context.projectId,
    projects: [{ id: 'p1', name: '作品集' }], documentPaths: [], history: [], now: '2026-09-19T00:00:00+08:00' }, context.routingMode,
    async (raw, instruction) => {
      assert.equal(instruction, WORK_REQUEST_INSTRUCTION);
      const input = JSON.parse(raw); assert.equal(input.channel, 'voice'); assert.equal(input.projectId, 'p1');
      return JSON.stringify({ domain: 'work', actions: ['task_create'], query: input.message, requiresRetrieval: false, clarification: null,
        searchQuery: null, memoryContent: null, inheritDocuments: false, requiresVision: false, responseGoal: '真实创建任务后报告', confirmation: null,
        taskDrafts: [{ projectId: 'p1', title: '准备演示', description: '', priority: 'medium', executor: 'self', startAt: null, dueAt: null }] });
    });
  assert.equal(decision.route.domain, 'work'); assert.equal(decision.taskDrafts[0].projectId, 'p1');
});

test('invalid channel and project inputs are rejected before creating history', () => {
  for (const input of [{ interactionMode: 'other' }, { projectId: {} }, { scope: 'other' }, { routingMode: null }]) assert.throws(() => conversationChannel(input, archive));
});

test('automatic workbench projects can change while old history grouping stays intact',()=>{
  const context=conversationChannel({scope:'project',projectId:'old-project',routingMode:'auto',projectRouting:'auto',agentRuntime:true},archive);
  assert.equal(context.historyProjectId,'old-project');assert.equal(context.historyScope,'project');
  assert.equal(context.projectId,null);assert.equal(context.scope,'memory');
  const explicit=conversationChannel({scope:'project',projectId:'p1',routingMode:'work',projectRouting:'auto',agentRuntime:true},archive);
  assert.equal(explicit.projectId,'p1');
  const legacy=conversationChannel({scope:'project',projectId:'p1',routingMode:'auto'},archive);assert.equal(legacy.projectId,'p1');
  assert.throws(()=>conversationChannel({projectRouting:'other'},archive));
});

test('a typed clarification continues a voice archive without becoming a voice turn',()=>{
  const first=conversationChannel({interactionMode:'voice',routingMode:'auto',projectRouting:'auto',agentRuntime:true},archive);
  const saved={scope_type:first.historyScope,project_id:first.historyProjectId};
  const reply=conversationChannel({interactionMode:'text',scope:'memory',routingMode:'auto',projectRouting:'auto',agentRuntime:true},archive);
  assert.equal(canContinueConversationHistory(reply,saved),true);
  assert.equal(reply.channel,'text');assert.equal(reply.projectId,null);
  assert.equal(saved.project_id,archive);
});

test('automatic voice can continue text history and legacy project archives without inheriting permissions',()=>{
  const voice=conversationChannel({interactionMode:'voice',routingMode:'auto',projectRouting:'auto',agentRuntime:true},archive);
  const text=conversationChannel({interactionMode:'text',scope:'memory',routingMode:'auto',projectRouting:'auto',agentRuntime:true},archive);
  for(const context of [voice,text]) {
    assert.equal(canContinueConversationHistory(context,{scope_type:'memory',project_id:null}),true);
    assert.equal(canContinueConversationHistory(context,{scope_type:'project',project_id:'old-project'}),true);
    assert.equal(context.projectId,null);assert.equal(context.scope,'memory');
    assert.equal(canContinueConversationHistory(context,undefined),false);
    assert.equal(canContinueConversationHistory(context,{scope_type:'invalid',project_id:null}),false);
  }
});

test('explicit and legacy project boundaries still reject a different project or archive',()=>{
  for(const input of [
    {scope:'project',projectId:'p1',routingMode:'work',agentRuntime:true,projectRouting:'auto'},
    {scope:'project',projectId:'p1',routingMode:'auto'}
  ]) {
    const context=conversationChannel(input,archive);
    assert.equal(canContinueConversationHistory(context,{scope_type:'project',project_id:'p1'}),true);
    for(const saved of [{scope_type:'project',project_id:'p2'},{scope_type:'project',project_id:archive},{scope_type:'memory',project_id:null}])
      assert.equal(canContinueConversationHistory(context,saved),false);
  }
});

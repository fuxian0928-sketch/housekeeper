import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTurnRoutingMode, resolveTurnDecision, WORK_REQUEST_INSTRUCTION } from './turn-routing.js';
import { SEMANTIC_INTENT_INSTRUCTION, type SemanticIntentInput } from './semantic-intent.js';

const input:SemanticIntentInput={message:'在当前项目新建任务：联调',projectId:'p1',projects:[{id:'p1',name:'测试项目'}],documentPaths:[],history:[],now:'2026-09-15T00:00:00+08:00'};
const work={domain:'work',actions:['task_create'],query:input.message,searchQuery:null,memoryContent:null,inheritDocuments:false,requiresRetrieval:false,requiresVision:false,clarification:null,responseGoal:'真实创建任务后报告',taskDrafts:[{projectId:'p1',startAt:null,title:'联调',description:'',priority:'medium',executor:'self',dueAt:null}],confirmation:null};

test('manual life bypasses model classification, work planning and all writes',async()=>{
  const life=await resolveTurnDecision(input,'life',async()=>assert.fail('life must not call classifier'));
  assert.equal(life.route.domain,'chat');assert.deepEqual(life.taskDrafts,[]);assert.equal(life.route.requiresRetrieval,false);assert.equal(life.confirmation,null);
});
test('manual work uses a work-only action contract, not first-level classification',async()=>{
  const result=await resolveTurnDecision(input,'work',async(raw,instruction)=>{
    assert.notEqual(instruction,SEMANTIC_INTENT_INSTRUCTION);assert.equal(instruction,WORK_REQUEST_INSTRUCTION);
    assert.ok(!instruction.includes('生活聊天是默认入口'));assert.ok(!instruction.includes('"work|chat"'));
    assert.equal(JSON.parse(raw).routingMode,'work');return JSON.stringify(work);
  });assert.equal(result.route.domain,'work');assert.equal(result.taskDrafts[0].title,'联调');
});
test('auto keeps existing recognition and is the default for older clients',async()=>{
  assert.equal(parseTurnRoutingMode(undefined),'auto');
  await resolveTurnDecision(input,parseTurnRoutingMode(undefined),async(_raw,instruction)=>{assert.equal(instruction,SEMANTIC_INTENT_INSTRUCTION);return JSON.stringify(work);});
  for(const mode of [null,'chat','invalid',1,{}])assert.throws(()=>parseTurnRoutingMode(mode),/请选择/);
});
test('same conversation context can switch life, work, auto without mutating history or scope',async()=>{
  const context={...input,history:[{role:'user',content:'我今天有点累'}]};
  const before=JSON.stringify(context);const called:string[]=[];
  for(const mode of ['life','work','auto'] as const){const result=await resolveTurnDecision(context,mode,async(raw,instruction)=>{assert.deepEqual(JSON.parse(raw).history,context.history);called.push(instruction);return JSON.stringify(work);});assert.equal(result.route.scope.projectId,'p1');assert.equal(result.route.domain,mode==='life'?'chat':'work');}
  assert.equal(called.length,2);assert.equal(JSON.stringify(context),before);
});
test('manual work cannot silently fall back to life, and invalid action plans do not write',async()=>{
  const chat=JSON.stringify({...work,domain:'chat',actions:['free_chat'],taskDrafts:[]});
  for(const output of [chat,'not json']){const result=await resolveTurnDecision(input,'work',async()=>output);assert.equal(result.route.domain,'work');assert.deepEqual(result.taskDrafts,[]);assert.ok(result.route.intents.every(i=>i.mode!=='write'&&i.mode!=='delete'));}
});
test('manual work still asks for missing fields and propagates cancellation',async()=>{
  const result=await resolveTurnDecision(input,'work',async()=>JSON.stringify({...work,clarification:'请提供任务名称。',taskDrafts:[]}));assert.equal(result.route.clarification,'请提供任务名称。');
  const controller=new AbortController();controller.abort();for(const mode of ['auto','work','life'] as const)await assert.rejects(()=>resolveTurnDecision({...input,signal:controller.signal},mode,async()=>assert.fail()));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AgentModel,AgentModelTurn} from '../agent/types.js';

test('Agent searches and reads webpages under the existing approval and source ledger',async suite=>{
  process.env.AI_SECRETARY_DB_PATH=join(mkdtempSync(join(tmpdir(),'agent-web-tools-')),'test.db');
  const {database,initializeDatabase}=await import('../../db.js');initializeDatabase();suite.after(()=>database.close());
  const {configureWebTools,executeWebTool}=await import('./web-tools.js');
  const {createAgentRun,listAgentInvocations}=await import('../agent/run-store.js');
  const {initialAgentCheckpoint,executeOfficeAgent}=await import('../agent/runtime.js');
  const {confirmAction}=await import('../../actions/action-service.js');
  let policy:'off'|'ask'|'auto'='ask',searches=0,reads=0;
  configureWebTools(()=>({policy,provider:{search:async input=>{searches++;return[{title:'官方文档',url:'https://docs.example/a',content:'可核对的摘要',score:1,publishedAt:'2026-10-26',query:input.query,purpose:''}];},fetchPage:async url=>{reads++;return{url,title:'官方文档',content:'已核对正文',truncated:false};}}}));
  const start=(id:string,goal:string)=>{database.prepare("INSERT INTO conversations(id,scope_type,project_id,title,created_at,updated_at) VALUES(?,'memory',NULL,?,'2026-10-26','2026-10-26')").run(id,goal);return createAgentRun({conversationId:id,projectId:null,goal,inputId:id,model:'test',checkpoint:initialAgentCheckpoint([],goal)}).run;};
  const call=(name:string,args:unknown):AgentModelTurn=>({content:'',finishReason:'tool_calls',toolCalls:[{id:name,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
  const model:AgentModel=async messages=>{
    const names=messages.flatMap(m=>m.tool_calls?.map(c=>c.function.name)??[]);
    if(!names.includes('search_web'))return call('search_web',{query:'API 官方文档'});
    if(!names.includes('fetch_web'))return call('fetch_web',{url:'https://docs.example/a'});
    return{content:'已核对官方文档。',finishReason:'stop',toolCalls:[]};
  };
  const run=start('needs-consent','分析最新接口变化');
  let result=await executeOfficeAgent({runId:run.id,modelName:'test',model});
  assert.equal(result.run.status,'waiting_approval');assert.equal(searches,0);
  const pending=listAgentInvocations(run.id).find(item=>item.status==='waiting_approval');assert.ok(pending?.proposalId);assert.equal(pending.mode,'read');
  await confirmAction(pending.proposalId);
  result=await executeOfficeAgent({runId:run.id,modelName:'test',model});
  assert.equal(result.run.status,'completed');assert.equal(searches,1);assert.equal(reads,1);
  assert.equal(result.run.checkpoint.sources[0].path,'https://docs.example/a');assert.equal(result.run.checkpoint.sources[0].excerpt,'已核对正文');
  const explicit=start('explicit-consent','联网搜索最新接口文档');
  assert.equal((await executeOfficeAgent({runId:explicit.id,modelName:'test',model})).run.status,'completed');assert.equal(searches,2);
  policy='off';await assert.rejects(()=>executeWebTool('search_web',{query:'测试'},{confirmed:true}),/未开启/);assert.equal(searches,2);
  configureWebTools(()=>({policy:'off',provider:null}));
});

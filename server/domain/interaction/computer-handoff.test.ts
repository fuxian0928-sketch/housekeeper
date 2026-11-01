import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {AgentModel,AgentModelTurn} from '../agent/types.js';

test('authenticated computer tasks hand off once and ordinary actions do not require repeated approval',async suite=>{
  const root=mkdtempSync(join(tmpdir(),'xiwei-computer-handoff-'));process.env.AI_SECRETARY_DB_PATH=join(root,'test.db');process.env.AI_SECRETARY_DOCUMENT_ROOT=join(root,'raw');
  const {database,initializeDatabase,nowIso}=await import('../../db.js');initializeDatabase();suite.after(()=>database.close());
  database.exec("CREATE TABLE computer_commands(id TEXT PRIMARY KEY,device_id TEXT NOT NULL,session_id TEXT NOT NULL,run_id TEXT NOT NULL,tool TEXT NOT NULL,args_json TEXT NOT NULL,status TEXT NOT NULL,result_json TEXT,error TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)");
  database.prepare("INSERT INTO computer_commands VALUES('legacy','old-device','old-session','old-run','Type','{}','succeeded','{}',NULL,?,?)").run(nowIso(),nowIso());
  const bridge=await import('./computer-bridge.js'),store=await import('../agent/run-store.js'),runtime=await import('../agent/runtime.js');
  const policies=await import('../skills/tool-controls.js');
  const token='e'.repeat(64),deviceId='handoff-computer';
  const empty={type:'object',properties:{},additionalProperties:false};
  bridge.registerComputer({deviceId,token,tools:[{name:'ControlStatus',inputSchema:empty},{name:'Snapshot',inputSchema:empty},{name:'App',inputSchema:{type:'object',properties:{name:{type:'string'}},required:['name'],additionalProperties:false}},{name:'Type',inputSchema:{type:'object',properties:{text:{type:'string'},label:{type:'integer'}},required:['text','label'],additionalProperties:false}}]});
  function create(id:string){const at=nowIso();database.prepare('INSERT INTO conversations(id,scope_type,title,created_at,updated_at) VALUES(?,?,?,?,?)').run(id,'global','打开记事本输入测试文字',at,at);const checkpoint=runtime.initialAgentCheckpoint([],'打开记事本输入测试文字',{interaction:{deviceId}});checkpoint.interaction!.computerSessionId=bridge.computerSession(deviceId);return store.createAgentRun({conversationId:id,inputId:id,goal:'打开记事本输入测试文字',projectId:null,model:'mock',checkpoint}).run;}
  const answer:AgentModelTurn={content:'操作已完成。',finishReason:'stop',toolCalls:[]};
  const call=(id:string,name:string,args:Record<string,unknown>):AgentModelTurn=>({content:'',finishReason:'tool_calls',toolCalls:[{id,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
  function pump(onCommand:(name:string)=>unknown){
    const names:string[]=[];let failure:unknown;
    const timer=setInterval(()=>{try{const command=bridge.pollComputer(deviceId,token).command;if(command){names.push(String(command.tool));const result=onCommand(String(command.tool));bridge.receiveComputerReceipt({deviceId,token,id:command.id,sessionId:command.sessionId,result});}}catch(error){failure=error;}},5);
    return {names,stop(){clearInterval(timer);if(failure)throw failure;}};
  }
  const ready={structuredContent:{state:'ready',generation:4,wait_seconds:0}};
  const snapshot={content:[{type:'text',text:'测试窗口，输入框 label=1'}]};
  await suite.test('upgrading an existing command queue preserves receipts without replaying old actions',()=>{
    assert.ok(database.prepare('PRAGMA table_info(computer_commands)').all().some(row=>row.name==='control_lease'));
    assert.equal(database.prepare("SELECT status FROM computer_commands WHERE id='legacy'").get()?.status,'succeeded');
    assert.equal(bridge.pollComputer(deviceId,token).command,null);
  });
  await suite.test('a direct open-app instruction also hands off and executes once without an approval round',async()=>{
    const run=create('direct-launch-handoff');let checks=0,step=0;
    const worker=pump(name=>name==='ControlStatus'?(++checks===1?{structuredContent:{state:'user',generation:2,wait_seconds:0}}:ready):{ok:true});
    try{const result=await runtime.executeOfficeAgent({runId:run.id,modelName:'mock',model:async()=>step++===0?call('direct-open','computer_action',{tool:'App',arguments:{name:'记事本'}}):answer});assert.equal(result.run.status,'completed',result.run.error??result.run.answer);}finally{worker.stop();}
    assert.deepEqual(worker.names.filter(name=>name!=='ControlStatus'),['App']);assert.equal(store.listAgentInvocations(run.id)[0].proposalId,null);
  });
  await suite.test('typing and clicking send lead to one handoff then multiple automatic actions',async()=>{
    const run=create('submit-handoff');let statusReads=0,step=0;
    const worker=pump(name=>name==='ControlStatus'?(++statusReads===1?{structuredContent:{state:'user',generation:2,wait_seconds:0}}:ready):name==='Snapshot'?snapshot:{ok:true});
    const turns=[call('observe','computer_snapshot',{}),call('open','computer_action',{tool:'App',arguments:{name:'记事本'}}),call('observe-new','computer_snapshot',{}),call('type','computer_action',{tool:'Type',arguments:{label:1,text:'公开测试'}}),answer];
    try{const result=await runtime.executeOfficeAgent({runId:run.id,modelName:'mock',model:async()=>turns[step++]});assert.equal(result.run.status,'completed',result.run.error??result.run.answer);}
    finally{worker.stop();}
    assert.deepEqual(worker.names.filter(name=>name!=='ControlStatus'),['Snapshot','App','Snapshot','Type']);
    assert.equal(database.prepare('SELECT COUNT(*) AS n FROM action_proposals WHERE conversation_id=?').get(run.conversationId)?.n,0);
    assert.equal(store.agentEventsAfter(run.id).filter(event=>event.type==='computer_control_wait').length,1);
    assert.equal(policies.toolExecutionPolicy('computer_action'),'auto');assert.equal(policies.toolExecutionPolicy('create_document'),'default');
    assert.ok(store.listAgentInvocations(run.id).every(call=>call.status==='succeeded'));
  });
  await suite.test('manual activity after the first observation pauses without retrying an action',async()=>{
    const run=create('takeover-handoff');let checks=0,step=0;
    const worker=pump(name=>name==='ControlStatus'?(++checks===1?ready:{structuredContent:{state:'user',generation:8,wait_seconds:9.8}}):snapshot);
    const turns=[call('observe','computer_snapshot',{}),call('type','computer_action',{tool:'Type',arguments:{label:1,text:'不得写入'}}),answer];
    try{const result=await runtime.executeOfficeAgent({runId:run.id,modelName:'mock',model:async()=>turns[step++]});assert.equal(result.run.status,'suspended');const failed=store.listAgentInvocations(run.id).find(call=>call.toolName==='computer_action')!;assert.match(failed.error!,/接管电脑/);assert.ok(!failed.error!.includes('generation'));}
    finally{worker.stop();}
    assert.equal(worker.names.includes('Type'),false);assert.equal(checks,2);
    let resumeChecks=0,resumeStep=0;
    const resumedWorker=pump(name=>name==='ControlStatus'?(++resumeChecks===1?{structuredContent:{state:'user',generation:10,wait_seconds:0}}:ready):name==='Snapshot'?snapshot:{ok:true});
    const resumeTurns=[call('observe-after-continue','computer_snapshot',{}),call('new-type-after-continue','computer_action',{tool:'Type',arguments:{label:1,text:'明确继续后重新规划'}}),answer];
    try{const result=await runtime.executeOfficeAgent({runId:run.id,modelName:'mock',additionalInput:'继续',model:async()=>resumeTurns[resumeStep++]});assert.equal(result.run.status,'partial',result.run.error??result.run.answer);assert.equal(store.listAgentInvocations(run.id).find(call=>call.callId==='new-type-after-continue')?.status,'succeeded');}finally{resumedWorker.stop();}
    assert.deepEqual(resumedWorker.names.filter(name=>name!=='ControlStatus'),['Snapshot','Type']);
    assert.equal(store.agentEventsAfter(run.id).filter(event=>event.type==='computer_control_wait').length,1);
  });
  await suite.test('a deliberate repeated UI action after a fresh observation does not create another approval',async()=>{
    const run=create('repeated-ui-handoff');let step=0;
    const worker=pump(name=>name==='ControlStatus'?ready:name==='Snapshot'?snapshot:{ok:true});
    const action={tool:'Type',arguments:{label:1,text:'重复操作'}};
    const turns=[call('observe-repeat-one','computer_snapshot',{}),call('type-repeat-one','computer_action',action),call('observe-repeat-two','computer_snapshot',{}),call('type-repeat-two','computer_action',action),answer];
    try{const result=await runtime.executeOfficeAgent({runId:run.id,modelName:'mock',model:async()=>turns[step++]});assert.equal(result.run.status,'completed',result.run.error??result.run.answer);}finally{worker.stop();}
    assert.equal(worker.names.filter(name=>name==='Type').length,2);assert.ok(store.listAgentInvocations(run.id).every(call=>call.proposalId===null));
  });
  await suite.test('cancellation during the initial idle wait never dispatches a screen or write operation',async()=>{
    const run=create('cancel-handoff'),controller=new AbortController();
    const worker=pump(()=>{queueMicrotask(()=>controller.abort());return {structuredContent:{state:'user',generation:2,wait_seconds:10}};});
    try{await runtime.executeOfficeAgent({runId:run.id,modelName:'mock',signal:controller.signal,model:async()=>call('observe','computer_snapshot',{})});}
    finally{worker.stop();}
    assert.deepEqual(worker.names,['ControlStatus']);
  });
  await suite.test('explicit confirmation policy still works without changing the default for other tools',()=>{
    policies.saveToolPolicy('computer_action','confirm');assert.equal(policies.toolExecutionPolicy('computer_action'),'confirm');policies.saveToolPolicy('computer_action','default');assert.equal(policies.toolExecutionPolicy('computer_action'),'auto');assert.equal(policies.toolExecutionPolicy('create_task'),'default');
  });
  await suite.test('stale coordinates are rejected before dispatch and ownership grants are not inferred',async()=>{
    const run=create('stale-handoff');let step=0;
    const worker=pump(name=>name==='ControlStatus'?ready:snapshot);
    const model:AgentModel=async messages=>{if(step++===0)return call('type-no-observation','computer_action',{tool:'Type',arguments:{label:1,text:'不得写入'}});const receipt=messages.at(-1);assert.match(receipt!.content!,/computer_snapshot/);return {content:'需要读取当前窗口。',toolCalls:[],finishReason:'stop'};};
    try{await runtime.executeOfficeAgent({runId:run.id,modelName:'mock',model});}finally{worker.stop();}assert.deepEqual(worker.names,[]);
  });
});

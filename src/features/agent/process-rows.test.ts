import assert from 'node:assert/strict';
import test from 'node:test';
import {buildProcessRows} from './process-rows';
import type {RunEvent,RunInvocation,RunView} from './types';

const at='2026-10-26T04:00:00Z';
const event=(seq:number,type:string,detail?:unknown):RunEvent=>({id:`e${seq}`,seq,type,label:type,createdAt:at,detail});
const call=(status:string):RunInvocation=>({id:'call-1',toolName:'create_document',mode:'write',status,arguments:{content:'PRIVATE_CONTENT',apiKey:'PRIVATE_KEY'},proposalId:null,error:null,result:{body:'PRIVATE_RESULT'}});
function view(events:RunEvent[],invocations:RunInvocation[]=[],status:RunView['run']['status']='running'):RunView{
  return {run:{id:'run-1',conversationId:'chat-1',goal:'写周报',status,executionMode:'foreground',answer:'',error:null,updatedAt:at},events,invocations,artifacts:[],sources:[]};
}
test('model transitions and tool receipts become stable, expandable rows without duplicated log lines',()=>{
  const rows=buildProcessRows(view([
    event(1,'model_started'),event(2,'model_finished',{calls:1}),
    event(3,'tool_started',{invocationId:'call-1'}),event(4,'tool_succeeded',{invocationId:'call-1'}),event(5,'step_result',{tool:'create_document'}),
    event(6,'model_started'),event(7,'model_finished',{calls:0})
  ],[call('succeeded')],'completed'));
  assert.deepEqual(rows.map(row=>[row.id,row.status]),[['model:1','done'],['tool:call-1','done'],['model:6','done']]);
  assert.equal(rows[2].label,'整理回答');assert.equal(rows[1].details.length,2);
  const visible=JSON.stringify(rows);for(const secret of ['PRIVATE_CONTENT','PRIVATE_KEY','PRIVATE_RESULT'])assert.ok(!visible.includes(secret));
});
test('waiting approval and unknown writes never turn green when the overall run ends',()=>{
  for(const [status,runStatus,expected] of [['waiting_approval','waiting_approval','waiting'],['unknown','completed','unknown'],['dispatching','failed','unknown'],['prepared','suspended','paused']] as const){
    const rows=buildProcessRows(view([event(1,'approval_required',{invocationId:'call-1'})],[call(status)],runStatus));
    assert.equal(rows[0].status,expected);assert.notEqual(rows[0].status,'done');
  }
});
test('failed tool remains failed, reconciliation uses the persisted receipt, internal results are only recorded',()=>{
  const events=[event(1,'tool_failed',{invocationId:'call-1'}),event(2,'step_result',{tool:'create_document'}),event(3,'step_result',{tool:'load_skill'})];
  const rows=buildProcessRows(view(events,[call('failed')],'partial'));
  assert.equal(rows[0].status,'failed');assert.equal(rows[1].status,'recorded');assert.equal(rows.length,2);
  assert.equal(buildProcessRows(view([event(1,'tool_unknown',{invocationId:'call-1'})],[call('succeeded')],'completed'))[0].status,'done');
});
test('running, paused and cancelled model steps use actual state, not a timer or a completion guess',()=>{
  const events=[event(1,'model_started')];
  assert.equal(buildProcessRows(view(events))[0].status,'running');
  assert.equal(buildProcessRows(view(events,[],'suspended'))[0].status,'paused');
  assert.equal(buildProcessRows(view(events,[],'cancelled'))[0].status,'cancelled');
  assert.equal(buildProcessRows(view(events,[],'completed'))[0].status,'unknown');
  assert.deepEqual(buildProcessRows(view(events)),buildProcessRows(view(events)));
});
test('interrupted snapshots and missing event windows still show calls without fabricating a completed step',()=>{
  assert.equal(buildProcessRows(view([],[],'queued'))[0].status,'pending');
  assert.equal(buildProcessRows(view([],[call('succeeded')],'completed'))[0].status,'done');
  assert.equal(buildProcessRows(view([event(7,'model_finished',{calls:0})],[],'completed'))[0].id,'model:7');
  assert.equal(buildProcessRows(view([],[],'failed'))[0].status,'failed');
});

test('computer handoff waits in the same operation row and resolves on readiness or pause',()=>{
  const invocation={...call('dispatching'),toolName:'computer_action'};
  const events=[event(1,'tool_started',{invocationId:invocation.id}),event(2,'computer_control_wait',{invocationId:invocation.id})];
  assert.equal(buildProcessRows(view(events,[invocation]))[0].status,'waiting');
  assert.equal(buildProcessRows(view(events,[invocation],'suspended'))[0].status,'unknown');
  assert.equal(buildProcessRows(view([...events,event(3,'computer_control_ready',{invocationId:invocation.id})],[invocation]))[0].status,'running');
  assert.equal(buildProcessRows(view([...events,event(3,'tool_succeeded',{invocationId:invocation.id})],[{...invocation,status:'succeeded'}],'completed'))[0].status,'done');
});

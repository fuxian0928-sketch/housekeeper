import { randomUUID } from 'node:crypto';
import { database,nowIso } from '../../db.js';
import { updateSkillExecution } from '../skills/skill-execution-audit.js';
import type { AgentArtifact,AgentCheckpoint,AgentEvent,AgentInvocation,AgentRun,AgentRunStatus } from './types.js';

const fail=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const activeInvocations=new Set<string>();
export const agentInvocationActive=(id:string)=>activeInvocations.has(id);
export function setAgentInvocationActive(id:string,active:boolean){if(active)activeInvocations.add(id);else activeInvocations.delete(id);}
export function atomicAgentWrite<T>(write:()=>T):T {
  database.exec('SAVEPOINT agent_write');
  try {const result=write();database.exec('RELEASE agent_write');return result;}
  catch(error){database.exec('ROLLBACK TO agent_write');database.exec('RELEASE agent_write');throw error;}
}
function mapRun(row:Record<string,unknown>):AgentRun {
  return {id:String(row.id),conversationId:String(row.conversation_id),inputId:String(row.input_id),userMessageId:String(row.user_message_id),projectId:row.project_id?String(row.project_id):null,goal:String(row.goal),status:row.status as AgentRunStatus,model:String(row.model),executionMode:row.execution_mode as AgentRun['executionMode'],answer:String(row.answer),error:row.error_message?String(row.error_message):null,createdAt:String(row.created_at),updatedAt:String(row.updated_at),checkpoint:JSON.parse(String(row.checkpoint_json)) as AgentCheckpoint};
}
export function getAgentRun(id:string):AgentRun {
  const row=database.prepare('SELECT * FROM agent_runs WHERE id=?').get(id);
  if(!row)throw fail('这项事务不存在。',404);
  return mapRun(row);
}
export function listAgentRuns(conversationId?:string|null) {
  const rows=conversationId?database.prepare('SELECT * FROM agent_runs WHERE conversation_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50').all(conversationId):database.prepare('SELECT * FROM agent_runs ORDER BY created_at DESC,rowid DESC LIMIT 100').all();
  return rows.map(row=>{const {checkpoint,...run}=mapRun(row);return {...run,sourceCount:checkpoint.sources.length};});
}
export function appendAgentEvent(runId:string,type:string,label:string,detail?:unknown):AgentEvent {
  return atomicAgentWrite(()=>{
    const id=randomUUID(),at=nowIso();
    const seq=Number(database.prepare('SELECT COALESCE(MAX(seq),0)+1 AS seq FROM agent_run_events WHERE run_id=?').get(runId)?.seq);
    database.prepare('INSERT INTO agent_run_events(id,run_id,seq,type,label,detail_json,created_at) VALUES(?,?,?,?,?,?,?)').run(id,runId,seq,type,label,detail===undefined?null:JSON.stringify(detail),at);
    return {id,runId,seq,type,label,detail,createdAt:at};
  });
}
export function agentEventsAfter(runId:string,after=0) {
  return database.prepare('SELECT * FROM agent_run_events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 250').all(runId,Math.max(0,Math.floor(after))).map(row=>({id:String(row.id),runId,seq:Number(row.seq),type:String(row.type),label:String(row.label),detail:row.detail_json?JSON.parse(String(row.detail_json)):undefined,createdAt:String(row.created_at)})) as AgentEvent[];
}
export function createAgentRun(input:{conversationId:string;inputId:string;goal:string;projectId:string|null;model:string;checkpoint:AgentCheckpoint;executionMode?:AgentRun['executionMode'];userMessageId?:string}) {
  return atomicAgentWrite(()=>{
    const existing=database.prepare('SELECT id,goal,project_id FROM agent_runs WHERE conversation_id=? AND input_id=?').get(input.conversationId,input.inputId);
    if(existing){if(existing.goal!==input.goal||(existing.project_id??null)!==input.projectId)throw fail('这次请求标识已用于另一项事务，请重新发送。');return {run:getAgentRun(String(existing.id)),created:false};}
    if(!input.goal.trim()||input.goal.length>20000||input.inputId.length>160)throw fail('事务内容或请求标识无效。',400);
    if(input.projectId&&!database.prepare('SELECT id FROM projects WHERE id=? AND deleted_at IS NULL').get(input.projectId))throw fail('项目不存在或已进入回收站。',404);
    const id=randomUUID(),at=nowIso(),userMessageId=input.userMessageId??randomUUID();
    if(!input.userMessageId)database.prepare("INSERT INTO messages(id,conversation_id,role,content,citations_json,created_at,run_id) VALUES(?,?,'user',?,'[]',?,?)").run(userMessageId,input.conversationId,input.goal,at,id);
    else database.prepare('UPDATE messages SET run_id=? WHERE id=? AND conversation_id=?').run(id,userMessageId,input.conversationId);
    database.prepare(`INSERT INTO agent_runs(id,conversation_id,input_id,user_message_id,project_id,goal,status,model,execution_mode,checkpoint_json,created_at,updated_at) VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?)`).run(id,input.conversationId,input.inputId,userMessageId,input.projectId,input.goal,input.model,input.executionMode??'foreground',JSON.stringify(input.checkpoint),at,at);
    database.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(at,input.conversationId);
    appendAgentEvent(id,'queued','已接到这项事务');
    return {run:getAgentRun(id),created:true};
  });
}
export function recoverAgentRun(id:string) {
  return atomicAgentWrite(()=>{
    const row=database.prepare('SELECT status,lease_expires_at,cancel_requested FROM agent_runs WHERE id=?').get(id);
    if(row?.status==='waiting_approval'){
      const interrupted=listAgentInvocations(id).filter(call=>call.status==='dispatching'&&!agentInvocationActive(call.id));
      if(interrupted.length){
        for(const call of interrupted){updateAgentInvocation(call.id,'unknown',{error:'批准后的执行中断，效果需要核实'});if(call.executionId)updateSkillExecution(call.executionId,'unknown',undefined,'执行中断，效果需要核实');if(call.proposalId)database.prepare("UPDATE action_proposals SET status='unknown',updated_at=? WHERE id=? AND status='executing'").run(nowIso(),call.proposalId);}
        database.prepare("UPDATE agent_runs SET status='reconciling',updated_at=? WHERE id=?").run(nowIso(),id);appendAgentEvent(id,'recovered','批准后的操作中断，需要核实结果');
      }
      return;
    }
    if(row?.status!=='running'||(row.lease_expires_at&&String(row.lease_expires_at)>nowIso()))return;
    database.prepare("UPDATE agent_invocations SET status=CASE WHEN mode='write' THEN 'unknown' ELSE 'prepared' END,error_message=CASE WHEN mode='write' THEN '执行中断，效果需要核实' ELSE error_message END,updated_at=? WHERE run_id=? AND status='dispatching'").run(nowIso(),id);
    const uncertain=database.prepare("SELECT id FROM agent_invocations WHERE run_id=? AND status='unknown' LIMIT 1").get(id);
    const status=uncertain?'reconciling':row.cancel_requested?'cancelled':'suspended';
    database.prepare('UPDATE agent_runs SET status=?,lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=? WHERE id=?').run(status,nowIso(),id);
    appendAgentEvent(id,'recovered',uncertain?'中断的操作需要核实':'进度已恢复，可以继续');
  });
}
export function claimAgentRun(id:string,model:string) {
  recoverAgentRun(id);
  const token=randomUUID();
  const result=database.prepare(`UPDATE agent_runs SET status='running',model=?,lease_token=?,lease_expires_at=?,error_message=NULL,revision=revision+1,updated_at=? WHERE id=? AND cancel_requested=0 AND status IN ('queued','suspended','waiting_input','waiting_approval','partial','failed')`).run(model,token,new Date(Date.now()+90_000).toISOString(),nowIso(),id);
  if(!result.changes)throw fail('这项事务正在执行、已经结束，或仍有待核实的操作。');
  appendAgentEvent(id,'running','正在处理这项事务');
  return token;
}
export function assertAgentOwner(id:string,token:string) {
  if(!database.prepare("SELECT id FROM agent_runs WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?").get(id,token,nowIso()))throw fail('这项事务已暂停、取消或由新的执行者接管。');
}
export function renewAgentLease(id:string,token:string) {
  const timer=setInterval(()=>database.prepare("UPDATE agent_runs SET lease_expires_at=? WHERE id=? AND status='running' AND lease_token=? AND lease_expires_at>?").run(new Date(Date.now()+90_000).toISOString(),id,token,nowIso()),20_000);
  timer.unref();return()=>clearInterval(timer);
}
export function checkpointAgentRun(id:string,token:string,checkpoint:AgentCheckpoint,event?:{type:string;label:string;detail?:unknown}) {
  return atomicAgentWrite(()=>{assertAgentOwner(id,token);const text=JSON.stringify(checkpoint);if(text.length>2_000_000)throw fail('这项事务的上下文已达到上限，进度已保留。');database.prepare('UPDATE agent_runs SET checkpoint_json=?,revision=revision+1,updated_at=? WHERE id=? AND lease_token=?').run(text,nowIso(),id,token);return event?appendAgentEvent(id,event.type,event.label,event.detail):null;});
}
export function finishAgentRun(id:string,token:string,status:AgentRunStatus,answer:string,error?:string) {
  return atomicAgentWrite(()=>{
    assertAgentOwner(id,token);
    const run=getAgentRun(id),at=nowIso();
    database.prepare('UPDATE agent_runs SET status=?,answer=?,error_message=?,lease_token=NULL,lease_expires_at=NULL,revision=revision+1,updated_at=? WHERE id=? AND lease_token=?').run(status,answer,error??null,at,id,token);
    let messageId:string|null=null;
    if(answer){messageId=randomUUID();database.prepare("INSERT INTO messages(id,conversation_id,role,content,citations_json,created_at,run_id) VALUES(?,?,'assistant',?,?,?,?)").run(messageId,run.conversationId,answer,JSON.stringify(run.checkpoint.sources.map(source=>({document:source.title,path:source.path,excerpt:source.excerpt,documentId:source.documentId,parentId:source.parentId,sourceRevision:source.sourceRevision,locator:source.locator,startOffset:source.startOffset,endOffset:source.endOffset}))),at,id);database.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(at,run.conversationId);}
    const labels:Record<string,string>={completed:'事务已完成',waiting_approval:'修改已准备好，等待确认',waiting_input:'需要补充信息',suspended:'已暂停，进度已保留',reconciling:'操作结果需要核实',partial:'已完成部分事项',failed:'处理未完成',cancelled:'已取消后续步骤'};
    const event=appendAgentEvent(id,status,labels[status]??status,{messageId,error});
    return {run:getAgentRun(id),event,messageId};
  });
}
export function controlAgentRun(id:string,action:'pause'|'cancel'|'background') {
  return atomicAgentWrite(()=>{
    const run=getAgentRun(id);
    if(action==='background'){database.prepare("UPDATE agent_runs SET execution_mode='background',updated_at=? WHERE id=?").run(nowIso(),id);appendAgentEvent(id,'background','将在后台继续，进度保留在工作台');return getAgentRun(id);}
    if(['completed','cancelled'].includes(run.status))return run;
    const dispatched=database.prepare("SELECT id FROM agent_invocations WHERE run_id=? AND mode='write' AND status IN ('dispatching','unknown') LIMIT 1").get(id);
    const status=dispatched?'reconciling':action==='cancel'?'cancelled':'suspended';
    database.prepare('UPDATE agent_runs SET status=?,cancel_requested=CASE WHEN ? THEN 1 ELSE cancel_requested END,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?').run(status,action==='cancel'?1:0,nowIso(),id);
    if(action==='cancel'){
      for(const call of listAgentInvocations(id).filter(call=>['prepared','waiting_approval'].includes(call.status)))if(call.executionId)updateSkillExecution(call.executionId,'cancelled');
      database.prepare("UPDATE action_proposals SET status='cancelled',updated_at=? WHERE id IN (SELECT proposal_id FROM agent_invocations WHERE run_id=? AND status='waiting_approval') AND status IN ('pending','edited')").run(nowIso(),id);
      database.prepare("UPDATE agent_invocations SET status='cancelled',updated_at=? WHERE run_id=? AND status IN ('prepared','waiting_approval')").run(nowIso(),id);
    }
    appendAgentEvent(id,status,dispatched?'已停止后续步骤，已发送的操作需要核实':action==='cancel'?'已取消后续步骤':'已暂停，进度已保留');
    return getAgentRun(id);
  });
}
function mapInvocation(row:Record<string,unknown>):AgentInvocation {return {id:String(row.id),runId:String(row.run_id),callId:String(row.call_id),toolName:String(row.tool_name),stableId:String(row.stable_id),fingerprint:String(row.fingerprint),arguments:JSON.parse(String(row.arguments_json)),mode:row.mode as AgentInvocation['mode'],status:row.status as AgentInvocation['status'],proposalId:row.proposal_id?String(row.proposal_id):null,result:row.result_json?JSON.parse(String(row.result_json)):null,error:row.error_message?String(row.error_message):null,attempt:Number(row.attempt),executionId:row.execution_id?String(row.execution_id):null,lateResult:row.late_result_json?JSON.parse(String(row.late_result_json)):undefined};}
export function listAgentInvocations(runId:string){return database.prepare('SELECT * FROM agent_invocations WHERE run_id=? ORDER BY rowid').all(runId).map(mapInvocation);}
export function prepareAgentInvocation(input:Omit<AgentInvocation,'id'|'status'|'proposalId'|'result'|'error'|'attempt'>) {
  const existing=database.prepare('SELECT * FROM agent_invocations WHERE run_id=? AND call_id=?').get(input.runId,input.callId);
  if(existing)return mapInvocation(existing);
  const id=randomUUID(),at=nowIso();
  database.prepare(`INSERT INTO agent_invocations(id,run_id,call_id,tool_name,stable_id,fingerprint,arguments_json,mode,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'prepared',?,?)`).run(id,input.runId,input.callId,input.toolName,input.stableId,input.fingerprint,JSON.stringify(input.arguments),input.mode,at,at);
  return listAgentInvocations(input.runId).find(item=>item.id===id)!;
}
export function updateAgentInvocation(id:string,status:AgentInvocation['status'],input:{result?:unknown;error?:string;proposalId?:string;executionId?:string;incrementAttempt?:boolean}={}) {
  database.prepare('UPDATE agent_invocations SET status=?,result_json=COALESCE(?,result_json),error_message=?,proposal_id=COALESCE(?,proposal_id),execution_id=COALESCE(?,execution_id),attempt=attempt+?,updated_at=? WHERE id=?').run(status,input.result===undefined?null:JSON.stringify(input.result),input.error??null,input.proposalId??null,input.executionId??null,input.incrementAttempt?1:0,nowIso(),id);
}
export function storeAgentArtifact(input:Omit<AgentArtifact,'id'|'createdAt'>) {
  const id=randomUUID(),at=nowIso();
  database.prepare('INSERT INTO agent_artifacts(id,run_id,kind,title,content,document_id,file_id,sources_json,created_at) VALUES(?,?,?,?,?,?,?,?,?)').run(id,input.runId,input.kind,input.title,input.content,input.documentId,input.fileId,JSON.stringify(input.sources),at);
  return {id,...input,createdAt:at};
}
export function listAgentArtifacts(runId:string) {
  return database.prepare('SELECT * FROM agent_artifacts WHERE run_id=? ORDER BY rowid').all(runId).map(row=>({id:String(row.id),runId,kind:row.kind as AgentArtifact['kind'],title:String(row.title),content:String(row.content),documentId:row.document_id?String(row.document_id):null,fileId:row.file_id?String(row.file_id):null,sources:JSON.parse(String(row.sources_json)),createdAt:String(row.created_at)})) as AgentArtifact[];
}

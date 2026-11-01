import type { Express,Request,Response } from 'express';
import { randomUUID } from 'node:crypto';
import { resolve,sep } from 'node:path';
import { database,nowIso } from '../db.js';
import { generatedFilesRoot } from '../domain/documents/spreadsheet-tools.js';
import { uncertainToolCall,reconcileToolCall } from '../domain/skills/external-tool-guard.js';
import { updateSkillExecution } from '../domain/skills/skill-execution-audit.js';
import { agentEventsAfter,agentInvocationActive,appendAgentEvent,atomicAgentWrite,createAgentRun,getAgentRun,listAgentArtifacts,listAgentInvocations,listAgentRuns,recoverAgentRun,updateAgentInvocation } from '../domain/agent/run-store.js';
import { executeOfficeAgent,initialAgentCheckpoint,stopOfficeAgent } from '../domain/agent/runtime.js';
import type { AgentCheckpoint,AgentEvent,AgentModel,AgentRun } from '../domain/agent/types.js';
import type { ReasoningEffort } from '../providers/llm-provider.js';
import {confirmAction,cancelAction} from '../actions/action-service.js';
import {acknowledgeNavigation} from '../domain/interaction/navigation-delivery.js';
import {authorizeComputerCaller} from '../domain/interaction/computer-bridge.js';
import {automaticProjectContext} from '../domain/interaction/automatic-project-context.js';
import {decideReasoning,validReasoningEffort} from '../orchestration/reasoning-policy.js';
import {VOICE_PRESENTATION_VERSION} from '../orchestration/voice-presentation.js';

const voicePresentation=(request:Request)=>request.body?.interactionMode==='voice'&&request.body?.voicePresentation===VOICE_PRESENTATION_VERSION;
const presentationFields=(request:Request,run:AgentRun)=>voicePresentation(request)?{voicePresentation:VOICE_PRESENTATION_VERSION,...(run.checkpoint.voiceNarration?{narration:run.checkpoint.voiceNarration}:{})}:{};

export type AgentRouteDependencies={canUseModel:()=>boolean;defaultModel:()=>string;defaultReasoning?:()=>ReasoningEffort;model:(name:string,effort?:ReasoningEffort,maxTokens?:number|null)=>AgentModel;requestSignal:(request:Request,response:Response)=>AbortSignal;context?:(goal:string,projectId:string|null,signal:AbortSignal)=>Promise<unknown>;onFinished?:(run:AgentRun)=>void};
const fail=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const jsonError=(response:Response,error:unknown)=>response.status(Number((error as {statusCode?:number})?.statusCode)||500).json({message:error instanceof Error?error.message:'事务处理未完成。'});
function write(response:Response,value:unknown){if(!response.destroyed&&!response.writableEnded)response.write(JSON.stringify(value)+'\n');}
function begin(response:Response){if(response.headersSent)return;response.status(200);response.setHeader('Content-Type','application/x-ndjson; charset=utf-8');response.setHeader('Cache-Control','no-store');response.setHeader('X-Accel-Buffering','no');response.flushHeaders?.();}
function assertCurrentDevice(run:AgentRun,request:Request){
  const expected=run.checkpoint.interaction?.deviceId;
  if(expected&&expected!==request.body?.deviceId)throw fail('请在发起这项事务的设备上继续处理。',409);
  if(run.checkpoint.interaction?.computerSessionId||listAgentInvocations(run.id).some(call=>call.toolName.startsWith('computer_'))){
    const caller=authorizeComputerCaller(request.body?.computerCaller);
    if(!caller||caller.deviceId!==expected||caller.sessionId!==run.checkpoint.interaction?.computerSessionId)throw fail('本机控制授权或连接已变化，请重新发起这项电脑事务。',409);
  }
}
export function agentRunView(id:string,after=0){
  recoverAgentRun(id);const {checkpoint,...run}=getAgentRun(id);
  return{run,events:agentEventsAfter(id,after),invocations:listAgentInvocations(id),artifacts:listAgentArtifacts(id),sources:checkpoint.sources};
}
export async function respondWithOfficeAgent(request:Request,response:Response,dependencies:AgentRouteDependencies,input:{conversationId:string;projectId:string|null;goal:string;history:Array<{role:string;content:string}>;modelName?:string;contextData?:unknown;sources?:AgentCheckpoint['sources'];userMessageId?:string;onProgress?:(event:AgentEvent)=>void}){
  if(request.body?.reasoningEffort!==undefined&&!validReasoningEffort(request.body.reasoningEffort))throw fail('请选择可用的思考程度。');
  if(request.body?.maxTokens!==undefined&&request.body.maxTokens!==null&&(!Number.isInteger(request.body.maxTokens)||request.body.maxTokens<64||request.body.maxTokens>32768))throw fail('最大输出长度需要填写64至32768之间的整数。');
  const signal=dependencies.requestSignal(request,response);
  const modelName=input.modelName||dependencies.defaultModel();
  const inputId=typeof request.body?.inputId==='string'?request.body.inputId:randomUUID();
  const contextData=input.contextData??await dependencies.context?.(input.goal,input.projectId,signal);
  const rawInteraction=request.body?.interactionContext;
  const checkpoint=initialAgentCheckpoint(input.history,input.goal,{...(contextData&&typeof contextData==='object'?contextData:{}),interaction:{...(rawInteraction&&typeof rawInteraction==='object'?rawInteraction:{}),deviceId:request.body?.deviceId,modality:request.body?.interactionMode}});
  checkpoint.reasoning=decideReasoning({message:input.goal,requested:request.body?.reasoningEffort??dependencies.defaultReasoning?.()??'auto',history:input.history});
  const caller=authorizeComputerCaller(request.body?.computerCaller);
  if(caller&&caller.deviceId===checkpoint.interaction?.deviceId)checkpoint.interaction.computerSessionId=caller.sessionId;
  const previous=listAgentRuns(input.conversationId)[0];
  if(previous){const prior=getAgentRun(previous.id).checkpoint.interaction;if(prior?.recentTargets)(checkpoint.interaction??={}).recentTargets=prior.recentTargets;}
  if(!input.projectId)checkpoint.projectContext=automaticProjectContext(input.goal,checkpoint.interaction);
  if(input.sources)checkpoint.sources=input.sources;
  const {run,created}=createAgentRun({...input,inputId,model:modelName,checkpoint,executionMode:request.body?.background===true?'background':'foreground'});
  begin(response);write(response,{type:'agent-run',runId:run.id,conversationId:run.conversationId,status:run.status,created});
  const result=await executeOfficeAgent({runId:run.id,modelName,voicePresentation:voicePresentation(request),model:dependencies.model(modelName,request.body?.reasoningEffort,request.body?.maxTokens),signal,onEvent:event=>{write(response,{type:'run-event',runId:run.id,event});input.onProgress?.(event);},onText:delta=>write(response,{type:'delta',delta})});
  const final=result.run;
  const messageId=result.messageId??database.prepare("SELECT id FROM messages WHERE run_id=? AND role='assistant' ORDER BY rowid DESC LIMIT 1").get(final.id)?.id;
  write(response,{type:'done',...presentationFields(request,final),runId:final.id,runStatus:final.status,conversationId:final.conversationId,assistantMessageId:messageId??null,answer:final.answer,citations:final.checkpoint.sources.map(source=>({document:source.title,path:source.path,excerpt:source.excerpt,documentId:source.documentId,parentId:source.parentId,sourceRevision:source.sourceRevision,locator:source.locator,startOffset:source.startOffset,endOffset:source.endOffset})),mode:'openai',model:final.model});
  dependencies.onFinished?.(final);response.end();
  return final;
}
export function registerAgentRoutes(app:Express,dependencies:AgentRouteDependencies){
  app.post('/api/interaction/navigation/:id/ack',(request,response,next)=>{try{response.json(acknowledgeNavigation(request.params.id,request.body?.token,request.body?.shown));}catch(error){next(error);}});
  app.get('/api/agent/runs',(request,response,next)=>{try{const conversationId=typeof request.query.conversationId==='string'?request.query.conversationId:null;const runs=listAgentRuns(conversationId);for(const run of runs)recoverAgentRun(run.id);response.json(listAgentRuns(conversationId));}catch(error){next(error);}});
  app.get('/api/agent/runs/:id',(request,response,next)=>{try{const after=Number(request.query.after??0);if(!Number.isSafeInteger(after)||after<0)throw fail('进度序号无效。');response.json(agentRunView(request.params.id,after));}catch(error){next(error);}});
  app.post('/api/agent/runs',async(request,response)=>{
    try{
      if(!dependencies.canUseModel())throw fail('请先在模型连接中配置可用的对话模型。');
      const goal=String(request.body?.message??'').trim();if(!goal||goal.length>20000)throw fail('请输入不超过20000字的事务内容。');
      const projectId=typeof request.body?.projectId==='string'&&request.body.projectId?request.body.projectId:null;
      if(projectId&&!database.prepare('SELECT id FROM projects WHERE id=? AND deleted_at IS NULL').get(projectId))throw fail('项目不存在或已进入回收站。',404);
      const conversationId=typeof request.body?.conversationId==='string'&&request.body.conversationId?request.body.conversationId:randomUUID();
      const existing=database.prepare('SELECT project_id FROM conversations WHERE id=?').get(conversationId);
      if(existing&&(existing.project_id??null)!==projectId)throw fail('这段对话与项目范围不一致，请新建对话。');
      if(!existing)database.prepare('INSERT INTO conversations(id,scope_type,project_id,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(conversationId,projectId?'project':'memory',projectId,goal.slice(0,40),nowIso(),nowIso());
      const history=database.prepare('SELECT role,content FROM messages WHERE conversation_id=? ORDER BY rowid DESC LIMIT 12').all(conversationId).reverse() as Array<{role:string;content:string}>;
      await respondWithOfficeAgent(request,response,dependencies,{conversationId,projectId,goal,history});
    }catch(error){if(response.headersSent){write(response,{type:'error',message:error instanceof Error?error.message:'事务处理未完成。'});response.end();}else jsonError(response,error);}
  });
  app.post('/api/agent/runs/:id/continue',async(request,response)=>{
    try{
      if(!dependencies.canUseModel())throw fail('请先配置可用的对话模型。');
      const run=getAgentRun(request.params.id);assertCurrentDevice(run,request);begin(response);write(response,{type:'agent-run',runId:run.id,conversationId:run.conversationId,status:run.status});
      const result=await executeOfficeAgent({runId:run.id,voicePresentation:voicePresentation(request),modelName:run.model||dependencies.defaultModel(),model:dependencies.model(run.model||dependencies.defaultModel()),signal:dependencies.requestSignal(request,response),additionalInput:typeof request.body?.message==='string'?request.body.message:undefined,onEvent:event=>write(response,{type:'run-event',runId:run.id,event}),onText:delta=>write(response,{type:'delta',delta})});
      write(response,{type:'done',...presentationFields(request,result.run),runId:run.id,runStatus:result.run.status,conversationId:run.conversationId,assistantMessageId:result.messageId,answer:result.run.answer,citations:result.run.checkpoint.sources.map(source=>({document:source.title,path:source.path,excerpt:source.excerpt,documentId:source.documentId,parentId:source.parentId,sourceRevision:source.sourceRevision,locator:source.locator,startOffset:source.startOffset,endOffset:source.endOffset})),mode:'openai',model:result.run.model});dependencies.onFinished?.(result.run);response.end();
    }catch(error){if(response.headersSent){write(response,{type:'error',message:error instanceof Error?error.message:'继续处理未完成。'});response.end();}else jsonError(response,error);}
  });
  app.post('/api/agent/runs/:id/control',(request,response,next)=>{try{const action=request.body?.action;if(!['pause','cancel','background'].includes(action))throw fail('请选择暂停、取消或转到后台。');stopOfficeAgent(request.params.id,action);if(action==='cancel')dependencies.onFinished?.(getAgentRun(request.params.id));response.json(agentRunView(request.params.id));}catch(error){next(error);}});
  app.post('/api/agent/runs/:id/reconcile',(request,response,next)=>{
    try{
      const run=getAgentRun(request.params.id),id=String(request.body?.invocationId??''),outcome=request.body?.outcome,evidence=String(request.body?.evidence??'').trim();
      if(run.status!=='reconciling'||!['succeeded','not_applied'].includes(outcome)||evidence.length<3||evidence.length>1000)throw fail('请先核对目标服务，并填写实际核对依据（3–1000字）。');
      const call=listAgentInvocations(run.id).find(item=>item.id===id&&['unknown','dispatching'].includes(item.status));if(!call)throw fail('这项待核实操作不存在。',404);
      if(agentInvocationActive(call.id))throw fail('原操作仍在执行，请等待回执后再核对。',409);
      const result=request.body?.result??{verifiedBy:'user',evidence};if(JSON.stringify(result).length>60000)throw fail('核对回执过长。');
      atomicAgentWrite(()=>{
        const external=uncertainToolCall(call.toolName,call.arguments);
        if(external)reconcileToolCall({...external,outcome:outcome==='succeeded'?'executed':'not_executed',note:evidence,confirmed:true});
        updateAgentInvocation(id,outcome==='succeeded'?'succeeded':'prepared',outcome==='succeeded'?{result}:{error:'用户已核实未生效，后续可重新准备'});
        if(call.executionId)updateSkillExecution(call.executionId,'reconciled',result,`用户核实：${evidence}`);
        if(outcome==='not_applied')database.prepare('UPDATE agent_invocations SET proposal_id=NULL,result_json=NULL,late_result_json=NULL WHERE id=?').run(id);
        if(call.proposalId)database.prepare('UPDATE action_proposals SET status=?,result_json=?,error_message=?,updated_at=? WHERE id=?').run(outcome==='succeeded'?'succeeded':'failed',outcome==='succeeded'?JSON.stringify(result):null,`用户核实：${evidence}`,nowIso(),call.proposalId);
        if(!listAgentInvocations(run.id).some(item=>item.status==='unknown'||item.status==='dispatching'))database.prepare("UPDATE agent_runs SET status=CASE WHEN cancel_requested=1 THEN 'cancelled' ELSE 'suspended' END,lease_token=NULL,lease_expires_at=NULL,updated_at=? WHERE id=?").run(nowIso(),run.id);
        appendAgentEvent(run.id,'reconciled',outcome==='succeeded'?'用户已核实操作生效':'用户已核实操作未生效',{invocationId:id,evidence});
      });if(getAgentRun(run.id).status==='cancelled')dependencies.onFinished?.(getAgentRun(run.id));response.json(agentRunView(run.id));
    }catch(error){next(error);}
  });
  app.get('/api/agent/files/:id',(request,response,next)=>{
    try{const file=database.prepare('SELECT filename,mime_type,storage_path FROM generated_files WHERE id=?').get(request.params.id);if(!file)throw fail('生成的文件不存在。',404);const path=resolve(String(file.storage_path));if(!path.startsWith(generatedFilesRoot+sep))throw fail('文件位置无效。',403);response.type(String(file.mime_type));response.download(path,String(file.filename),error=>{if(error&&!response.headersSent)next(error);});}catch(error){next(error);}
  });
}

/** Continue the same voice transaction; confirmations never start a second task. */
export async function continueVoiceTransaction(request:Request,response:Response,dependencies:AgentRouteDependencies,input:{conversationId:string;message:string;deviceId?:string}):Promise<boolean>{
  const latest=listAgentRuns(input.conversationId)[0];if(!latest)return false;
  const run=getAgentRun(latest.id);if(Date.now()-Date.parse(run.updatedAt)>5*60_000)return false;
  const compact=input.message.replace(/[\s。！!，,？?]/g,'');
  const decision=/^(?:确认|确认执行|确认吧|可以|可以执行|同意|继续执行)$/.test(compact)?'confirm':/^(?:取消|取消操作|不要执行|别执行|不执行)$/.test(compact)?'cancel':null;
  if(run.status!=='waiting_input'&&!(run.status==='waiting_approval'&&decision))return false;
  if(run.checkpoint.interaction?.deviceId&&run.checkpoint.interaction.deviceId!==input.deviceId)throw fail('请在发起这项事务的设备上继续处理。',409);
  assertCurrentDevice(run,request);
  const stoppedReply=(answer:string)=>{
    const messageId=randomUUID(),at=nowIso();
    database.prepare("INSERT INTO messages(id,conversation_id,role,content,citations_json,created_at,run_id) VALUES(?,?,'assistant',?,'[]',?,?)").run(messageId,run.conversationId,answer,at,run.id);
    database.prepare('UPDATE agent_runs SET answer=?,updated_at=? WHERE id=?').run(answer,at,run.id);database.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(at,run.conversationId);
    begin(response);write(response,{type:'conversation-started',conversationId:run.conversationId});write(response,{type:'done',runId:run.id,runStatus:getAgentRun(run.id).status,conversationId:run.conversationId,assistantMessageId:messageId,answer,citations:[],mode:'openai',model:run.model});dependencies.onFinished?.(getAgentRun(run.id));response.end();return true;
  };
  if(run.status==='waiting_input'&&decision==='cancel'){
    database.prepare("INSERT INTO messages(id,conversation_id,role,content,citations_json,created_at,run_id) VALUES(?,?,'user',?,'[]',?,?)").run(randomUUID(),run.conversationId,input.message,nowIso(),run.id);stopOfficeAgent(run.id,'cancel');return stoppedReply('已取消这项事务，当前没有继续操作。');
  }
  if(run.status==='waiting_approval'){
    const waiting=listAgentInvocations(run.id).filter(call=>call.status==='waiting_approval');
    if(waiting.length!==1||!waiting[0].proposalId)throw fail('有多项待确认修改，请明确要确认哪一项。',409);
    database.prepare("INSERT INTO messages(id,conversation_id,role,content,citations_json,created_at,run_id) VALUES(?,?,'user',?,'[]',?,?)").run(randomUUID(),run.conversationId,input.message,nowIso(),run.id);
    try{if(decision==='confirm')await confirmAction(waiting[0].proposalId,{deviceId:input.deviceId,computerCaller:request.body?.computerCaller});else cancelAction(waiting[0].proposalId);}
    catch(error){if((error as {controlBlocked?:boolean})?.controlBlocked){stopOfficeAgent(run.id,'pause');return stoppedReply('主人正在使用电脑，或本机暂未允许操作。这项事务已暂停，没有继续发送后续动作。');}throw error;}
  }
  begin(response);write(response,{type:'conversation-started',conversationId:run.conversationId});write(response,{type:'agent-run',runId:run.id,conversationId:run.conversationId,status:run.status});
  const result=await executeOfficeAgent({runId:run.id,voicePresentation:voicePresentation(request),modelName:run.model||dependencies.defaultModel(),model:dependencies.model(run.model||dependencies.defaultModel()),signal:dependencies.requestSignal(request,response),additionalInput:run.status==='waiting_input'?input.message:undefined,onEvent:event=>write(response,{type:'run-event',runId:run.id,event}),onText:delta=>write(response,{type:'delta',delta})});
  write(response,{type:'done',...presentationFields(request,result.run),runId:run.id,runStatus:result.run.status,conversationId:run.conversationId,assistantMessageId:result.messageId,answer:result.run.answer,citations:result.run.checkpoint.sources.map(source=>({document:source.title,path:source.path,excerpt:source.excerpt,documentId:source.documentId,parentId:source.parentId,sourceRevision:source.sourceRevision,locator:source.locator,startOffset:source.startOffset,endOffset:source.endOffset})),mode:'openai',model:result.run.model});dependencies.onFinished?.(result.run);response.end();return true;
}

import { isUnknownToolOutcome } from '../domain/skills/tool-outcome.js';
import { database, nowIso } from '../db.js';
import { cancelProposal, completeProposal } from './proposal-service.js';
import { undoActionProposal } from './undo-service.js';
import { createTask, createTaskBatch, validateTaskDrafts } from '../domain/tasks/task-service.js';
import { actionProposalRepository } from '../storage/repositories/action-proposal-repository.js';
import { executeSkillTool } from '../domain/skills/skill-tool-registry.js';
import { findSkillExecutionByProposal, updateSkillExecution } from '../domain/skills/skill-execution-audit.js';
import { createConversationTasks } from '../domain/tasks/conversation-task-tool.js';
import { controlledTool } from '../domain/skills/tool-controls.js';
import { getSkillTool } from '../domain/skills/skill-tool-registry.js';
import { capabilityFingerprint } from '../domain/agent/catalog.js';
import { appendAgentEvent,atomicAgentWrite,setAgentInvocationActive,updateAgentInvocation } from '../domain/agent/run-store.js';
import {authorizeComputerCaller} from '../domain/interaction/computer-bridge.js';

export function listActions(conversationId?: string | null) {
  const rows = actionProposalRepository.list(conversationId);
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: row.id, conversationId: row.conversation_id, actionType: row.action_type, targetType: row.target_type,
    targetId: row.target_id, targetPath: row.target_path, payload: JSON.parse(String(row.payload_json)), reason: row.reason,
    sourceRefs: JSON.parse(String(row.source_refs_json)), riskLevel: row.risk_level, requiresConfirmation: Boolean(row.requires_confirmation),
    status: row.status, result: row.result_json ? JSON.parse(String(row.result_json)) : null, errorMessage: row.error_message,
    createdAt: row.created_at, confirmedAt: row.confirmed_at, executedAt: row.executed_at, revertedAt: row.reverted_at, updatedAt: row.updated_at
  }));
}

export function cancelAction(id: string) {
  const proposal = actionProposalRepository.find(id);
  if (!proposal) throw Object.assign(new Error('行动提案不存在。'), { statusCode: 404 });
  if (!['pending', 'edited'].includes(proposal.status)) throw Object.assign(new Error('这条行动提案已经执行或关闭。'), { statusCode: 409 });
  cancelProposal(id);
  database.prepare(`UPDATE message_suggestions SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'`).run(nowIso(), id);
  database.prepare(`UPDATE obsidian_write_requests SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'pending'`).run(nowIso(), id);
  const skillExecution = findSkillExecutionByProposal(id);
  if (skillExecution) updateSkillExecution(String(skillExecution.id), 'cancelled');
  return { ok: true, status: 'cancelled' };
}

export function confirmAction(id: string,callerContext:{deviceId?:string;computerCaller?:unknown}={}) {
  const proposal = actionProposalRepository.find(id);
  if (!proposal) throw Object.assign(new Error('行动提案不存在。'), { statusCode: 404 });
  if (proposal.status === 'succeeded') return proposal.result_json ? JSON.parse(String(proposal.result_json)) : { ok: true };
  if (!['pending', 'edited'].includes(String(proposal.status))) throw Object.assign(new Error('这条行动提案已经执行或关闭。'), { statusCode: 409 });
  if (proposal.action_type === 'skill_tool') {
    const payload = JSON.parse(String(proposal.payload_json)) as { skillId?:string;skillVersion?:string;toolName?: string; arguments?: Record<string, unknown>; conversationDrafts?: Parameters<typeof createConversationTasks>[0]; sourceId?:string; agentRunId?:string;invocationId?:string;capabilityFingerprint?:string;agentSkills?:Array<{id:string;version:string}>;context?: { projectId?: string | null; vaultPath?: string; runId?:string;deviceId?:string } };
    if(payload.agentRunId){
      if(payload.toolName?.startsWith('computer_')){
        const caller=authorizeComputerCaller(callerContext.computerCaller);
        const stored=database.prepare('SELECT checkpoint_json FROM agent_runs WHERE id=?').get(payload.agentRunId);
        const interaction=stored?JSON.parse(String(stored.checkpoint_json)).interaction:null;
        if(!caller||caller.deviceId!==payload.context?.deviceId||callerContext.deviceId!==caller.deviceId||caller.sessionId!==interaction?.computerSessionId)throw Object.assign(new Error('请在发起事务且仍获授权的本机确认电脑操作。'),{statusCode:409});
      }
      const run=database.prepare('SELECT status,cancel_requested FROM agent_runs WHERE id=?').get(payload.agentRunId);
      const capability=payload.toolName?getSkillTool(payload.toolName):null;
      if(!run||run.cancel_requested||!['running','waiting_approval'].includes(String(run.status)))throw Object.assign(new Error('这项事务已暂停、取消或等待核实，当前修改未执行。'),{statusCode:409});
      if(!capability||capabilityFingerprint(capability)!==payload.capabilityFingerprint)throw Object.assign(new Error('能力配置已变化，请重新准备这项修改。'),{statusCode:409});
      for(const selected of payload.agentSkills??[]){const skill=database.prepare('SELECT enabled,status,version FROM managed_skills WHERE id=?').get(selected.id);if(!skill?.enabled||skill.status!=='installed'||skill.version!==selected.version)throw Object.assign(new Error('相关技能已停用或更新，旧修改未执行。'),{statusCode:409});}
    }
    if(payload.skillId){
      const skill=database.prepare('SELECT enabled,status,version FROM managed_skills WHERE id=?').get(payload.skillId);
      if(!skill?.enabled||skill.status!=='installed'||(payload.skillVersion&&String(skill.version)!==payload.skillVersion))throw Object.assign(new Error('技能已停用、移除或更新，请重新生成操作。'),{statusCode:409});
    }
    const execution = findSkillExecutionByProposal(id);
    if (!payload.toolName || !execution) throw Object.assign(new Error('技能工具提案不完整，无法执行。'), { statusCode: 409 });
    atomicAgentWrite(()=>{const claimed=database.prepare("UPDATE action_proposals SET status='executing' WHERE id=? AND status IN ('pending','edited')").run(id);
    if(!claimed.changes)throw Object.assign(new Error('操作已开始，请勿重复执行。'),{statusCode:409});
    updateSkillExecution(String(execution.id), 'running');
    if(payload.invocationId){updateAgentInvocation(payload.invocationId,'dispatching',{incrementAttempt:true});setAgentInvocationActive(payload.invocationId,true);}});
    const succeeded=(result:unknown)=>{atomicAgentWrite(()=>{
      completeProposal(String(proposal.id),result);updateSkillExecution(String(execution.id),'succeeded',result);
      if(payload.agentRunId&&payload.invocationId){
        const run=database.prepare('SELECT status,cancel_requested FROM agent_runs WHERE id=?').get(payload.agentRunId);
        const stopped=!run||run.cancel_requested||!['running','waiting_approval'].includes(String(run.status));
        updateAgentInvocation(payload.invocationId,stopped?'unknown':'succeeded',{result});
        if(stopped){database.prepare("UPDATE agent_invocations SET late_result_json=? WHERE id=?").run(JSON.stringify(result??null),payload.invocationId);database.prepare("UPDATE agent_runs SET status='reconciling',updated_at=? WHERE id=?").run(nowIso(),payload.agentRunId);appendAgentEvent(payload.agentRunId,'late_receipt','原操作已返回，请核对结果后继续',{invocationId:payload.invocationId});}
      }
    });if(payload.invocationId)setAgentInvocationActive(payload.invocationId,false);return result;};
    const failed=(error:unknown)=>{const code=Number((error as {statusCode?:number})?.statusCode);const unknown=isUnknownToolOutcome(error)||Boolean(payload.agentRunId&&(!code||code>=500));const detail=error instanceof Error?error.message:'工具执行失败';atomicAgentWrite(()=>{database.prepare("UPDATE action_proposals SET status=? WHERE id=?").run(unknown?'unknown':'failed',id);updateSkillExecution(String(execution.id),unknown?'unknown':'failed',undefined,detail);if(payload.invocationId)updateAgentInvocation(payload.invocationId,unknown?'unknown':'failed',{error:detail});if(unknown&&payload.agentRunId){database.prepare("UPDATE agent_runs SET status='reconciling',updated_at=? WHERE id=?").run(nowIso(),payload.agentRunId);appendAgentEvent(payload.agentRunId,'tool_unknown','已发送的修改需要核实',{invocationId:payload.invocationId});}else if((error as {controlBlocked?:boolean})?.controlBlocked&&payload.agentRunId){database.prepare("UPDATE agent_runs SET status='suspended',updated_at=? WHERE id=?").run(nowIso(),payload.agentRunId);appendAgentEvent(payload.agentRunId,'paused','本机控制暂不可用，事务已暂停');}});throw error;};
    try {
      const result = payload.toolName==='create_task'&&payload.conversationDrafts ? controlledTool('create_task',()=>createConversationTasks(payload.conversationDrafts!,payload.sourceId??id),true) : executeSkillTool(payload.toolName, payload.arguments ?? {}, { projectId: payload.context?.projectId ?? null, vaultPath: payload.context?.vaultPath || 'central://documents',runId:payload.context?.runId,deviceId:payload.context?.deviceId,confirmed:true });
      if(result&&typeof (result as Promise<unknown>).then==='function')return Promise.resolve(result).then(succeeded,failed).finally(()=>{if(payload.invocationId)setAgentInvocationActive(payload.invocationId,false);});
      return succeeded(result);
    } catch (error) {
      try{return failed(error);}finally{if(payload.invocationId)setAgentInvocationActive(payload.invocationId,false);}
    }
  }
  if (proposal.action_type === 'task_create') {
    const payload = JSON.parse(String(proposal.payload_json)) as { projectId?: string; title?: string; description?: string; status?: string; priority?: string; executor?: string; dueAt?: string | null; sourceLabel?: string };
    if (!payload.projectId) throw Object.assign(new Error('任务提案缺少所属项目。'), { statusCode: 409 });
    const result = createTask(payload.projectId, { ...payload, suggestionId: String(proposal.id) });
    return { created: [result.task], skipped: [], projectId: payload.projectId };
  }
  if (proposal.action_type !== 'task_batch_create') throw Object.assign(new Error('这类行动需要在原来的确认入口执行。'), { statusCode: 400 });
  const payload = JSON.parse(String(proposal.payload_json)) as { projectId: string; tasks: unknown; sourceSuggestionId?: string | null };
  const result = createTaskBatch(payload.projectId, validateTaskDrafts(payload.tasks), String(proposal.id));
  if (typeof payload.sourceSuggestionId === 'string') database.prepare(`UPDATE message_suggestions SET status = 'applied', updated_at = ? WHERE id = ? AND status = 'pending'`).run(nowIso(), payload.sourceSuggestionId);
  completeProposal(String(proposal.id), result);
  return result;
}

export { undoActionProposal };

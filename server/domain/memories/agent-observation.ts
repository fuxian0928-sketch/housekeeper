import {listAgentArtifacts,listAgentInvocations} from '../agent/run-store.js';
import type {AgentRun} from '../agent/types.js';
import {safeMemoryText} from './work-memory.js';

/** A model answer is a statement, not proof that its requested side effect happened. */
export function agentLearningObservation(run:AgentRun){
  const receipts=listAgentInvocations(run.id).slice(-12).map(call=>{
    const raw=call.result&&typeof call.result==='object'?call.result as Record<string,unknown>:{};
    const references=Object.fromEntries(['id','projectId','taskId','documentId','fileId','verified','revision'].filter(key=>['string','number','boolean'].includes(typeof raw[key])).map(key=>[key,typeof raw[key]==='string'?safeMemoryText(raw[key],160):raw[key]]));
    return{invocationId:call.id,tool:call.toolName,status:call.status,references};
  });
  const artifacts=listAgentArtifacts(run.id).slice(-6).map(item=>({id:item.id,title:safeMemoryText(item.title,160),documentId:item.documentId,fileId:item.fileId}));
  return{
    sourceLabel:'希微事务记录',
    content:`用户交代的目标（请求，不代表已完成）：${safeMemoryText(run.goal,4000)}\n持久化事务状态：${run.status}\n工具执行账本（只代表对应调用状态，外部工具返回仍需业务核对）：${JSON.stringify(receipts)}\n已登记成果引用：${JSON.stringify(artifacts)}\n助手当时的回答（说法，不是独立事实证据）：${safeMemoryText(run.answer,1800)}\n提取时保留来源和时间；以用户明确陈述和实际回执为依据，不能把助手建议变成事实。`,
    metadata:{conversationId:run.conversationId,runId:run.id,status:run.status,evidencePolicy:'separate-user-request-ledger-and-assistant-statement'}
  };
}

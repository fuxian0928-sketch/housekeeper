import { defaultChatDecision, parseSemanticDecision, recognizeIntent, SEMANTIC_INTENT_INSTRUCTION, type SemanticDecision, type SemanticIntentInput } from './semantic-intent.js';

export type TurnRoutingMode = 'auto' | 'work' | 'life';
export function parseTurnRoutingMode(value:unknown):TurnRoutingMode {
  if(value===undefined)return 'auto';
  if(value==='auto'||value==='work'||value==='life')return value;
  throw Object.assign(new Error('请选择自动识别、工作或生活。'),{statusCode:400});
}

// Reuse the action contract, not the first-level domain classifier.
export const WORK_REQUEST_INSTRUCTION = `用户已经为本轮选择工作模式。禁止重新判断工作或生活，domain 必须是 work。你只负责解析工作动作、对象、必填信息和执行计划。没有具体操作时使用 answer_question 回应；不能因选择工作模式就推导出写入授权。\n`+
  SEMANTIC_INTENT_INSTRUCTION.split('\n').filter(line=>!line.startsWith('你负责理解用户意图')&&!line.startsWith('不要按孤立关键词')&&!line.startsWith('生活聊天是默认入口')&&!line.startsWith('聊天动作可选')).join('\n').replaceAll('"work|chat"','"work"').replaceAll('可以保持chat域','本轮保持work域');

export async function resolveTurnDecision(input:SemanticIntentInput, mode:TurnRoutingMode, complete:(input:string,instruction:string)=>Promise<string>):Promise<SemanticDecision>{
  input.signal?.throwIfAborted();
  if(mode==='auto')return recognizeIntent(input,complete);
  if(mode==='life'){
    const decision=defaultChatDecision(input);
    decision.route.intents[0].confidence=1;
    decision.responseGoal='用户已明确选择本轮生活模式。直接结合当前消息、对话历史和共同记忆进行自然交流，不重新分类。不执行工作操作、不声称已创建任务或修改项目；可以自然讨论想法和生活中的问题。';
    return decision;
  }
  const context={...input,signal:undefined,history:input.history.slice(-12),routingMode:'work'};
  let invalidOutput='';
  for(let attempt=0;attempt<2;attempt++){
    try{
      const raw=await complete(JSON.stringify({...context,...(attempt?{invalidOutput,correction:'请修正工作执行计划的字段与动作；本轮工作模式已确定，不要进行领域分类。'}:{})}),WORK_REQUEST_INSTRUCTION);
      input.signal?.throwIfAborted();invalidOutput=raw;
      const decision=parseSemanticDecision(raw,input);
      if(decision.route.domain!=='work')throw new Error('工作流程不能改变本轮模式');
      return decision;
    }catch{input.signal?.throwIfAborted();}
  }
  // Keep manual work mode even if the action planner is unavailable; never invent writes.
  const decision=defaultChatDecision(input);
  decision.route={...decision.route,domain:'work',scope:{projectId:input.projectId,documentPaths:input.documentPaths,timeRange:null},intents:[{action:'answer_question',category:'knowledge_analysis',mode:'read',object:'project',output:'answer',confidence:0,risk:'none'}],executionOrder:['answer_question']};
  decision.responseGoal='本轮明确为工作模式，但工作动作解析未成功。继续回应用户，依据已有信息给出帮助；不得声称任务或文档已经创建。写入需要可靠的执行结果，不能只用语言模拟成功。';
  return decision;
}

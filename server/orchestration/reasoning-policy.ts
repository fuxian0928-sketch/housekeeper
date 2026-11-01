import type { ReasoningEffort } from '../providers/llm-provider.js';

export type ReasoningDecision = {
  requested: ReasoningEffort;
  effort: Exclude<ReasoningEffort, 'auto'>;
  source: 'utterance' | 'selection' | 'automatic' | 'context';
  label: string;
};
export function validReasoningEffort(value: unknown): value is ReasoningEffort {
  return typeof value === 'string' && ['auto', 'low', 'medium', 'high'].includes(value);
}

// Only the current user's unquoted instruction can change this task's depth.
// Do not inspect retrieved files, skill instructions or assistant messages here.
function instructionText(text: string) {
  return text.slice(0, 20000).replace(/```[\s\S]*?(?:```|$)/g, ' ')
    .replace(/^[ \t]*>.*$/gm, ' ').replace(/[“「『][\s\S]*?[”」』]/g, ' ')
    .replace(/"[^"\n]*"|'[^'\n]*'/g, ' ');
}
export function utteranceReasoning(text: string): 'low' | 'high' | null {
  const current = instructionText(text);
  const instructions: Array<{ index: number; effort: 'low' | 'high' }> = [];
  const fast = /(?:不用|不需要|不要|别|无需|不必)\s*(?:再|太|过于)?\s*(?:深入|深度|认真|仔细)?\s*(?:思考|分析|想(?:了|太多)?)|(?:简单|简短|快速|直接)\s*(?:地)?\s*(?:说(?:一下)?|回答|给(?:我)?(?:个)?结论|告诉我(?:结果|答案))|别展开|先给结论|\b(?:answer briefly|quick answer|no deep thinking)\b/gi;
  const deep = /(?:深入|深度|认真|仔细|充分|全面|详细)\s*(?:地)?\s*(?:思考|分析|想(?:一下|一想|想)?|推敲)|想清楚(?:再|后)|多想一会|\b(?:think deeply|think carefully|deep analysis)\b/gi;
  for (const match of current.matchAll(fast)) instructions.push({index:match.index,effort:'low'});
  for (const match of current.matchAll(deep)) {
    // A deep phrase contained inside "不要深入思考" is a negation, not an override.
    const prefix=current.slice(Math.max(0,match.index-10),match.index);
    if (/(?:不用|不需要|不要|别|无需|不必)\s*(?:再|太|过于)?\s*$/.test(prefix)) continue;
    instructions.push({index:match.index,effort:'high'});
  }
  return instructions.sort((a,b)=>a.index-b.index).at(-1)?.effort ?? null;
}

function automaticEffort(text: string): 'low' | 'medium' | 'high' {
  const current=instructionText(text);
  const comparison=/(?:比较|对比|评估|权衡|优先级|取舍|利弊|compare|trade.?off)/i.test(current);
  const analysis=/(?:方案|风险|收益|成本|架构|策略|决策|根因|可行性|迁移|规划|调研|设计|排查|诊断|推荐|投资|合同|安全|strategy|architecture)/i.test(current);
  const multiStep=(current.match(/然后|再(?:把|将|去|根据)|并(?:且|生成|修改|保存|核对)|首先|其次|最后|\d[、．.]/g)??[]).length;
  if ((comparison&&analysis) || /(?:完整|全面|系统性|多角度|详细).{0,10}(?:分析|方案|规划|设计|评估|排查)|(?:分析|排查).{0,10}(?:根因|原因)|(?:制定|设计).{0,12}(?:迁移|架构|策略|实施方案)/.test(current) || (analysis&&multiStep>=2)) return 'high';
  if (analysis || /撰写|生成|修改|整理|汇总|总结|解释|周报|报告|文档|表格|原型|write|summari[sz]e/i.test(current) || multiStep>=2) return 'medium';
  return 'low';
}

/** No extra model/router call on the voice critical path. This is task-local. */
export function decideReasoning(input: { message: string; requested?: ReasoningEffort; history?: Array<{role:string;content:string}> }): ReasoningDecision {
  const requested=input.requested??'auto';
  const spoken=utteranceReasoning(input.message);
  let effort: ReasoningDecision['effort'], source: ReasoningDecision['source'];
  if(spoken){effort=spoken;source='utterance';}
  else if(requested!=='auto'){effort=requested;source='selection';}
  else {
    effort=automaticEffort(input.message);source='automatic';
    // Resolve short follow-ups from the last actual user task, without carrying
    // its "think deeply" command into a new unrelated question.
    if(effort==='low'&&/^(?:继续|接着|按刚才|上面|刚才|那(?:个|份|件|几个)|这个方案)/.test(input.message.trim())){
      const prior=input.history?.filter(item=>item.role==='user').at(-1);
      if(prior){effort=automaticEffort(prior.content);if(effort!=='low')source='context';}
    }
  }
  return {requested,effort,source,label:effort==='high'?'深入思考':effort==='medium'?'标准思考':'快速回答'};
}

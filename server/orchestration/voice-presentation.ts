export const VOICE_PRESENTATION_VERSION='dual-v1';
export const VOICE_PRESENTATION_INSTRUCTION=`本轮同时需要完整阅读稿和独立口播稿，在同一次回答中完成，不额外调用模型。
需要调用工具时正常调用工具，不输出最终稿。只在完成最终回答时返回一个JSON对象，且仅有answer和narration两个字符串字段，不使用代码围栏。
answer是页面展示和聊天历史保存的完整原文，保留所需的Markdown、标题、列表和来源，不因口播而删减。长文成果和原文文件仍按实际工具结果展示。
narration是专供TTS朗读的口语稿：先根据本轮问题和中文语境理解完整内容，再用完整语义短句表达，句号、逗号和换行表示自然停顿。不要按固定字数硬拆，不拆开否定、专有名词、日期、数值与单位；不输出星号、井号、括号、代码、表格、网址、SSML或停顿指令。
口播先给结论，再自然衔接必要要点，不逐条背书。日常交流通常20至80字；资料总结通常80至180字，复杂内容最多300字，保留结论、重要限制和必要的下一步，不把整篇原文重新念一遍。不要把一句“我现在安静”扩写成反复道歉。关键数字和事实不能改写或新增，不确定和未完成状态不能变成已确认或已完成。主人明确要求全文朗读时才保留全文，超出1800字符则说明需分段朗读，不能伪装已经读完。
示例：{"answer":"## 当前进展\\n资料已整理，预算为30万元（待核实）。","narration":"资料已经整理好了。预算是30万元，这个数还需要核实。"}`;

export function readVoicePresentation(content:string):{answer:string;narration?:string} {
  const raw=content.trim().replace(/^```(?:json)?\s*/i,'').replace(/\s*```$/,'');
  // Some providers prepend prose to the envelope despite the output contract.
  // Normalize before streaming or persistence, rather than hiding JSON in the UI.
  const candidates=[...raw.matchAll(/\{\s*"(?:answer|narration)"\s*:/g)];
  if(!candidates.length)return {answer:content};
  let value:unknown,prefix='';
  for(const candidate of candidates){
    try{
      const parsed:unknown=JSON.parse(raw.slice(candidate.index));
      if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed)&&'answer' in parsed){
        value=parsed;prefix=raw.slice(0,candidate.index).trim().replace(/```(?:json)?\s*$/i,'').trim();break;
      }
    }catch{/* A later candidate may be the complete trailing envelope. */}
  }
  if(!value)throw Error('语音阅读稿格式未完成，请重试本轮回答。');
  const item=value as {answer?:unknown;narration?:unknown};
  if(typeof item?.answer!=='string'||!item.answer.trim()||item.answer.length>30000)throw Error('语音阅读稿无效，请重试本轮回答。');
  const original=item.answer.trim();
  const answer=!prefix||original.includes(prefix)?item.answer:prefix.includes(original)?prefix:`${prefix}\n\n${item.answer}`;
  if(answer.length>30000)throw Error('语音阅读稿无效，请重试本轮回答。');
  if(typeof item.narration!=='string'||!item.narration.trim()||item.narration.length>1800)return {answer};
  // A new numeric claim in narration is not a faithful projection. Fall back to
  // the original instead of speaking it or silently changing the written answer.
  const numeric=(text:string)=>(text.match(/\d+(?:[.,]\d+)*/g)??[]).map(n=>n.replace(/,/g,''));
  const numbers=numeric(item.narration),originalNumbers=new Set(numeric(answer));
  if(numbers.some(number=>!originalNumbers.has(number)))return {answer};
  return {answer,narration:item.narration};
}

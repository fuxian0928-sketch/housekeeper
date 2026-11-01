import { createHash } from 'node:crypto';
export type PlaybackContext = { conversationId: string; assistantMessageId: string; answerHash: string; state: string; answerSubmittedSamples: number; attribution: string };
export const answerDigest = (text: string) => createHash('sha256').update(text).digest('hex');

/** Amend model context only; stored text and business-operation state are untouched. */
export function withVoicePlaybackContext(history: Array<{id?:string;role:string;content:string}>, conversationId: string, input: unknown) {
  const result=history.map(item=>({...item}));
  const last=result.findLast(item=>item.role==='assistant'); if(!last)return result;
  const p=input as Partial<PlaybackContext>|null;
  const unique=typeof last.id==='string' && !!last.id && history.filter(item=>item.id===last.id).length===1;
  const matches=unique && p && p.conversationId===conversationId && p.assistantMessageId===last.id && p.answerHash===answerDigest(last.content)
    && Number.isSafeInteger(p.answerSubmittedSamples) && p.answerSubmittedSamples!>=0 && p.answerSubmittedSamples!<=480000
    && ['pending','partial','submitted','interrupted','device-error','device-closed'].includes(p.state!)
    && ['known','unknown'].includes(p.attribution!);
  let note='上一条回答的语音播放状态未确认，不能假定主人已经听到其中内容。';
  if(matches && p.attribution==='known'){
    if(p.answerSubmittedSamples===0)note='上一条正式回答没有确认提交的音频，进度提示不算正式回答。';
    else if(p.state==='submitted')note='上一条回答的音频已完整提交设备，但未验证音箱出声或主人实际听到。';
    else note='上一条回答只有部分音频确认提交设备，没有文字时间对齐，不能确定主人听到了哪些句子。';
  }
  last.content += `\n\n[语音播放说明：${note}完整文本仅供参考。任务和文档是否已经修改以业务记录为准，不要因为未播报而重复执行操作。]`;
  return result;
}
